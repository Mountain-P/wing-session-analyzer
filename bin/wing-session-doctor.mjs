#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createAnalyzerService } from '../skills/wing-session-analyzer/scripts/lib/service.mjs';
import { createReportPack } from '../skills/wing-session-analyzer/scripts/lib/pack.mjs';

const checks = [];
let temporary, client;
async function check(name, action) {
  try { const detail = await action(); checks.push({ name, status: 'pass', ...(detail ? { detail } : {}) }); }
  catch (error) { checks.push({ name, status: 'fail', error: String(error.message || error).slice(0, 1024) }); }
}
const ensure = (condition, message) => { if (!condition) throw new Error(message); };
async function timed(action) {
  let timeout;
  try { return await Promise.race([action(), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('MCP startup/call exceeded 10 seconds.')), 10_000); })]); }
  finally { clearTimeout(timeout); }
}
try {
  await check('Node.js runtime', async () => { ensure(Number(process.versions.node.split('.')[0]) >= 20, 'Node.js 20 or later is required.'); return process.versions.node; });
  temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wing-doctor-')));
  const first = path.join(temporary, 'first.snap'), second = path.join(temporary, 'second.snap');
  const fixture = { type: 'snapshot.11', creator_name: 'Synthetic readiness check', ae_data: { ch: { '1': { name: 'HOST', clink: false, mute: false, fdr: 0, eq: { on: true, mdl: 'STD', '1f': 250, '1g': -2, '1q': 1 } } } } };
  await fs.writeFile(first, JSON.stringify(fixture));
  fixture.ae_data.ch['1'].eq['1g'] = -3;
  await fs.writeFile(second, JSON.stringify(fixture));
  const bytes = await fs.readFile(first), stamp = (await fs.stat(first)).mtimeMs;
  const hash = createHash('sha256').update(bytes).digest('hex');
  const analyzer = createAnalyzerService({ roots: [temporary] });
  await check('Report and source evidence', async () => {
    const report = await analyzer.report({ path: first });
    ensure(report.schemaVersion === 'wing-session-report.v1' && report.evidence.sha256 === hash, 'Report identity mismatch.');
  });
  await check('Semantic comparison', async () => {
    const compared = await analyzer.compare({ before: first, after: second });
    ensure(compared.total === 1 && compared.items[0].pointer === '/ae_data/ch/1/eq/1g', 'Expected EQ change was not reported.');
  });
  await check('Batch partial failure and inventory duplicates', async () => {
    const batch = await analyzer.batch({ paths: [first, path.join(temporary, 'missing.snap')] });
    const index = await analyzer.index({ paths: [first, first] });
    ensure(batch.summary.failed === 1 && index.duplicates.length === 1, 'Batch or duplicate accounting failed.');
  });
  await check('Complete local report package', async () => {
    const manifest = await createReportPack({ inputs: [second], baseline: first, output: path.join(temporary, 'report-package') });
    ensure(manifest.complete && manifest.items[0].stages.compare.complete, 'Package did not finish all requested stages.');
  });
  await check('Official MCP SDK and actual stdio server', async () => {
    const [{ Client }, { StdioClientTransport }] = await Promise.all([import('@modelcontextprotocol/sdk/client/index.js'), import('@modelcontextprotocol/sdk/client/stdio.js')]);
    client = new Client({ name: 'wing-readiness-check', version: '0.2.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./wing-session-mcp.mjs', import.meta.url)), '--root', temporary], stderr: 'pipe' });
    await timed(() => client.connect(transport));
    const list = await timed(() => client.listTools());
    ensure(list.tools.length === 14 && list.tools.every(tool => tool.annotations?.readOnlyHint === true), 'Expected 14 read-only tools.');
    const response = await timed(() => client.callTool({ name: 'wing_report', arguments: { path: first } }));
    ensure(!response.isError && response.structuredContent?.result?.evidence?.sha256 === hash, 'MCP report call failed.');
    return `${list.tools.length} read-only tools`;
  });
  await check('Source bytes and modification time preserved', async () => {
    ensure((await fs.readFile(first)).equals(bytes) && (await fs.stat(first)).mtimeMs === stamp, 'The synthetic source changed.');
  });
} catch (error) { checks.push({ name: 'Readiness setup', status: 'fail', error: String(error.message || error).slice(0, 1024) }); }
finally {
  try { await client?.close(); } catch { /* Report test failures above, then remove only temporary fixtures. */ }
  if (temporary) await fs.rm(temporary, { recursive: true, force: true });
}
const ok = checks.length >= 7 && checks.every(result => result.status === 'pass');
process.stdout.write(JSON.stringify({ ok, version: '0.2.0', scope: 'Synthetic local files and MCP stdio only; no console, network discovery or real session validation.', checks, ...(!ok ? { nextStep: 'Confirm Node.js >=20 and run npm ci in this repository, then repeat this command.' } : {}) }, null, 2) + '\n');
process.exitCode = ok ? 0 : 1;
