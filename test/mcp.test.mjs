import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createWingMcpServer, parseMcpArgs, MAX_RESPONSE_BYTES } from '../src/mcp.mjs';
import { parseCliArgs, runCli } from '../skills/wing-session-analyzer/scripts/wing-session.mjs';

const execute = promisify(execFile);
const repo = fileURLToPath(new URL('../', import.meta.url));
const strip = (name, number = 1) => ({ name, col: 1, clink: false, mute: true, fdr: -144, in: { conn: { grp: 'LCL', in: number } }, flt: { lc: true, lcf: 100 }, eq: { on: false, mdl: 'STD', '1g': 0, '1f': 250, '1q': 1 }, main: { '1': { on: true, lvl: 0, pre: false } } });
const snap = (name = 'Mic One') => ({ type: 'snapshot.11', creator_name: 'Synthetic test, not a factory file', creator_version: 'fixture', ae_data: { ch: { '1': strip(name), '2': strip('Mic Two', 2) }, aux: {}, bus: {}, main: { '1': { name: 'Main', mute: true, fdr: -144 } }, mtx: {}, io: { in: { LCL: { '1': { mode: 'M', g: 0, vph: false } } }, out: { LCL: { '7': { grp: 'MAIN', in: 1 } } } } }, ce_data: {}, ae_globals: {}, ce_globals: {} });
const show = { type: 'showfile.1', scenes: { count: 3, '1': { name: 'Present', type: 'snap', file: 'a.snap' }, '2': { name: 'Missing', type: 'snap', file: 'missing.snap' }, '3': { name: 'Do not follow', type: 'snap', file: '../outside/secret.snap' } } };

async function fixture(t) {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wing-mcp-test-')));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'allowed');
  const nested = path.join(root, 'nested');
  const outside = path.join(tmp, 'outside');
  await Promise.all([fs.mkdir(nested, { recursive: true }), fs.mkdir(outside)]);
  const a = path.join(root, 'a.snap');
  const b = path.join(nested, 'b.snap');
  const secret = path.join(outside, 'secret.snap');
  const doc = snap();
  const other = snap('Changed');
  other.creator_name = 'Different metadata';
  await Promise.all([
    fs.writeFile(a, JSON.stringify(doc)), fs.writeFile(b, JSON.stringify(other)),
    fs.writeFile(secret, JSON.stringify(snap('Outside'))), fs.writeFile(path.join(root, 'show.show'), JSON.stringify(show)),
    fs.writeFile(path.join(root, 'invalid.snap'), '{invalid'),
  ]);
  await fs.symlink(secret, path.join(root, 'escape.snap'));
  await fs.symlink(outside, path.join(root, 'escape-dir'));
  return { tmp, root, nested, outside, a, b, secret, doc };
}
function decoded(response) {
  assert.equal(response.content[0].type, 'text');
  const body = JSON.parse(response.content[0].text);
  assert.deepEqual(response.structuredContent, body);
  return body;
}
async function memoryClient(t, options) {
  const server = await createWingMcpServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'wing-integration-test', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

test('official SDK initializes and exposes fourteen explicit read-only tools with bounded schemas', async t => {
  const f = await fixture(t);
  const client = await memoryClient(t, { roots: [f.root] });
  assert.equal(client.getServerVersion().name, 'wing-session-analyzer');
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['wing_inspect', 'wing_channels', 'wing_channel', 'wing_search', 'wing_get_parameter', 'wing_routes', 'wing_diff', 'wing_findings', 'wing_scenes', 'wing_check_assets', 'wing_report', 'wing_compare', 'wing_batch', 'wing_index'].sort());
  for (const tool of tools) {
    assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
    const required = ['wing_diff', 'wing_compare'].includes(tool.name) ? 'before'
      : ['wing_batch', 'wing_index'].includes(tool.name) ? 'paths' : 'path';
    assert.ok(tool.inputSchema.required.includes(required));
    if (tool.inputSchema.properties.limit) assert.equal(tool.inputSchema.properties.limit.maximum, tool.name === 'wing_batch' ? 20 : 200);
  }
});

test('real service returns source hashes and original pointers through official Client calls', async t => {
  const f = await fixture(t);
  const client = await memoryClient(t, { roots: [f.root] });
  const response = await client.callTool({ name: 'wing_get_parameter', arguments: { path: f.a, pointer: '/ae_data/ch/1/name' } });
  const body = decoded(response);
  assert.equal(body.ok, true);
  assert.equal(body.result.exists, true);
  assert.equal(body.result.value, 'Mic One');
  assert.equal(body.result.sourcePointer, '/ae_data/ch/1/name');
  assert.equal(body.result.evidence.path, await fs.realpath(f.a));
  assert.equal(body.result.evidence.sha256, createHash('sha256').update(await fs.readFile(f.a)).digest('hex'));
  assert.match(body.dataPolicy, /untrusted session data/);
  const missing = decoded(await client.callTool({ name: 'wing_get_parameter', arguments: { path: f.a, pointer: '/does-not-exist' } }));
  assert.equal(missing.result.exists, false);
  const channels = decoded(await client.callTool({ name: 'wing_channels', arguments: { path: f.a, kind: 'ch', offset: 1, limit: 1 } }));
  assert.equal(channels.result.items.length, 1);
  assert.equal(channels.result.total, 2);
  assert.equal(channels.result.offset, 1);
  const one = decoded(await client.callTool({ name: 'wing_channel', arguments: { path: f.a, kind: 'ch', number: 1 } }));
  assert.equal(one.result.exists, true);
});

