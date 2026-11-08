import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createWingMcpServer } from '../src/mcp.mjs';
import { parseCliArgs, runCli } from '../skills/wing-session-analyzer/scripts/wing-session.mjs';

const execute = promisify(execFile);
const repo = fileURLToPath(new URL('../', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');

async function fixture(t) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wing-interfaces-v2-')));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'allowed');
  await fs.mkdir(root);
  const makeDoc = name => ({ type: 'snapshot.11', creator_name: 'Synthetic integration fixture', ae_data: {
    ch: { '1': { name, clink: false, mute: false, fdr: -6, eq: { on: true, mdl: 'STD', '1f': 250, '1g': -2, '1q': 1 },
      in: { conn: { grp: 'LCL', in: 1 }, set: { srcauto: false, altsrc: false } }, main: { '1': { on: true, lvl: 0 } } },
    '2': { name: 'Panel', clink: false, mute: true, fdr: -144 } },
    main: { '1': { name: 'Main', mute: false, fdr: 0 } }, io: { in: { LCL: { '1': { name: 'Lectern', mode: 'M' } } } },
  } });
  const first = makeDoc('<script>alert(1)</script>|HOST\n# injected');
  const second = makeDoc('HOST changed');
  second.ae_data.ch['1'].eq['1g'] = -3;
  const a = path.join(root, 'a.snap');
  const b = path.join(root, 'b.snap');
  const duplicate = path.join(root, 'copy.snap');
  const invalid = path.join(root, 'invalid.snap');
  const outside = path.join(temporary, 'outside.snap');
  await Promise.all([
    fs.writeFile(a, JSON.stringify(first)), fs.writeFile(b, JSON.stringify(second)),
    fs.writeFile(duplicate, JSON.stringify(first)), fs.writeFile(invalid, '{invalid'),
    fs.writeFile(outside, JSON.stringify(first)),
  ]);
  return { root, temporary, a, b, duplicate, invalid, outside };
}

async function clientFor(t, root) {
  const server = await createWingMcpServer({ roots: [root] });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'wing-v2-integration-test', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

function decode(response) {
  const body = JSON.parse(response.content[0].text);
  assert.deepEqual(response.structuredContent, body);
  return body;
}

async function cli(argv) {
  let output = '';
  const status = await runCli(argv, { stdout: { write: value => { output += value; } } });
  return { status, output };
}

test('new CLI commands keep explicit path lists, command-specific formats and bounded file pages', () => {
  const cwd = '/tmp/wing-cli-parse';
  const parsed = parseCliArgs(['batch', 'one.snap', 'sub/two.snap', '--format', 'markdown'], cwd);
  assert.deepEqual(parsed.args.paths, [path.join(cwd, 'one.snap'), path.join(cwd, 'sub/two.snap')]);
  assert.deepEqual(parsed.roots, [cwd, path.join(cwd, 'sub')]);
  assert.equal(parsed.format, 'markdown');
  assert.equal(parsed.args.limit, 3);
  assert.equal(parsed.inferredRoots, true);
  assert.equal(parseCliArgs(['batch', 'one.snap', '--root', cwd], cwd).inferredRoots, false);
  assert.equal(Object.hasOwn(parsed.args, 'format'), false);
  assert.equal(parseCliArgs(['report', 'one.snap'], cwd).args.limit, 10);
  assert.equal(parseCliArgs(['report', 'one.snap', '--kind', 'all'], cwd).args.kind, 'all');
  assert.equal(parseCliArgs(['compare', 'one.snap', 'two.snap', '--ignore-metadata'], cwd).args.ignoreMetadata, true);
  for (const args of [
    ['batch'], ['batch', ...Array(101).fill('one.snap')], ['batch', 'one.snap', '--limit', '21'],
    ['index', 'one.snap', '--format', 'markdown'], ['report', 'one.snap', '--format', 'html'],
    ['report', 'one.snap', '--format', 'markdown', '--json'], ['compare', 'one.snap'],
    ['batch', 'one.snap', '--prefix', '/ae_data'], ['channels', 'one.snap', '--kind', 'all'],
  ]) assert.throws(() => parseCliArgs(args, cwd), error => error.code === 'INVALID_ARGUMENTS');
});

test('default report and three-file batch fit the response budget for broad synthetic console settings', async t => {
  const f = await fixture(t);
  const section = (count, build) => Object.fromEntries(Array.from({ length: count }, (_, index) => [String(index + 1), build(index + 1)]));
  const makeStrip = (name, number, sends = true) => ({
    name, col: 1, clink: false, mute: false, fdr: -6,
    in: { conn: { grp: 'LCL', in: number, altgrp: 'USB', altin: number }, set: { srcauto: false, altsrc: false } },
    flt: { lc: true, lcf: 100, lcs: 12, hc: false, hcf: 20000, hcs: 12 },
    eq: { on: true, mdl: 'STD', mix: 100, lf: 80, lg: 0, lq: 1, leq: 'SHELF',
      ...Object.fromEntries([1, 2, 3, 4].flatMap(band => [[`${band}f`, band * 500], [`${band}g`, -2], [`${band}q`, 1]])),
      hf: 12000, hg: 0, hq: 1, heq: 'SHELF' },
    gate: { on: false, mdl: 'GATE', thr: -50, range: 40, ratio: 2, att: 5, hld: 20, rel: 100, mix: 100, gain: 0, knee: 3 },
    dyn: { on: true, mdl: 'COMP', thr: -18, range: 20, ratio: 3, att: 10, hld: 0, rel: 150, mix: 100, gain: 2, knee: 3 },
    preins: { on: false, ins: 0, mode: 'OFF' }, postins: { on: false, ins: 0, mode: 'OFF' },
    main: section(4, destination => ({ on: destination === 1, lvl: 0, pre: false })),
    ...(sends ? { send: { ...section(16, destination => ({ on: destination === 1, lvl: -12, pre: false })),
      ...Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`MX${index + 1}`, { on: false, lvl: -12, pre: false }])) } } : {}),
  });
  const document = { type: 'snapshot.11', creator_name: 'Hand-built broad synthetic settings, not a native template', ae_data: {
    ch: section(40, number => makeStrip(`CH ${number}`, number)), aux: section(8, number => makeStrip(`AUX ${number}`, number)),
    bus: section(16, number => makeStrip(`BUS ${number}`, number, false)), main: section(4, number => ({ name: `MAIN ${number}`, mute: false, fdr: 0 })),
    mtx: section(8, number => ({ name: `MATRIX ${number}`, mute: false, fdr: 0 })),
    dca: section(16, number => ({ name: `DCA ${number}`, mute: false, fdr: 0 })), mgrp: section(8, number => ({ name: `MUTE ${number}` })),
    io: { in: { LCL: section(48, number => ({ name: `Input ${number}`, mode: 'M', g: 0, vph: false })),
      USB: section(48, number => ({ name: `USB ${number}`, mode: 'M' })) },
    out: { USB: section(48, number => ({ grp: 'MAIN', in: number % 8 + 1 })) } },
  } };
  const files = [1, 2, 3].map(number => path.join(f.root, `broad-${number}.snap`));
  await Promise.all(files.map(file => fs.writeFile(file, JSON.stringify(document))));
  const report = await cli(['report', files[0]]);
  assert.equal(report.status, 0, report.output);
  const result = JSON.parse(report.output).result;
  assert.equal(result.channels.limit, 10);
  assert.equal(result.channels.hasMore, true);
  assert.equal(result.channels.total, 100);
  assert.ok(Buffer.byteLength(report.output) <= 262144);
  assert.equal(report.output.trim().includes('\n'), false, 'new report JSON is compact to preserve the response budget');
  const batch = await cli(['batch', ...files]);
  assert.equal(batch.status, 0, batch.output);
  const batched = JSON.parse(batch.output).result;
  assert.equal(batched.summary.succeeded, 3);
  assert.ok(batched.items.every(item => item.report.channels.limit === 5 && item.report.channels.hasMore));
  assert.ok(Buffer.byteLength(batch.output) <= 262144);
  const client = await clientFor(t, f.root);
  const response = decode(await client.callTool({ name: 'wing_report', arguments: { path: files[0] } }));
  assert.equal(response.ok, true);
  assert.equal(response.result.channels.limit, 10);
});

