import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAnalyzerService } from '../skills/wing-session-analyzer/scripts/lib/service.mjs';
import { createReportPack } from '../skills/wing-session-analyzer/scripts/lib/pack.mjs';
import { runPackCli, parsePackArgs } from '../skills/wing-session-analyzer/scripts/wing-session-pack.mjs';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const snap = name => ({ type: 'snapshot.11', ae_data: { ch: { '1': { name, clink: false, mute: false, fdr: 0 } } } });
async function fixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wing-bulk-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'sessions');
  await fs.mkdir(root);
  const a = path.join(root, 'a.snap'), b = path.join(root, 'b.snap'), copy = path.join(root, 'copy.snap');
  const spaced = path.join(root, 'whitespace.snap'), invalid = path.join(root, 'invalid.snap'), outside = path.join(base, 'outside.snap');
  await Promise.all([
    fs.writeFile(a, JSON.stringify(snap('HOST'))), fs.writeFile(b, JSON.stringify(snap('CHANGED'))),
    fs.writeFile(copy, JSON.stringify(snap('HOST'))), fs.writeFile(spaced, JSON.stringify(snap('HOST'), null, 2)),
    fs.writeFile(invalid, '{bad'), fs.writeFile(outside, JSON.stringify(snap('OUTSIDE'))),
  ]);
  return { base, root, a, b, copy, spaced, invalid, outside, service: createAnalyzerService({ roots: [root] }) };
}

test('bulk selection rejects malformed lists and batch bounds before reading files', async t => {
  const f = await fixture(t);
  for (const paths of [[], Array(101).fill(f.a), [null], [''], [12], 'a.snap']) {
    await assert.rejects(f.service.batch({ paths }), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(f.service.index({ paths }), { code: 'INVALID_ARGUMENT' });
  }
  await assert.rejects(f.service.batch({ paths: [f.a], limit: 21 }), { code: 'INVALID_ARGUMENT' });
});

test('batch only examines the selected file page and embeds explicitly paged reports', async t => {
  const f = await fixture(t);
  const channels = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [i + 1, { name: `CH ${i + 1}`, mute: false, fdr: 0 }]));
  await fs.writeFile(f.a, JSON.stringify({ type: 'snapshot.11', ae_data: { ch: channels } }));
  const result = await f.service.batch({ paths: [f.invalid, f.a, f.outside], offset: 1, limit: 1 });
  assert.deepEqual(result.summary, { total: 3, examined: 1, succeeded: 1, failed: 0, countsScope: 'returned-page' });
  assert.equal(result.items[0].index, 2);
  assert.equal(result.items[0].report.channels.items.length, 5);
  assert.equal(result.items[0].report.channels.hasMore, true);
  assert.equal(result.hasMore, true);
});

test('index hashes every selected file while paging details and groups exact bytes only', async t => {
  const f = await fixture(t);
  const result = await f.service.index({ paths: [f.a, f.copy, f.spaced, f.invalid, f.outside], offset: 2, limit: 1 });
  assert.equal(result.summary.succeeded, 3);
  assert.equal(result.summary.failed, 2);
  assert.equal(result.summary.repeatedCopies, 1);
  assert.equal(result.items[0].path, f.spaced);
  assert.deepEqual(result.duplicates[0].files.map(item => item.path), [f.a, f.copy]);
  assert.equal(result.hasMore, true);
});

test('report package collects every channel, scene and asset page without changing original bytes or mtime', async t => {
  const f = await fixture(t);
  const channels = Object.fromEntries(Array.from({ length: 61 }, (_, index) => [index + 1, { name: `MIC ${index + 1}`, clink: false, mute: false, fdr: 0 }]));
  await fs.writeFile(f.a, JSON.stringify({ type: 'snapshot.11', ae_data: { ch: channels } }));
  const show = path.join(f.root, 'many.show');
  await fs.writeFile(show, JSON.stringify({ type: 'showfile.1', scenes: { count: 61, ...Object.fromEntries(Array.from({ length: 61 }, (_, index) => [index + 1, { name: `Cue ${index + 1}`, file: index === 0 ? 'a.snap' : `missing-${index}.snap` }])) } }));
  const before = await fs.readFile(f.a), stamp = (await fs.stat(f.a)).mtimeMs;
  const output = path.join(f.base, 'reports', 'run1');
  const manifest = await createReportPack({ inputs: [f.a, show], output });
  assert.equal(manifest.complete, true);
  assert.equal(manifest.status, 'complete');
  assert.equal(manifest.summary.succeeded, 2);
  const channelNumbers = [], sceneNumbers = [], assetReferences = [];
  for (const item of manifest.items) for (const file of item.files.filter(file => file.endsWith('.json'))) {
    const result = JSON.parse(await fs.readFile(path.join(output, file), 'utf8'));
    if (file.includes('-report')) {
      channelNumbers.push(...result.channels.items.map(channel => channel.number));
      sceneNumbers.push(...(result.scenes?.items || []).map(scene => scene.number));
    }
    if (file.includes('-assets')) assetReferences.push(...result.items.map(asset => asset.reference));
  }
  assert.deepEqual(channelNumbers, Array.from({ length: 61 }, (_, index) => index + 1));
  assert.equal(sceneNumbers.length, 61);
  assert.equal(new Set(sceneNumbers).size, 61);
  assert.equal(assetReferences.length, 61);
  assert.equal(manifest.items[1].stages.assets.pages, 2);
  assert.deepEqual(await fs.readFile(f.a), before);
  assert.equal((await fs.stat(f.a)).mtimeMs, stamp);
  assert.equal(JSON.parse(await fs.readFile(path.join(output, 'manifest.json'), 'utf8')).complete, true);
});

