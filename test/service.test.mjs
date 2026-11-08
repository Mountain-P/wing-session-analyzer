import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createAnalyzerService } from '../skills/wing-session-analyzer/scripts/lib/service.mjs';

const examples = fileURLToPath(new URL('../examples/', import.meta.url));
async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'wing-session-service-'));
  const root = path.join(base, 'allowed');
  await fs.mkdir(root);
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return { base, root };
}
const tiny = { type: 'snapshot.11', ae_data: { ch: { '1': { name: 'HOST', mute: true, fdr: -6 } } } };
const put = (where, value) => fs.writeFile(where, JSON.stringify(value));

test('source evidence hashes the exact bytes and analysis leaves the original unchanged', async t => {
  const { root } = await fixture(t);
  const file = path.join(root, 'session.snap');
  const bytes = Buffer.from(JSON.stringify(tiny) + '\n');
  await fs.writeFile(file, bytes);
  const before = await fs.stat(file);
  const result = await createAnalyzerService({ roots: [root] }).inspect({ path: file });
  assert.equal(result.evidence.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(result.evidence.bytes, bytes.length);
  assert.deepEqual(await fs.readFile(file), bytes);
  assert.equal((await fs.stat(file)).mtimeMs, before.mtimeMs);
});

test('the MCP service requires explicit directory roots and rejects URL inputs', async t => {
  const { root } = await fixture(t);
  assert.throws(() => createAnalyzerService(), { code: 'ROOT_REQUIRED' });
  assert.throws(() => createAnalyzerService({ roots: ['.'] }), { code: 'ROOT_INVALID' });
  const service = createAnalyzerService({ roots: [root] });
  await assert.rejects(service.inspect({ path: 'https://invalid.example/session.snap' }), { code: 'INVALID_PATH' });
});

test('lexical traversal, root-prefix lookalikes and symlink escapes cannot read outside roots', async t => {
  const { base, root } = await fixture(t);
  const secret = path.join(base, 'outside.snap');
  await put(secret, tiny);
  const lookalike = `${root}-other`;
  await fs.mkdir(lookalike);
  await put(path.join(lookalike, 'outside.snap'), tiny);
  await fs.symlink(secret, path.join(root, 'escape.snap'));
  const service = createAnalyzerService({ roots: [root] });
  for (const file of [secret, '../outside.snap', path.join(lookalike, 'outside.snap'), path.join(root, 'escape.snap')]) {
    await assert.rejects(service.inspect({ path: file }), { code: 'OUTSIDE_ROOT' });
  }
});

test('input size, invalid encoding, regular-file type and missing paths fail clearly', async t => {
  const { root } = await fixture(t);
  await fs.writeFile(path.join(root, 'large.snap'), Buffer.alloc(1025, 32));
  await fs.writeFile(path.join(root, 'binary.snap'), Buffer.from([0xff, 0xfe, 0xfd]));
  const service = createAnalyzerService({ roots: [root], maxFileBytes: 1024 });
  await assert.rejects(service.inspect({ path: 'large.snap' }), { code: 'FILE_TOO_LARGE' });
  await assert.rejects(service.inspect({ path: 'binary.snap' }), { code: 'INVALID_ENCODING' });
  await assert.rejects(service.inspect({ path: root }), { code: 'NOT_FILE' });
  await assert.rejects(service.inspect({ path: 'missing.snap' }), { code: 'FILE_NOT_FOUND' });
});

test('large parameter values produce a bounded error rather than a silently shortened value', async t => {
  const { root } = await fixture(t);
  await put(path.join(root, 'session.snap'), { ...tiny, notes: 'x'.repeat(5000) });
  const service = createAnalyzerService({ roots: [root], maxOutputBytes: 1024 });
  await assert.rejects(service.parameter({ path: 'session.snap', pointer: '/notes' }), { code: 'RESPONSE_TOO_LARGE' });
  const small = await service.parameter({ path: 'session.snap', pointer: '/ae_data/ch/1/mute' });
  assert.equal(small.value, true);
});

test('paging arguments are bounded before executing queries', async t => {
  const { root } = await fixture(t);
  await put(path.join(root, 'session.snap'), tiny);
  const service = createAnalyzerService({ roots: [root] });
  for (const limit of [0, -1, 201, 1.5, '20']) await assert.rejects(service.channels({ path: 'session.snap', limit }), { code: 'INVALID_ARGUMENT' });
});

test('show asset checks observe references without fetching, global searching or escaping the asset root', async t => {
  const { base, root } = await fixture(t);
  await put(path.join(root, 'present.snap'), tiny);
  await put(path.join(base, 'outside.snap'), tiny);
  await fs.symlink(path.join(base, 'outside.snap'), path.join(root, 'linked.snap'));
  await fs.mkdir(path.join(root, 'directory.snap'));
  const refs = ['present.snap', 'missing.snap', '../outside.snap', 'linked.snap', 'https://invalid.example/no-fetch', 'C:\\show\\scene.snap', 'directory.snap'];
  await put(path.join(root, 'session.show'), {
    type: 'showfile.1', scenes: { count: refs.length, ...Object.fromEntries(refs.map((file, index) => [String(index + 1), { name: `Scene ${index + 1}`, file }])) },
  });
  const result = await createAnalyzerService({ roots: [root] }).assets({ path: 'session.show', limit: 20 });
  assert.equal(result.total, 7);
  assert.deepEqual(result.items.map(item => item.status), ['present', 'missing', 'outside_asset_root', 'outside_asset_root', 'external_reference', 'external_reference', 'not_regular_file']);
  assert.ok(result.items.every(item => item.sourcePointer.endsWith('/file')));
  assert.equal(result.countsScope, 'returned-page');
});

test('asset paging covers later references and reports page-only counts explicitly', async t => {
  const { root } = await fixture(t);
  await put(path.join(root, 'session.show'), { type: 'showfile.1', scenes: { count: 3, '1': { file: '' }, '2': { file: 'a.snap' }, '3': { file: 'b.snap' } } });
  const result = await createAnalyzerService({ roots: [root] }).assets({ path: 'session.show', offset: 1, limit: 1 });
  assert.equal(result.total, 2);
  assert.equal(result.items[0].reference, 'b.snap');
  assert.equal(result.hasMore, false);
  assert.equal(result.counts.missing, 1);
});

test('the shared service can analyze the repository example and retain both diff source identities', async () => {
  const service = createAnalyzerService({ roots: [examples] });
  const result = await service.diff({ before: 'conference.snap', after: 'conference-after.snap', limit: 100 });
  assert.notEqual(result.evidence.before.sha256, result.evidence.after.sha256);
  assert.ok(result.items.some(item => (item.pointer || item.path || item.sourcePointer) === '/created'));
});