test('report and semantic comparison cross the real MCP service with source identity and paging', async t => {
  const f = await fixture(t);
  const client = await clientFor(t, f.root);
  const original = await fs.readFile(f.a);
  const originalStat = await fs.stat(f.a);
  const report = decode(await client.callTool({ name: 'wing_report', arguments: { path: f.a, kind: 'ch', limit: 1 } }));
  assert.equal(report.ok, true);
  assert.equal(report.result.schemaVersion, 'wing-session-report.v1');
  assert.equal(report.result.evidence.sha256, hash(original));
  assert.equal(report.result.channels.items.length, 1);
  assert.equal(report.result.channels.total, 2);
  assert.equal(report.result.channels.hasMore, true);
  const compared = decode(await client.callTool({ name: 'wing_compare', arguments: { before: f.a, after: f.b, limit: 1 } }));
  assert.equal(compared.ok, true);
  assert.equal(compared.result.schemaVersion, 'wing-session-comparison.v1');
  assert.equal(compared.result.items.length, 1);
  assert.ok(compared.result.total > compared.result.items.length);
  assert.equal(compared.result.evidence.before.sha256, hash(original));
  assert.notEqual(compared.result.evidence.before.sha256, compared.result.evidence.after.sha256);
  assert.deepEqual(await fs.readFile(f.a), original);
  assert.equal((await fs.stat(f.a)).mtimeMs, originalStat.mtimeMs);
});

