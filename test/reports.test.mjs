import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSessionReport, compareSessions, renderMarkdownReport } from '../skills/wing-session-analyzer/scripts/lib/reports.mjs';
import { parseWingDocument } from '../skills/wing-session-analyzer/scripts/lib/analysis.mjs';

function snapshot() {
  return {
    type: 'snapshot.11', created: 'synthetic-before',
    ae_data: {
      ch: {
        '1': {
          name: 'Presenter', clink: false, mute: true, fdr: -144,
          in: { conn: { grp: 'LCL', in: 1, altgrp: 'USB', altin: 2 }, set: { srcauto: false, altsrc: false } },
          flt: { lc: true, lcf: 100 }, eq: { on: false, mdl: 'STD', '1f': 250, '1g': -3, '1q': 1 },
          main: { '1': { on: true, lvl: 0 } },
        },
        '2': { name: 'Panel', clink: false, mute: false, fdr: -5, eq: { on: true, mdl: 'UNVERIFIED_MODEL', '1g': -12 } },
      },
      main: { '1': { name: 'Room', mute: false, fdr: -3 } },
      io: { in: { LCL: { '1': { name: 'Lectern', mode: 'M' } }, USB: { '2': { name: 'Playback', mode: 'S' } } }, out: { LCL: { '7': { grp: 'MAIN', in: 1 } } } },
    },
    ce_data: {},
  };
}

test('session report keeps real stored settings, source selection, bypass state and pointer evidence', () => {
  const original = snapshot(), frozen = JSON.stringify(original);
  const report = buildSessionReport(original, { kind: 'ch', limit: 1 });
  assert.equal(report.schemaVersion, 'wing-session-report.v1');
  assert.equal(report.overview.channels.ch.slotsPresent, 2);
  assert.equal(report.overview.channels.ch.usedChannels, null);
  assert.equal(report.channels.total, 2);
  assert.equal(report.channels.items.length, 1);
  assert.equal(report.channels.hasMore, true);
  const host = report.channels.items[0];
  assert.deepEqual(host.source.effective.reference, { group: 'LCL', number: 1 });
  const eq = host.processing.find(section => section.key === 'eq');
  assert.equal(eq.enabled.value, false);
  assert.equal(eq.semanticCoverage, 'STD_parameter_summary');
  const gain = eq.parameters.find(parameter => parameter.key === '1g');
  assert.equal(gain.value, -3);
  assert.equal(gain.unit, 'dB');
  assert.equal(gain.sourcePointer, '/ae_data/ch/1/eq/1g');
  assert.equal(host.processing.find(section => section.key === 'dyn').exists, false);
  assert.equal(host.routes.audibleOutput, 'not_determined');
  assert.equal(host.routes.direct.items[0].destination, 'main:1');
  assert.equal(host.routes.direct.items[0].level.value, 0);
  assert.equal(host.routes.unresolved.byCode.OUTPUT_SOURCE_INDEX_UNVERIFIED, 1);
  assert.equal(Object.hasOwn(host.routes.unresolved.items[0], 'raw'), false);
  assert.equal(JSON.stringify(original), frozen);
});

test('report does not interpret unknown EQ models or substitute defaults for missing fields', () => {
  const report = buildSessionReport(snapshot(), { kind: 'ch', offset: 1, limit: 1 });
  const channel = report.channels.items[0];
  const eq = channel.processing.find(section => section.key === 'eq');
  assert.equal(eq.model.value, 'UNVERIFIED_MODEL');
  assert.equal(eq.semanticCoverage, 'raw_model_parameters');
  assert.equal(eq.parameters.length, 0);
  assert.deepEqual(eq.otherParameters.keys, ['1g']);
  const filters = channel.processing.find(section => section.key === 'flt');
  assert.equal(filters.exists, false);
  assert.equal(filters.sourcePointer, '/ae_data/ch/2/flt');
  assert.equal(channel.source.selected, 'unknown');
});

test('finding summaries cover the entire document rather than just the displayed page', () => {
  const source = snapshot();
  source.ae_data.ch['2'].in = structuredClone(source.ae_data.ch['1'].in);
  source.ae_data.ch['2'].main = { '2': { on: true } };
  const report = buildSessionReport(source, { limit: 1 });
  assert.equal(report.findings.items.length, 1);
  assert.ok(report.findings.total > report.findings.items.length);
  assert.equal(report.findings.summary.total, report.findings.total);
  assert.equal(report.findings.summary.byCode.DUPLICATE_SELECTED_INPUT, 1);
  assert.equal(report.findings.summary.countsScope, 'entire-document');
});

