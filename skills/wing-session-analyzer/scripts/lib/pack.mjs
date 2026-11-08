import fs from 'node:fs/promises';
import path from 'node:path';
import { createAnalyzerService, AnalyzerError, inferExistingReadRoots } from './service.mjs';
import { renderMarkdownReport } from './reports.mjs';

const MAX_PACK_BYTES = 256 * 1024 * 1024;
const fail = (code, message) => { throw new AnalyzerError(code, message); };
const errorData = error => ({ code: typeof error?.code === 'string' ? error.code.slice(0, 80) : 'PACK_ERROR', message: String(error?.message || 'Report package failed.').slice(0, 2048) });

/** Explicit local artifact writer. Session reads still go through the read-only service. */
export async function createReportPack({ inputs, output, roots, baseline } = {}) {
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 100 || inputs.some(file => typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0'))) fail('INVALID_ARGUMENT', 'Select 1–100 absolute local input paths.');
  if (typeof output !== 'string' || !path.isAbsolute(output) || output.includes('\0')) fail('INVALID_ARGUMENT', 'Select an absolute new output directory.');
  if (baseline !== undefined && (typeof baseline !== 'string' || !path.isAbsolute(baseline) || baseline.includes('\0'))) fail('INVALID_ARGUMENT', 'The baseline must use an absolute local path.');
  const selectedRoots = roots?.length ? roots : inferExistingReadRoots([...inputs, ...(baseline ? [baseline] : [])].map(file => path.dirname(file)));
  const analyzer = createAnalyzerService({ roots: selectedRoots });
  const baselineEvidence = baseline ? (await analyzer.inspect({ path: baseline })).evidence : null;
  const destination = path.resolve(output);
  try { await fs.lstat(destination); fail('OUTPUT_EXISTS', 'The output path already exists. Select a new report directory.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try { await fs.mkdir(destination, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') fail('OUTPUT_EXISTS', 'The output path already exists. Select a new report directory.'); throw error; }
  const manifest = {
    schemaVersion: 'wing-session-pack.v1', analyzerVersion: '0.2.0', startedAt: new Date().toISOString(),
    output: destination, baseline: baselineEvidence, status: 'in-progress', complete: false,
    summary: { total: inputs.length, succeeded: 0, failed: 0 }, items: [],
    limitations: [
      'Complete means all requested report pages and local asset checks were collected, not full semantic, console, recall or audible-output validation.',
      'Reports describe each file by its exact-byte hash; files are not an atomic multi-file snapshot.',
      'Comparisons match channel family and slot number, not independently verified microphone identity.',
      'Only explicitly selected inputs are parsed. Show references are checked locally but are not automatically parsed or fetched.',
    ],
  };
  let writtenBytes = 0;
  async function writeArtifact(relative, value, text = false) {
    const data = text ? value : JSON.stringify(value, null, 2) + '\n';
    const bytes = Buffer.byteLength(data);
    if (writtenBytes + bytes > MAX_PACK_BYTES) fail('PACK_TOO_LARGE', 'Report artifacts exceed the 256 MiB package limit. Select fewer files or narrower comparisons.');
    const target = path.join(destination, relative);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, data, { flag: 'wx', mode: 0o600 });
    writtenBytes += bytes;
    return relative;
  }
  const sameSource = (actual, expected) => {
    if (!actual || actual.path !== expected.path || actual.sha256 !== expected.sha256) fail('FILE_CHANGED', 'A source changed between inventory and report pages; repeat in a new output directory.');
  };
  async function collectPages({ method, args, prefix, expected, files, markdown = true, paired = false }) {
    let offset = 0, limit = 50, pageNumber = 0;
    while (true) {
      let result;
      try { result = await analyzer[method]({ ...args, offset, limit }); }
      catch (error) {
        if (error.code === 'RESPONSE_TOO_LARGE' && limit > 1) { limit = Math.max(1, Math.floor(limit / 2)); continue; }
        throw error;
      }
      if (paired) { sameSource(result.evidence.before, baselineEvidence); sameSource(result.evidence.after, expected); }
      else sameSource(result.evidence, expected);
      if (++pageNumber > 10_000) fail('PAGE_LIMIT', 'This report exceeds the 10000-page collection limit.');
      const stem = pageNumber === 1 ? prefix : `${prefix}-page-${String(pageNumber).padStart(4, '0')}`;
      files.push(await writeArtifact(`${stem}.json`, result));
      if (markdown) files.push(await writeArtifact(`${stem}.md`, renderMarkdownReport(result), true));
      const more = method === 'report'
        ? ['channels', 'findings', 'scenes'].some(section => result[section]?.hasMore === true)
        : result.hasMore === true;
      if (!more) break;
      offset += limit;
    }
    return { pages: pageNumber, complete: true };
  }
  try {
    const inventory = await analyzer.index({ paths: inputs, limit: 100 });
    manifest.inventory = await writeArtifact('inventory.json', inventory);
    for (const entry of inventory.items) {
      const item = { index: entry.index, path: entry.path, status: 'ok', evidence: entry.evidence, files: [], stages: {}, errors: [] };
      manifest.items.push(item);
      if (entry.status === 'error') { item.status = 'error'; item.errors.push({ stage: 'inventory', ...entry.error }); continue; }
      const ordinal = String(entry.index).padStart(3, '0');
      for (const stage of ['report', ...(entry.kind === 'show' ? ['assets'] : []), ...(baseline ? ['compare'] : [])]) {
        try {
          item.stages[stage] = await collectPages({
            method: stage, args: stage === 'compare' ? { before: baseline, after: entry.path } : { path: entry.path },
            prefix: stage === 'compare' ? `comparisons/${ordinal}-comparison` : `sessions/${ordinal}-${stage}`,
            expected: entry.evidence, files: item.files, markdown: stage !== 'assets', paired: stage === 'compare',
          });
        } catch (error) { item.status = 'error'; item.stages[stage] = { complete: false }; item.errors.push({ stage, ...errorData(error) }); }
      }
    }
    manifest.summary.succeeded = manifest.items.filter(item => item.status === 'ok').length;
    manifest.summary.failed = inputs.length - manifest.summary.succeeded;
    manifest.complete = manifest.summary.failed === 0;
    manifest.status = manifest.complete ? 'complete' : 'partial';
  } catch (error) {
    manifest.status = 'error'; manifest.error = errorData(error);
    manifest.summary.succeeded = manifest.items.filter(item => item.status === 'ok').length;
    manifest.summary.failed = inputs.length - manifest.summary.succeeded;
  }
  manifest.completedAt = new Date().toISOString();
  manifest.artifactBytes = writtenBytes;
  // Reserve manifest writing even when the artifact byte budget has been reached.
  await fs.writeFile(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return manifest;
}
