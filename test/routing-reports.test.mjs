import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSessionReport, renderMarkdownReport } from '../skills/wing-session-analyzer/scripts/lib/reports.mjs';
import { traceRoutes } from '../skills/wing-session-analyzer/scripts/lib/analysis.mjs';

function document() {
  return { type: 'snapshot.11', creator_name: 'Synthetic report route integration fixture', ae_data: {
    ch: {
      '1': { name: 'HOST', clink: false, mute: false, fdr: -6, ptap: '5',
        in: { conn: { grp: 'LCL', in: 1, altgrp: 'USB', altin: 1 }, set: { srcauto: false, altsrc: false } },
        main: { '1': { on: true, lvl: -3, pre: false } } },
      '2': { name: 'Standby', clink: false, mute: false, fdr: 0,
        in: { conn: { grp: 'LCL', in: 2, altgrp: 'USR', altin: 1 }, set: { srcauto: false, altsrc: false } },
        main: { '2': { on: true, lvl: 0 } } },
    },
    main: { '1': { name: 'Room', mute: false, fdr: 0, send: { MX8: { on: true, lvl: 0 } } },
      '2': { name: 'Standby output', mute: false, fdr: 0 } },
    mtx: { '8': { name: 'Delay', mute: false, fdr: 0 } },
    io: {
      in: {
        LCL: { '1': { name: 'Lectern', mode: 'M' }, '2': { name: 'Spare', mode: 'M' } },
        USB: { '1': { name: 'Playback', mode: 'M' } },
        USR: { '1': { name: 'HOST selected tap', mode: 'M', user: { grp: 'CH', in: 1, tap: 'PRE', lr: 'R' } } },
      },
      out: { USB: {
        '1': { grp: 'USR', in: 1 }, '2': { grp: 'MAIN', in: 1 }, '3': { grp: 'MTX', in: 16 },
        '4': { grp: 'LCL', in: 1 }, '5': { grp: 'MAIN', in: 4 },
      } },
    },
  } };
}

test('reports separate immediate sends, traced output patches and candidate-only context nodes', () => {
  const source = document(), original = JSON.stringify(source);
  const graph = traceRoutes(source, { kind: 'ch', number: 1 });
  const report = buildSessionReport(source, { kind: 'ch', limit: 1 });
  const route = report.channels.items[0].routes;
  assert.equal(route.reachableNodes, graph.nodes.filter(node => node.contextOnly !== true).length);
  assert.equal(route.contextNodes, graph.nodes.filter(node => node.contextOnly === true).length);
  assert.ok(route.contextNodes > 0);
  assert.ok(route.reachableNodes < graph.nodes.length);
  assert.deepEqual(route.direct.items.map(item => [item.kind, item.destination]), [['main', 'main:1']]);
  assert.equal(route.direct.items[0].level.value, -3);
  assert.equal(route.direct.items[0].level.sourcePointer, '/ae_data/ch/1/main/1/lvl');
  assert.equal(route.outputs.total, 3);
  assert.deepEqual(route.outputs.items.map(output => [output.bank, output.number, output.side]), [['USB', 1, null], ['USB', 2, 'L'], ['USB', 3, 'R']]);
  assert.equal(route.outputs.hasMore, false);
  assert.equal(route.outputs.countsScope, 'traced-downstream-patches');
  assert.equal(route.outputs.items.some(output => [4, 5].includes(output.number)), false, 'passthrough and unselected alternate branches are not HOST downstream outputs');
  assert.equal(route.coverage.physicalOutputMapping, 'verified_source_groups_only');
  assert.equal(route.audibleOutput, 'not_determined');
  assert.equal(JSON.stringify(source), original);
  const main = buildSessionReport(source, { kind: 'main', limit: 1 }).channels.items[0];
  assert.deepEqual(main.routes.direct.items.map(item => [item.kind, item.destination]), [['send', 'mtx:8']]);
  assert.ok(main.routes.outputs.total > 0);
});