test('show and preset reports preserve their actual data scope without fabricating channels', () => {
  const show = buildSessionReport({ type: 'showfile.1', scenes: { count: 2, '1': { name: 'Intro', file: 'intro.snap' }, '2': { name: 'Panel', file: 'panel.snip' } } }, { limit: 1 });
  assert.equal(show.channels.total, 0);
  assert.equal(show.scenes.total, 2);
  assert.equal(show.scenes.items[0].fileFact.value, 'intro.snap');
  assert.equal(show.scenes.items[0].referenceStatus, 'not_checked');
  assert.equal(Object.hasOwn(show.scenes.items[0], 'raw'), false);
  const preset = buildSessionReport({ type: 'chpreset.11', source_channel: 'ch:4', ch_data: { eq: { mdl: 'STD', on: true, '1g': -2 } } });
  assert.equal(preset.channels.total, 0);
  assert.equal(preset.preset.sourceChannel.value, 'ch:4');
  assert.equal(preset.preset.processing.find(item => item.key === 'eq').parameters.find(item => item.key === '1g').sourcePointer, '/ch_data/eq/1g');
  const fx = buildSessionReport({ type: 'fxpreset.11', source_fx_engine: 1, fx_data: { mdl: 'UNKNOWN_FX', mix: 50 } });
  assert.equal(fx.preset.data.semanticCoverage, 'raw_model_parameters');
});

test('comparison groups meaningful changes while retaining metadata, absent/null and bypassed EQ data', () => {
  const before = snapshot(), after = structuredClone(before);
  after.created = 'synthetic-after';
  after.ae_data.ch['1'].eq['1g'] = -6;
  after.ae_data.ch['1'].mute = false;
  after.ae_data.ch['1'].preins = null;
  const comparison = compareSessions(before, after, { limit: 2 });
  assert.equal(comparison.schemaVersion, 'wing-session-comparison.v1');
  assert.equal(comparison.total, 4);
  assert.equal(comparison.items.length, 2);
  assert.equal(comparison.summary.totalChanges, 4);
  const group = comparison.summary.groups.find(item => item.key === 'ch:1');
  assert.equal(group.changes, 3);
  assert.deepEqual(group.categories, { processing: 2, control: 1 });
  const all = compareSessions(before, after, { limit: 10 });
  const gain = all.items.find(item => item.pointer.endsWith('/eq/1g'));
  assert.equal(gain.label, 'EQ band 1 gain (dB)');
  assert.equal(gain.groupLabel, 'CH 1 (stored name: Presenter)');
  assert.equal(gain.before, -3);
  assert.equal(gain.after, -6);
  const insert = all.items.find(item => item.pointer.endsWith('/preins'));
  assert.equal(insert.beforeExists, false);
  assert.equal(insert.afterExists, true);
  assert.equal(insert.after, null);
  assert.equal(all.summary.categories.metadata, 1);
  assert.equal(compareSessions(before, after, { ignoreMetadata: true }).total, 3);
});

test('complete comparison summaries include changes beyond the first 1000 records', () => {
  const before = { type: 'snapshot.11', ae_data: {}, custom: {} }, after = structuredClone(before);
  for (let index = 0; index < 1205; index++) { before.custom[`k${index}`] = 0; after.custom[`k${index}`] = 1; }
  const comparison = compareSessions(before, after, { offset: 1200, limit: 2 });
  assert.equal(comparison.total, 1205);
  assert.equal(comparison.summary.totalChanges, 1205);
  assert.equal(comparison.summary.groups.find(item => item.key === 'custom').changes, 1205);
  assert.equal(comparison.items.length, 2);
  assert.equal(comparison.hasMore, true);
});

test('model-specific EQ labels remain raw when models are not both STD', () => {
  const before = snapshot(), after = structuredClone(before);
  after.ae_data.ch['2'].eq['1g'] = -1;
  const comparison = compareSessions(before, after);
  assert.equal(comparison.items[0].label, '/ae_data/ch/2/eq/1g');
  assert.equal(comparison.items[0].category, 'processing');
});

test('different document kinds are identified as a structural rather than equivalent-state comparison', () => {
  const comparison = compareSessions(snapshot(), { type: 'snippet.11', ae_data: { ch: { '1': { mute: false } } } });
  assert.ok(comparison.limitations.some(value => value.includes('Document kinds differ')));
});

test('renamed channels retain both explicitly stored names in comparison groups', () => {
  const before = snapshot(), after = structuredClone(before);
  after.ae_data.ch['1'].name = 'Host';
  const comparison = compareSessions(before, after);
  assert.equal(comparison.items[0].groupLabel, 'CH 1 (stored name: Presenter → Host)');
  assert.equal(comparison.summary.groups[0].channel.beforeName.value, 'Presenter');
  assert.equal(comparison.summary.groups[0].channel.afterName.value, 'Host');
});