test('schema, unknown tool, parsing and root errors stay predictable JSON without ending the connection', async t => {
  const f = await fixture(t);
  const client = await memoryClient(t, { roots: [f.root] });
  for (const args of [{}, { path: f.a, limit: 201 }, { path: f.a, limit: 0 }, { path: f.a, kind: 'invented' }, { path: f.a, unexpected: true }, { path: './relative.snap' }]) {
    const result = await client.callTool({ name: 'wing_channels', arguments: args });
    assert.equal(result.isError, true);
    assert.equal(decoded(result).error.code, 'INVALID_ARGUMENTS');
  }
  const unknown = await client.callTool({ name: 'wing_do_not_execute', arguments: {} });
  assert.equal(unknown.isError, true);
  assert.equal(decoded(unknown).error.code, 'UNKNOWN_TOOL');
  const invalid = await client.callTool({ name: 'wing_inspect', arguments: { path: path.join(f.root, 'invalid.snap') } });
  assert.equal(invalid.isError, true);
  assert.equal(typeof decoded(invalid).error.code, 'string');
  const valid = decoded(await client.callTool({ name: 'wing_inspect', arguments: { path: f.a } }));
  assert.equal(valid.ok, true);
});

test('nested authorized roots work and lexical traversal, symlink file and symlink directory escapes fail closed', async t => {
  const f = await fixture(t);
  const client = await memoryClient(t, { roots: [f.root, f.nested] });
  assert.equal(decoded(await client.callTool({ name: 'wing_inspect', arguments: { path: f.b } })).ok, true);
  for (const candidate of [f.secret, path.join(f.root, '../outside/secret.snap'), path.join(f.root, 'escape.snap'), path.join(f.root, 'escape-dir/secret.snap')]) {
    const response = await client.callTool({ name: 'wing_inspect', arguments: { path: candidate } });
    assert.equal(response.isError, true);
    assert.equal(decoded(response).error.code, 'OUTSIDE_ROOT');
  }
});

test('configured root aliases resolve to the same authorized directory without authorizing escaped symlinks', async t => {
  const f = await fixture(t);
  const alias = path.join(f.tmp, 'allowed-alias');
  await fs.symlink(f.root, alias);
  const client = await memoryClient(t, { roots: [alias] });
  const response = decoded(await client.callTool({ name: 'wing_inspect', arguments: { path: path.join(alias, 'a.snap') } }));
  assert.equal(response.ok, true);
  assert.equal(response.result.evidence.path, f.a);
  const escaped = await client.callTool({ name: 'wing_inspect', arguments: { path: path.join(alias, 'escape.snap') } });
  assert.equal(escaped.isError, true);
  assert.equal(decoded(escaped).error.code, 'OUTSIDE_ROOT');
});

test('diff, search, routes, findings, scenes and local asset checks cross the real service boundary', async t => {
  const f = await fixture(t);
  const client = await memoryClient(t, { roots: [f.root] });
  for (const [name, args] of [
    ['wing_diff', { before: f.a, after: f.b, limit: 1 }],
    ['wing_search', { path: f.a, query: 'Mic', limit: 1 }],
    ['wing_routes', { path: f.a, kind: 'ch', number: 1 }],
    ['wing_findings', { path: f.a, limit: 1 }],
    ['wing_scenes', { path: path.join(f.root, 'show.show'), limit: 2 }],
    ['wing_check_assets', { path: path.join(f.root, 'show.show'), limit: 3 }],
  ]) {
    const response = await client.callTool({ name, arguments: args });
    const body = decoded(response);
    assert.equal(body.ok, true, `${name}: ${JSON.stringify(body.error)}`);
    assert.ok(body.result.evidence);
    if (body.result.items) assert.ok(body.result.items.length <= (args.limit || 50));
  }
  const assets = decoded(await client.callTool({ name: 'wing_check_assets', arguments: { path: path.join(f.root, 'show.show') } }));
  assert.ok(assets.result.items.some(item => item.status === 'present'));
  assert.ok(assets.result.items.some(item => item.status === 'outside_asset_root'));
});

