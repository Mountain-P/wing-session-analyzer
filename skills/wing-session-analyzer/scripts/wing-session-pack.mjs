#!/usr/bin/env node
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { createReportPack } from './lib/pack.mjs';

const HELP = `Usage: wing-session-pack --input /absolute/session.snap [--input /another.show] --output /absolute/NEW_REPORT_DIR
Options:
  --input PATH       Explicit absolute WING JSON file (repeatable, 1–100)
  --output DIR       New absolute directory; existing paths are refused
  --baseline PATH    Optional explicit absolute baseline for per-file comparisons
  --root DIR         Restrict reads to an existing absolute directory (repeatable)
  --help, -h         Show help
Writes local JSON/Markdown reports and manifest; never changes source sessions.
All report, finding, scene, comparison and local asset pages are collected.
Outputs are numbered by selection order, never by untrusted session names.
Default read roots are the parents of the explicit inputs and baseline.
Exit codes: 0 complete package, 2 partial package, 1 startup/package failure.
`;
export function parsePackArgs(argv) {
  const inputs = [], roots = [], selected = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') return { help: true };
    if (!['--input', '--output', '--baseline', '--root'].includes(flag)) throw Object.assign(new Error(`Unsupported option: ${flag}`), { code: 'INVALID_ARGUMENTS' });
    const value = argv[++index];
    if (!value || !isAbsolute(value) || value.includes('\0')) throw Object.assign(new Error(`${flag} requires an absolute local path.`), { code: 'INVALID_ARGUMENTS' });
    if (flag === '--input') inputs.push(value);
    else if (flag === '--root') roots.push(value);
    else {
      const key = flag.slice(2);
      if (Object.hasOwn(selected, key)) throw Object.assign(new Error(`${flag} may appear only once.`), { code: 'INVALID_ARGUMENTS' });
      selected[key] = value;
    }
  }
  if (!selected.output || inputs.length < 1 || inputs.length > 100) throw Object.assign(new Error('Select 1–100 --input files and one --output directory.'), { code: 'INVALID_ARGUMENTS' });
  return { inputs, roots, ...selected };
}
export async function runPackCli(argv = process.argv.slice(2), { stdout = process.stdout } = {}) {
  try {
    const args = parsePackArgs(argv);
    if (args.help) { stdout.write(HELP); return 0; }
    const manifest = await createReportPack(args);
    stdout.write(JSON.stringify({ ok: manifest.status !== 'error', result: { output: manifest.output, manifest: `${manifest.output}/manifest.json`, status: manifest.status, complete: manifest.complete, summary: manifest.summary }, ...(manifest.error ? { error: manifest.error } : {}) }, null, 2) + '\n');
    return manifest.status === 'error' ? 1 : manifest.complete ? 0 : 2;
  } catch (error) {
    stdout.write(JSON.stringify({ ok: false, error: { code: error.code || 'PACK_ERROR', message: String(error.message || 'Report package failed.').slice(0, 2048) } }, null, 2) + '\n');
    return 1;
  }
}
function isEntrypoint() {
  try { return process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}
if (isEntrypoint()) process.exitCode = await runPackCli();