test('a realistic fully populated synthetic console uses bounded default report detail', () => {
  const source = snapshot();
  const strip = {
    ...source.ae_data.ch['1'],
    flt: { lc: true, lcf: 100, lcs: '24', hc: false, hcf: 10000, hcs: '12', tf: false, mdl: 'TILT', tilt: 0 },
    eq: { mdl: 'STD', on: false, mix: 100, lf: 80, lg: 0, lq: 1, leq: 'SHV', '1f': 250, '1g': -2, '1q': 1, '2f': 600, '2g': 0, '2q': 1, '3f': 1500, '3g': 0, '3q': 1, '4f': 4000, '4g': 0, '4q': 1, hf: 12000, hg: 0, hq: 1, heq: 'SHV' },
    gate: { mdl: 'GATE', on: false, mix: 100, gain: 0, thr: -40, range: 40, att: 10, hld: 10, rel: 200, ratio: '1:3' },
    dyn: { mdl: 'COMP', on: false, mix: 100, gain: 0, thr: -10, ratio: 3, knee: 3, det: 'RMS', att: 50, hld: 20, rel: 150, env: 'LOG', auto: true },
    preins: { on: false, ins: 'NONE' }, postins: { on: false, mode: 'FX', ins: 'NONE', w: 0 },
  };
  for (const [kind, count] of [['ch', 40], ['aux', 8], ['bus', 16], ['main', 4], ['mtx', 8], ['dca', 16], ['mgrp', 8]]) {
    source.ae_data[kind] = Object.fromEntries(Array.from({ length: count }, (_, index) => [String(index + 1), { ...structuredClone(strip), name: `Synthetic ${kind} ${index + 1}` }]));
  }
  const report = buildSessionReport(source);
  assert.equal(report.channels.items.length, 10);
  assert.equal(report.channels.total, 100);
  assert.equal(report.channels.hasMore, true);
  assert.ok(Buffer.byteLength(JSON.stringify(report)) < 256 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(report, null, 2)) < 256 * 1024);
});

test('Markdown rendering escapes untrusted names, HTML, links, pipes, fences and multiline headings', () => {
  const source = snapshot();
  source.ae_data.ch['1'].name = '<script>alert(1)</script>|\n# injected\n```\n[link](https://invalid.example)';
  const report = buildSessionReport(parseWingDocument(source));
  report.evidence = { path: '/tmp/<unsafe>|\n# injected.snap', sha256: 'a'.repeat(64), bytes: 123 };
  const markdown = renderMarkdownReport(report);
  assert.ok(markdown.includes('a'.repeat(64)));
  assert.ok(markdown.includes('&lt;script&gt;'));
  assert.equal(markdown.includes('<script>'), false);
  assert.equal(markdown.includes('\n# injected'), false);
  assert.equal(markdown.includes('```'), false);
  assert.ok(markdown.includes('&#96;&#96;&#96;'));
  assert.ok(markdown.includes('https&#58;//invalid\\.example'));
  assert.equal(markdown.includes('[link](https://invalid.example)'), false);
  assert.ok(markdown.includes('not in document'));
  assert.ok(markdown.includes('/ae\\_data/ch/1/eq/1g'));
});

test('Markdown comparison and mixed-success batch expose complete counts, paging and errors', () => {
  const before = snapshot(), after = structuredClone(before);
  after.ae_data.ch['1'].preins = null;
  const comparison = compareSessions(before, after);
  comparison.evidence = { before: { path: '/tmp/a.snap', sha256: '1'.repeat(64) }, after: { path: '/tmp/b.snap', sha256: '2'.repeat(64) } };
  const comparisonText = renderMarkdownReport(comparison);
  assert.ok(comparisonText.includes('MISSING'));
  assert.ok(comparisonText.includes('null'));
  assert.ok(comparisonText.includes('1'.repeat(64)));
  const batch = {
    schemaVersion: 'wing-session-batch.v1', summary: { total: 2, examined: 2, succeeded: 1, failed: 1 }, countsScope: 'returned-page',
    items: [{ path: '/tmp/a.snap', status: 'ok', report: buildSessionReport(before) }, { path: '/tmp/<bad>.snap', status: 'error', error: { code: 'INVALID_JSON', message: '<script>not JSON</script>' } }],
    total: 2, offset: 0, limit: 2, hasMore: false,
  };
  const text = renderMarkdownReport(batch);
  assert.ok(text.includes('examined'));
  assert.ok(text.includes('returned\\-page'));
  assert.ok(text.includes('INVALID\\_JSON'));
  assert.equal(text.includes('<script>'), false);
});

test('report inputs and schemas fail clearly instead of silently dropping requested detail', () => {
  assert.throws(() => buildSessionReport(snapshot(), { limit: 0 }), { code: 'INVALID_PAGE' });
  assert.throws(() => compareSessions(snapshot(), snapshot(), { offset: -1 }), { code: 'INVALID_PAGE' });
  assert.throws(() => renderMarkdownReport({ schemaVersion: 'unknown' }), { code: 'UNSUPPORTED_REPORT' });
});