test('User Signal summaries retain raw tap/side evidence without replacing it with inferred fader semantics', () => {
  const report = buildSessionReport(document(), { kind: 'ch', limit: 1 });
  const output = report.channels.items[0].routes.outputs.items[0];
  assert.deepEqual(output.raw, { grp: 'USR', in: 1 });
  assert.equal(output.sourcePointer, '/ae_data/io/out/USB/1');
  assert.equal(output.source, 'input:USR:1');
  assert.equal(output.side, null, 'USR patch selection itself has no encoded stereo side');
  assert.equal(output.userSignal.source, 'ch:1');
  assert.deepEqual(output.userSignal.raw, { grp: 'CH', in: 1, tap: 'PRE', lr: 'R' });
  assert.equal(output.userSignal.sourcePointer, '/ae_data/io/in/USR/1/user');
  assert.equal(output.userSignal.tapInterpretation, 'stored_channel_tap');
  assert.equal(output.userSignal.channelTap.value, '5');
  assert.equal(output.userSignal.channelTap.sourcePointer, '/ae_data/ch/1/ptap');
  const text = renderMarkdownReport(report);
  assert.match(text, /USB 1/);
  assert.match(text, /USR 1/);
  assert.match(text, /User Signal assignment/);
  assert.match(text, /"tap"&#58;"PRE"/);
  assert.match(text, /"lr"&#58;"R"/);
  assert.match(text, /io\/in\/USR\/1\/user/);
  assert.doesNotMatch(text, /pre[- ]fader/i);
  assert.doesNotMatch(text, /Enabled to (?:input|output)/);
});

test('output samples are bounded while complete counts and codec status remain explicit', () => {
  const source = document();
  source.ae_data.io.out.USB = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [index + 1, { grp: 'MAIN', in: index % 2 + 1 }]));
  source.ae_data.io.out.USB['13'] = { grp: 'MON', in: 1 };
  const report = buildSessionReport(source, { kind: 'main', limit: 1 });
  const routes = report.channels.items[0].routes;
  assert.equal(routes.outputs.total, 12);
  assert.equal(routes.outputs.maxSamples, 3);
  assert.equal(routes.outputs.items.length, 3);
  assert.equal(routes.outputs.hasMore, true);
  assert.equal(report.sections.routing.outputPatches.total, 13);
  assert.equal(report.sections.routing.outputPatches.byStatus.decoded, 12);
  assert.equal(report.sections.routing.outputPatches.byStatus.unsupported_group, 1);
  assert.equal(report.sections.routing.outputPatches.countsScope, 'entire-document');
  const text = renderMarkdownReport(report);
  assert.match(text, /3 shown; total 12; hasMore true/);
  assert.match(text, /Recorded output patches across the entire document: 13/);
  assert.match(text, /More traced patches exist/);
});

test('unsupported layouts retain the routing coverage boundary in JSON and Markdown', () => {
  const source = document();
  source.type = 'snapshot.12';
  const report = buildSessionReport(source, { kind: 'ch', limit: 1 });
  assert.equal(report.sections.routing.supportedType, false);
  assert.equal(report.sections.routing.physicalOutputMapping, 'unsupported_layout');
  assert.equal(report.channels.items[0].routes.outputs.total, 0);
  assert.match(renderMarkdownReport(report), /unsupported\\_layout/);
  const show = buildSessionReport({ type: 'showfile.1', scenes: { count: 0 } });
  assert.equal(show.sections.routing.physicalOutputMapping, 'unsupported_layout');
});

test('output names remain data when rendered in Markdown', () => {
  const source = document();
  source.ae_data.io.out = { '<sink>|\n# forged': { '1': { grp: 'MAIN', in: 1 } } };
  const report = buildSessionReport(source, { kind: 'ch', limit: 1 });
  const text = renderMarkdownReport(report);
  assert.ok(text.includes('&lt;sink&gt;'));
  assert.doesNotMatch(text, /<sink>|\n# forged/);
  assert.equal(report.channels.items[0].routes.outputs.items[0].bank, '<sink>|\n# forged');
});