test('package retains successful files and baseline comparisons alongside per-file failures', async t => {
  const f = await fixture(t);
  const output = path.join(f.base, 'partial');
  const manifest = await createReportPack({ inputs: [f.b, f.invalid, f.outside], baseline: f.a, roots: [f.root], output });
  assert.equal(manifest.status, 'partial');
  assert.equal(manifest.complete, false);
  assert.deepEqual(manifest.summary, { total: 3, succeeded: 1, failed: 2 });
  assert.deepEqual(manifest.items.map(item => item.status), ['ok', 'error', 'error']);
  assert.equal(manifest.items[2].errors[0].code, 'OUTSIDE_ROOT');
  assert.equal(manifest.items[0].stages.compare.complete, true);
  const comparison = JSON.parse(await fs.readFile(path.join(output, 'comparisons/001-comparison.json'), 'utf8'));
  assert.equal(comparison.total, 1);
  assert.notEqual(comparison.evidence.before.sha256, comparison.evidence.after.sha256);
  const previous = await fs.readFile(path.join(output, 'manifest.json'));
  await assert.rejects(createReportPack({ inputs: [f.a], output }), { code: 'OUTPUT_EXISTS' });
  assert.deepEqual(await fs.readFile(path.join(output, 'manifest.json')), previous);
});

test('pack refuses existing files/symlink destinations and invalid baseline before creating output', async t => {
  const f = await fixture(t);
  const output = path.join(f.base, 'new-output');
  await assert.rejects(createReportPack({ inputs: [f.a], output, baseline: f.invalid }), { code: 'INVALID_JSON' });
  await assert.rejects(fs.stat(output), { code: 'ENOENT' });
  await assert.rejects(createReportPack({ inputs: [f.a], output: f.a }), { code: 'OUTPUT_EXISTS' });
  const linked = path.join(f.base, 'linked-output');
  await fs.symlink(f.a, linked);
  await assert.rejects(createReportPack({ inputs: [f.a], output: linked }), { code: 'OUTPUT_EXISTS' });
});

test('missing input parent remains a per-file package failure with inferred roots', async t => {
  const f = await fixture(t);
  const missing = path.join(f.base, 'not-created', 'nested', 'missing.snap');
  const result = await createReportPack({ inputs: [f.a, missing], output: path.join(f.base, 'missing-parent-output') });
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.summary, { total: 2, succeeded: 1, failed: 1 });
  assert.equal(result.items[1].errors[0].code, 'FILE_NOT_FOUND');
  const allMissing = await createReportPack({ inputs: [missing], output: path.join(f.base, 'all-missing-output') });
  assert.equal(allMissing.status, 'partial');
  assert.equal(allMissing.summary.failed, 1);
  assert.equal(allMissing.items[0].errors[0].code, 'FILE_NOT_FOUND');
  await assert.rejects(createReportPack({ inputs: [f.a], roots: [path.join(f.base, 'missing-root')], output: path.join(f.base, 'strict-output') }), { code: 'ROOT_INVALID' });
});

test('pack CLI makes partial failure visible and keeps output names independent of hostile session labels', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.a, JSON.stringify(snap('../../outside|<script>')));
  const output = path.join(f.base, 'cli-output');
  let stdout = '';
  const status = await runPackCli(['--input', f.a, '--input', f.invalid, '--output', output], { stdout: { write: text => { stdout += text; } } });
  assert.equal(status, 2);
  assert.equal(JSON.parse(stdout).result.status, 'partial');
  const files = await fs.readdir(path.join(output, 'sessions'));
  assert.deepEqual(files, ['001-report.json', '001-report.md']);
  assert.doesNotMatch(await fs.readFile(path.join(output, 'sessions/001-report.md'), 'utf8'), /<script>/);
  assert.throws(() => parsePackArgs(['--input', 'relative.snap', '--output', output]), { code: 'INVALID_ARGUMENTS' });
});

test('standalone pack entrypoint runs through a directory symlink with no SDK dependencies', async t => {
  const f = await fixture(t);
  const isolated = path.join(f.base, 'copied-skill');
  const alias = path.join(f.base, 'alias-skill');
  await fs.cp(fileURLToPath(new URL('../skills/wing-session-analyzer/scripts', import.meta.url)), isolated, { recursive: true });
  await fs.symlink(isolated, alias);
  const output = path.join(f.base, 'alias-output');
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [path.join(alias, 'wing-session-pack.mjs'), '--input', f.a, '--output', output]);
  assert.equal(stderr, '');
  assert.equal(JSON.parse(stdout).result.complete, true);
  assert.equal(JSON.parse(await fs.readFile(path.join(output, 'manifest.json'), 'utf8')).complete, true);
});