test('routes exposes effective maxDepth and rejects ignored paging/prefix flags or DCA starts', async t => {
  const f = await fixture(t);
  const client = await memoryClient(t, { roots: [f.root] });
  const { tools } = await client.listTools();
  const schema = tools.find(tool => tool.name === 'wing_routes').inputSchema;
  assert.deepEqual(Object.keys(schema.properties).sort(), ['path', 'kind', 'number', 'maxDepth'].sort());
  const base = { path: f.a, kind: 'ch', number: 1 };
  const normal = decoded(await client.callTool({ name: 'wing_routes', arguments: base }));
  const shallow = decoded(await client.callTool({ name: 'wing_routes', arguments: { ...base, maxDepth: 0 } }));
  assert.equal(shallow.ok, true);
  assert.equal(shallow.result.maxDepth, 0);
  assert.ok(shallow.result.nodes.length < normal.result.nodes.length);
  assert.ok(shallow.result.unresolved.some(item => item.code === 'MAX_DEPTH_REACHED'));
  for (const invalid of [{ limit: 1 }, { offset: 0 }, { prefix: '/ae_data/ch' }, { kind: 'dca' }, { maxDepth: -1 }, { maxDepth: 33 }, { maxDepth: 0.5 }]) {
    const response = await client.callTool({ name: 'wing_routes', arguments: { ...base, ...invalid } });
    assert.equal(response.isError, true);
    assert.equal(decoded(response).error.code, 'INVALID_ARGUMENTS');
  }
  assert.equal(parseCliArgs(['routes', f.a, '--max-depth', '0']).args.maxDepth, 0);
  assert.equal(Object.hasOwn(parseCliArgs(['routes', f.a]).args, 'limit'), false);
  for (const flags of [['--limit', '1'], ['--offset', '0'], ['--prefix', '/ae_data/ch'], ['--kind', 'dca'], ['--max-depth', '33'], ['--max-depth', '-1']]) {
    assert.throws(() => parseCliArgs(['routes', f.a, ...flags]), error => error.code === 'INVALID_ARGUMENTS');
  }
  for (const args of [['inspect', f.a, '--number', '1'], ['channels', f.a, '--max-depth', '1'], ['get', f.a, '--pointer', '/type', '--prefix', '/ae_data']]) {
    assert.throws(() => parseCliArgs(args), error => error.code === 'INVALID_ARGUMENTS');
  }
});

test('oversized values are rejected instead of silently truncating document evidence', async t => {
  const f = await fixture(t);
  const doc = snap();
  doc.notes = 'x'.repeat(MAX_RESPONSE_BYTES + 100);
  const huge = path.join(f.root, 'large.snap');
  await fs.writeFile(huge, JSON.stringify(doc));
  const client = await memoryClient(t, { roots: [f.root] });
  const response = await client.callTool({ name: 'wing_get_parameter', arguments: { path: huge, pointer: '/notes' } });
  assert.equal(response.isError, true);
  assert.equal(decoded(response).error.code, 'RESPONSE_TOO_LARGE');
  assert.ok(Buffer.byteLength(JSON.stringify(response.structuredContent)) < MAX_RESPONSE_BYTES);
});

test('MCP requires explicit roots and a real stdio child initializes without stdout chatter', async t => {
  const f = await fixture(t);
  assert.throws(() => parseMcpArgs([]), error => error.code === 'ROOT_REQUIRED');
  assert.throws(() => parseMcpArgs(['--root', 'relative']), error => error.code === 'INVALID_ARGUMENTS');
  assert.deepEqual(parseMcpArgs(['--root', f.root, '--root=' + f.nested]).roots, [f.root, f.nested]);
  await assert.rejects(createWingMcpServer(), error => error.code === 'ROOT_REQUIRED');
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(repo, 'bin/wing-session-mcp.mjs'), '--root', f.root], stderr: 'pipe' });
  const client = new Client({ name: 'wing-stdio-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 14);
  assert.equal(decoded(await client.callTool({ name: 'wing_inspect', arguments: { path: f.a } })).ok, true);
});

test('standalone CLI has no SDK dependency, derives narrow explicit parents and emits JSON failures', async t => {
  const f = await fixture(t);
  const parsed = parseCliArgs(['diff', f.a, f.b, '--ignore-metadata', '--limit', '1']);
  assert.deepEqual(parsed.roots, [f.root, f.nested]);
  assert.equal(parsed.args.ignoreMetadata, true);
  assert.equal(parsed.args.limit, 1);
  assert.throws(() => parseCliArgs(['channels', f.a, '--limit', '201']), /1–200/);
  let output = '';
  assert.equal(await runCli(['get', f.a, '--pointer', '/ae_data/ch/1/name'], { stdout: { write: text => { output += text; } } }), 0);
  assert.equal(JSON.parse(output).result.value, 'Mic One');
  output = '';
  assert.equal(await runCli(['inspect', f.secret, '--root', f.root], { stdout: { write: text => { output += text; } } }), 1);
  assert.equal(JSON.parse(output).error.code, 'OUTSIDE_ROOT');
  const isolated = path.join(f.tmp, 'isolated-skill');
  await fs.cp(path.join(repo, 'skills/wing-session-analyzer/scripts'), isolated, { recursive: true });
  const child = await execute(process.execPath, [path.join(isolated, 'wing-session.mjs'), 'get', f.a, '--pointer', '/ae_data/ch/1/name']);
  assert.equal(JSON.parse(child.stdout).result.value, 'Mic One');
  assert.equal(child.stderr, '');
  const help = await execute(process.execPath, [path.join(repo, 'bin/wing-session.mjs'), '--help']);
  assert.match(help.stdout, /Usage:/);
});
