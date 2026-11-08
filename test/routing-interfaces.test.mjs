import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createWingMcpServer } from '../src/mcp.mjs';
import { parseCliArgs, runCli } from '../skills/wing-session-analyzer/scripts/wing-session.mjs';
import { createAnalyzerService } from '../skills/wing-session-analyzer/scripts/lib/service.mjs';

async function fixture(t) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wing-routing-interface-')));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'allowed');
  await fs.mkdir(root);
  const document = { type: 'snapshot.11', creator_name: 'Minimal synthetic output routing experiment', ae_data: {
    ch: { '1': { name: 'HOST', clink: false, mute: false, fdr: -6,
      in: { conn: { grp: 'LCL', in: 1 }, set: { srcauto: false, altsrc: false } },
      send: { '1': { on: true, lvl: 0 } }, main: { '2': { on: true, lvl: -3 } } } },
    bus: { '1': { name: 'Panel mix', mute: false, fdr: 0, send: { MX8: { on: true, lvl: 0 } } } },
    main: { '2': { name: 'Stream', mute: false, fdr: 0 }, '4': { name: 'Unrelated main', mute: false, fdr: 0 } },
    mtx: { '8': { name: 'Room output', mute: false, fdr: 0 } },
    io: { in: { LCL: { '1': { name: 'Lectern', mode: 'M' } } }, out: {
      USB: { '1': { grp: 'BUS', in: 1 }, '2': { grp: 'BUS', in: 2 }, '3': { grp: 'MAIN', in: 4 },
        '4': { grp: 'MAIN', in: 8 }, '5': { grp: 'MAIN', in: 9 } },
      LCL: { '1': { grp: 'MTX', in: 16 }, '2': { grp: 'LCL', in: 1 } },
    } },
  } };
  const file = path.join(root, 'routing.snap');
  const outside = path.join(temporary, 'outside.snap');
  await Promise.all([fs.writeFile(file, JSON.stringify(document)), fs.writeFile(outside, JSON.stringify(document))]);
  return { root, file, outside, document };
}