test('batch MCP keeps invalid and outside-root files as per-file failures and reports page scope', async t => {
  const f = await fixture(t);
  const client = await clientFor(t, f.root);
  const response = await client.callTool({ name: 'wing_batch', arguments: { paths: [f.a, f.invalid, f.outside], limit: 3 } });
  const body = decode(response);
  assert.equal(response.isError, undefined);
  assert.equal(body.ok, true);
  assert.equal(body.result.schemaVersion, 'wing-session-batch.v1');
  assert.equal(body.result.summary.examined, 3);
  assert.equal(body.result.summary.succeeded, 1);
  assert.equal(body.result.summary.failed, 2);
  assert.equal(body.result.summary.countsScope, 'returned-page');
  assert.deepEqual(body.result.items.map(item => item.status), ['ok', 'error', 'error']);
  assert.equal(body.result.items[2].error.code, 'OUTSIDE_ROOT');
  const page = decode(await client.callTool({ name: 'wing_batch', arguments: { paths: [f.invalid, f.a], offset: 1, limit: 1 } }));
  assert.equal(page.result.summary.total, 2);
  assert.equal(page.result.summary.examined, 1);
  assert.equal(page.result.summary.failed, 0);
  assert.equal(page.result.items[0].path, f.a);
});

test('new MCP list schemas reject relative paths, empty/oversized lists and unsupported options', async t => {
  const f = await fixture(t);
  const client = await clientFor(t, f.root);
  for (const name of ['wing_batch', 'wing_index']) {
    for (const args of [{ paths: [] }, { paths: Array(101).fill(f.a) }, { paths: ['relative.snap'] }, { paths: [f.a], recursive: true }]) {
      const response = await client.callTool({ name, arguments: args });
      assert.equal(response.isError, true);
      assert.equal(decode(response).error.code, 'INVALID_ARGUMENTS');
    }
  }
  const overPage = await client.callTool({ name: 'wing_batch', arguments: { paths: [f.a], limit: 21 } });
  assert.equal(overPage.isError, true);
  assert.equal(decode(overPage).error.code, 'INVALID_ARGUMENTS');
  const reportEscape = await client.callTool({ name: 'wing_report', arguments: { path: f.outside } });
  assert.equal(reportEscape.isError, true);
  assert.equal(decode(reportEscape).error.code, 'OUTSIDE_ROOT');
});

test('index MCP preserves exact-byte duplicates across its detail page and retains failed files', async t => {
  const f = await fixture(t);
  const client = await clientFor(t, f.root);
  const response = decode(await client.callTool({ name: 'wing_index', arguments: { paths: [f.a, f.b, f.duplicate, f.invalid], limit: 1 } }));
  assert.equal(response.ok, true);
  assert.equal(response.result.schemaVersion, 'wing-session-index.v1');
  assert.equal(response.result.items.length, 1);
  assert.equal(response.result.total, 4);
  assert.equal(response.result.hasMore, true);
  assert.equal(response.result.summary.succeeded, 3);
  assert.equal(response.result.summary.failed, 1);
  assert.equal(response.result.summary.countsScope, 'all-selected-files');
  assert.equal(response.result.duplicates.length, 1);
  assert.deepEqual(response.result.duplicates[0].files.map(item => item.path), [f.a, f.duplicate]);
  assert.equal(response.result.duplicates[0].sha256, hash(await fs.readFile(f.a)));
});

