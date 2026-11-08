import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSessionReport, renderMarkdownReport } from '../skills/wing-session-analyzer/scripts/lib/reports.mjs';

// Small analysis-only fixture; no native recall or audio behavior is implied.
function make() {
  return { type: 'snapshot.11', ae_data: {
    ch: {
      '1': { name: 'Host', preins: { ins: 'FX1', on: false }, main: { '4': { on: true, lvl: 0 } } },
      '2': { name: 'Standby' },
    },
    main: { '4': { name: 'Monitor source', mute: true, fdr: -144 } },
    fx: { '1': { mdl: 'NONE', fxmix: 100 } },
    cfg: { mon: { '2': { src: 'MAIN.4', dirin: 'OFF', srclvl: 0, srcmix: -144, lvl: -144 } },
      solo: { mode: 'LIVE', mon: 'PH', mute: false, srcsolo: 'CH39' } },
    io: { out: { USB: {
      '1': { grp: 'SEND', in: 2 },
      '2': { grp: 'MON', in: 3 }, '3': { grp: 'MON', in: 4 },
      '4': { grp: 'MON', in: 1 },
    } } },
  } };
}

test('report output samples distinguish configured FX sends from processed returns and retain bypass evidence', () => {
  const source = make(), original = JSON.stringify(source);
  const report = buildSessionReport(source, { kind: 'ch', limit: 1 });
  const routes = report.channels.items[0].routes;
  const output = routes.outputs.items.find(item => item.number === 1);
  assert.equal(output.source, 'fx_send:1');
  assert.equal(output.side, 'R');
  assert.deepEqual(output.raw, { grp: 'SEND', in: 2 });
  assert.equal(output.virtualSource.kind, 'fx_send');
  assert.equal(output.virtualSource.sourcePointer, '/ae_data/fx/1');
  assert.equal(output.virtualSource.routingRole, 'configured_insert_send_not_processed_return');
  assert.equal(output.virtualSource.insertOwner.source, 'ch:1');
  assert.equal(output.virtualSource.insertOwner.sourcePointer, '/ae_data/ch/1/preins');
  assert.equal(output.virtualSource.insertOwner.insertEnabled.value, false);
  assert.equal(output.virtualSource.insertOwner.insertEnabled.sourcePointer, '/ae_data/ch/1/preins/on');
  assert.deepEqual(routes.direct.items.map(item => item.destination), ['main:4']);
  assert.equal(routes.audibleOutput, 'not_determined');
  const text = renderMarkdownReport(report);
  assert.match(text, /Configured FX insert send, not the processed FX return/);
  assert.match(text, /Stored insert owner ch&#58;1/);
  assert.match(text, /insert enabled false/);
  assert.doesNotMatch(text, /Enabled to fx/);
  assert.equal(JSON.stringify(source), original);
});

test('monitor report samples retain their configuration namespace and explicit runtime uncertainty', () => {
  const report = buildSessionReport(make(), { kind: 'ch', limit: 1 });
  const routes = report.channels.items[0].routes;
  assert.equal(routes.outputs.total, 3, 'only the assigned speaker monitor is a Host downstream dependency');
  const monitor = routes.outputs.items.filter(item => item.virtualSource?.kind === 'monitor');
  assert.deepEqual(monitor.map(item => [item.number, item.side]), [[2, 'L'], [3, 'R']]);
  for (const output of monitor) {
    assert.equal(output.virtualSource.sourcePointer, '/ae_data/cfg/mon/2');
    assert.equal(output.virtualSource.label, 'SPEAKERS');
    assert.equal(output.virtualSource.runtimeSelection, 'not_determined');
  }
  assert.ok(routes.unresolved.byCode.MONITOR_RUNTIME_STATE_UNKNOWN > 0);
  assert.equal(report.sections.routing.monitorSources, 'verified_selectors_configured_dependencies_runtime_unknown');
  assert.equal(report.sections.routing.fxSendSources, 'verified_selectors_configured_insert_owners');
  assert.equal(report.sections.routing.outputPatches.total, 4, 'the shared coverage retains entire-document counts including an unrelated phones patch');
  assert.equal(routes.coverage.reportPointer, '/sections/routing');
  assert.equal(routes.coverage.physicalOutputMapping, report.sections.routing.physicalOutputMapping);
  const text = renderMarkdownReport(report);
  assert.match(text, /Monitor SPEAKERS/);
  assert.match(text, /cfg\/mon\/2/);
  assert.match(text, /live solo and source selection are not determined/);
});

test('ambiguous FX claims remain unresolved context rather than definite reported outputs', () => {
  const source = make();
  source.ae_data.ch['2'].preins = { ins: 'FX1', on: true };
  delete source.ae_data.ch['1'].main;
  const report = buildSessionReport(source, { kind: 'ch', limit: 1 });
  const routes = report.channels.items[0].routes;
  assert.equal(routes.outputs.total, 0);
  assert.equal(routes.outputs.items.length, 0);
  assert.ok(routes.contextNodes > 0);
  assert.equal(routes.unresolved.byCode.FX_SEND_OWNER_AMBIGUOUS, 1);
  assert.equal(routes.unresolved.items.find(item => item.code === 'FX_SEND_OWNER_AMBIGUOUS').candidateCount, 2);
  assert.doesNotMatch(renderMarkdownReport(report), /Stored insert owner ch&#58;1/);
});

test('special-source summaries stay bounded when many channels share monitor patches', () => {
  const source = make();
  source.ae_data.ch = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [index + 1, {
    name: `Synthetic channel ${index + 1}`, main: { '4': { on: true, lvl: 0 } },
    in: { conn: { grp: 'USB', in: index + 1 }, set: { srcauto: false, altsrc: false } },
  }]));
  source.ae_data.io.out.USB = Object.fromEntries(Array.from({ length: 48 }, (_, index) => [index + 1, { grp: 'MON', in: index % 2 + 3 }]));
  const report = buildSessionReport(source);
  assert.equal(report.channels.items.length, 10);
  assert.equal(report.channels.total, 41);
  assert.equal(report.sections.routing.outputPatches.total, 48);
  for (const channel of report.channels.items) {
    assert.equal(channel.routes.outputs.total, 48);
    assert.equal(channel.routes.outputs.items.length, 3);
    assert.equal(channel.routes.outputs.hasMore, true);
    assert.ok(channel.routes.unresolved.byCode.MONITOR_RUNTIME_STATE_UNKNOWN > 0);
  }
  assert.ok(Buffer.byteLength(JSON.stringify(report, null, 2)) < 256 * 1024);
});