async function clientFor(t, root) {
  const server = await createWingMcpServer({ roots: [root] });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'wing-routing-integration-test', version: '0.3.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}
function decode(response) {
  const body = JSON.parse(response.content[0].text);
  assert.deepEqual(body, response.structuredContent);
  return body;
}
async function cli(args) {
  let output = '';
  const status = await runCli(args, { stdout: { write: text => { output += text; } } });
  return { status, output, body: JSON.parse(output) };
}
const patches = graph => graph.edges.filter(edge => edge.kind === 'output_patch');

test('output-routes CLI requires an exact bank and slot and rejects unrelated route options', () => {
  const parsed = parseCliArgs(['output-routes', '/tmp/session.snap', '--bank', 'USB', '--number', '2', '--max-depth', '0']);
  assert.equal(parsed.method, 'outputRoutes');
  assert.deepEqual(parsed.args, { path: '/tmp/session.snap', bank: 'USB', number: 2, maxDepth: 0 });
  assert.equal(Object.hasOwn(parsed.args, 'limit'), false);
  for (const flags of [[], ['--bank', 'USB'], ['--number', '1'], ['--bank', '', '--number', '1'],
    ['--bank', 'USB', '--number', '0'], ['--bank', 'USB', '--number', '129'],
    ['--bank', 'USB', '--number', '1', '--limit', '10'], ['--bank', 'USB', '--number', '1', '--prefix', '/ae_data'],
    ['--bank', 'USB', '--number', '1', '--kind', 'ch'], ['--bank', 'USB', '--number', '1', '--max-depth', '33']]) {
    assert.throws(() => parseCliArgs(['output-routes', '/tmp/session.snap', ...flags]), error => error.code === 'INVALID_ARGUMENTS');
  }
  assert.throws(() => parseCliArgs(['routes', '/tmp/session.snap', '--bank', 'USB']), error => error.code === 'INVALID_ARGUMENTS');
});

test('shared service forward/reverse routes agree on decoded patch sides and keep exact source evidence', async t => {
  const f = await fixture(t);
  const original = await fs.readFile(f.file), stamp = (await fs.stat(f.file)).mtimeMs;
  const service = createAnalyzerService({ roots: [f.root] });
  const forward = await service.routes({ path: f.file, kind: 'ch', number: 1 });
  const hash = createHash('sha256').update(original).digest('hex');
  assert.equal(forward.evidence.sha256, hash);
  assert.equal(forward.evidence.parserVersion, '0.3.0');
  const expected = [
    ['USB', 1, 'bus:1', 'L'], ['USB', 2, 'bus:1', 'R'],
    ['USB', 3, 'main:2', 'R'], ['LCL', 1, 'mtx:8', 'R'],
  ];
  for (const [bank, number, from, side] of expected) {
    const target = `output:${bank}:${number}`;
    const downstream = patches(forward).find(edge => edge.to === target);
    assert.equal(downstream?.from, from);
    assert.equal(downstream?.side, side);
    assert.equal(downstream?.sourcePointer, `/ae_data/io/out/${bank}/${number}`);
    const reverse = await service.outputRoutes({ path: f.file, bank, number });
    assert.equal(reverse.direction, 'upstream');
    assert.equal(reverse.start, target);
    assert.equal(reverse.evidence.sha256, hash);
    assert.equal(reverse.audibleOutput, 'not_determined');
    assert.equal(reverse.interpretation, 'structural_reachability_only');
    assert.deepEqual(patches(reverse).find(edge => edge.to === target), downstream);
    assert.ok(reverse.nodes.some(node => node.id === 'ch:1'));
  }
  assert.equal(patches(forward).some(edge => edge.to === 'output:USB:4'), false, 'an unrelated MAIN 4 patch is not a HOST downstream route');
  assert.equal(patches(forward).some(edge => edge.to === 'output:LCL:2'), false, 'raw-input passthrough bypasses HOST processing');
  assert.deepEqual(await fs.readFile(f.file), original);
  assert.equal((await fs.stat(f.file)).mtimeMs, stamp);
});

test('MCP exposes a strict read-only output route schema and preserves root errors', async t => {
  const f = await fixture(t);
  const client = await clientFor(t, f.root);
  const { tools } = await client.listTools();
  const schema = tools.find(tool => tool.name === 'wing_output_routes');
  assert.ok(schema);
  assert.deepEqual(schema.inputSchema.required.sort(), ['bank', 'number', 'path']);
  assert.equal(schema.inputSchema.additionalProperties, false);
  assert.equal(schema.annotations.readOnlyHint, true);
  assert.equal(schema.annotations.destructiveHint, false);
  const args = { path: f.file, bank: 'USB', number: 2 };
  const response = await client.callTool({ name: 'wing_output_routes', arguments: args });
  assert.equal(response.isError, undefined);
  const reverse = decode(response).result;
  assert.ok(patches(reverse).some(edge => edge.from === 'bus:1' && edge.side === 'R'));
  const escaped = await client.callTool({ name: 'wing_output_routes', arguments: { ...args, path: f.outside } });
  assert.equal(escaped.isError, true);
  assert.equal(decode(escaped).error.code, 'OUTSIDE_ROOT');
  for (const invalid of [{ bank: undefined }, { number: undefined }, { bank: '' }, { bank: 'x'.repeat(65) }, { number: 0 },
    { maxDepth: 33 }, { limit: 1 }, { prefix: '/ae_data' }, { kind: 'ch' }, { path: 'relative.snap' }]) {
    const request = { ...args, ...invalid };
    for (const [key, value] of Object.entries(request)) if (value === undefined) delete request[key];
    const result = await client.callTool({ name: 'wing_output_routes', arguments: request });
    assert.equal(result.isError, true);
    assert.equal(decode(result).error.code, 'INVALID_ARGUMENTS');
  }
});

test('CLI output routes return upstream patch evidence and unknown references remain unresolved', async t => {
  const f = await fixture(t);
  const result = await cli(['output-routes', f.file, '--bank', 'USB', '--number', '3']);
  assert.equal(result.status, 0);
  assert.equal(result.body.result.direction, 'upstream');
  assert.ok(patches(result.body.result).some(edge => edge.from === 'main:2' && edge.side === 'R'));
  const unknown = await cli(['output-routes', f.file, '--bank', 'USB', '--number', '5']);
  assert.equal(unknown.status, 0);
  assert.ok(unknown.body.result.unresolved.length > 0);
  assert.equal(patches(unknown.body.result).some(edge => edge.from === 'main:5'), false);
  const missing = await cli(['output-routes', f.file, '--bank', 'ABSENT', '--number', '1']);
  assert.equal(missing.status, 0);
  assert.ok(missing.body.result.unresolved.length > 0);
});