test('CLI retains per-file failures when selected input parents do not exist, while explicit roots stay strict', async t => {
  const f = await fixture(t);
  const missingParent = path.join(f.root, 'missing-parent', 'nested', 'missing.snap');
  const otherMissingParent = path.join(f.root, 'another-missing-parent', 'missing.snap');
  for (const command of ['batch', 'index']) {
    const mixed = await cli([command, f.a, missingParent]);
    assert.equal(mixed.status, 2, mixed.output);
    const mixedResult = JSON.parse(mixed.output).result;
    assert.equal(mixedResult.summary.succeeded, 1);
    assert.equal(mixedResult.summary.failed, 1);
    assert.deepEqual(mixedResult.items.map(item => item.status), ['ok', 'error']);
    assert.equal(mixedResult.items[1].error.code, 'FILE_NOT_FOUND');
    const allMissing = await cli([command, missingParent, otherMissingParent]);
    assert.equal(allMissing.status, 2, allMissing.output);
    const missingResult = JSON.parse(allMissing.output).result;
    assert.equal(missingResult.summary.succeeded, 0);
    assert.equal(missingResult.summary.failed, 2);
    assert.ok(missingResult.items.every(item => item.status === 'error' && item.error.code === 'FILE_NOT_FOUND'));
    const explicit = await cli([command, f.a, '--root', path.dirname(missingParent)]);
    assert.equal(explicit.status, 1);
    assert.equal(JSON.parse(explicit.output).error.code, 'ROOT_INVALID');
  }
});

test('CLI emits bounded escaped Markdown and signals partial batch/index failures without dropping evidence', async t => {
  const f = await fixture(t);
  const original = await fs.readFile(f.a);
  const report = await cli(['report', f.a, '--format', 'markdown']);
  assert.equal(report.status, 0);
  assert.match(report.output, /HOST/);
  assert.doesNotMatch(report.output, /<script>|\n# injected/);
  assert.match(report.output, new RegExp(hash(original)));
  const compare = await cli(['compare', f.a, f.b, '--format', 'markdown']);
  assert.equal(compare.status, 0);
  assert.match(compare.output, /HOST/);
  const batch = await cli(['batch', f.a, f.invalid]);
  assert.equal(batch.status, 2);
  const body = JSON.parse(batch.output);
  assert.equal(body.ok, true);
  assert.equal(body.result.summary.failed, 1);
  assert.deepEqual(body.result.items.map(item => item.status), ['ok', 'error']);
  const markdown = await cli(['batch', f.a, f.invalid, '--format', 'markdown']);
  assert.equal(markdown.status, 2);
  assert.match(markdown.output, /invalid/);
  assert.match(markdown.output, /Status: error/);
  assert.doesNotMatch(markdown.output, /<script>/);
  const inventory = await cli(['index', f.a, f.duplicate, f.invalid]);
  assert.equal(inventory.status, 2);
  assert.equal(JSON.parse(inventory.output).result.summary.failed, 1);
  assert.match(inventory.output, new RegExp(hash(original)));
  assert.deepEqual(await fs.readFile(f.a), original);
});

test('copied skill provides report and comparison without the repository SDK or node_modules', async t => {
  const f = await fixture(t);
  const isolated = path.join(f.temporary, 'isolated-skill');
  await fs.cp(path.join(repo, 'skills/wing-session-analyzer/scripts'), isolated, { recursive: true });
  const result = await execute(process.execPath, [path.join(isolated, 'wing-session.mjs'), 'report', f.a, '--limit', '1']);
  assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).result.schemaVersion, 'wing-session-report.v1');
  const markdown = await execute(process.execPath, [path.join(isolated, 'wing-session.mjs'), 'compare', f.a, f.b, '--format', 'markdown']);
  assert.equal(markdown.stderr, '');
  assert.match(markdown.stdout, /HOST/);
});

test('standalone CLI executes through directory and file symlink aliases', async t => {
  const f = await fixture(t);
  const isolated = path.join(f.temporary, 'actual-skill');
  const directoryAlias = path.join(f.temporary, 'skill-alias');
  const fileAlias = path.join(f.temporary, 'cli-alias.mjs');
  await fs.cp(path.join(repo, 'skills/wing-session-analyzer/scripts'), isolated, { recursive: true });
  await fs.symlink(isolated, directoryAlias);
  await fs.symlink(path.join(isolated, 'wing-session.mjs'), fileAlias);
  for (const entrypoint of [path.join(directoryAlias, 'wing-session.mjs'), fileAlias]) {
    const result = await execute(process.execPath, [entrypoint, 'report', f.a, '--limit', '1']);
    assert.equal(result.stderr, '');
    const body = JSON.parse(result.stdout);
    assert.equal(body.ok, true);
    assert.equal(body.result.schemaVersion, 'wing-session-report.v1');
    assert.equal(body.result.channels.items.length, 1);
  }
});
