import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWingDocument, traceRoutes, traceOutputRoutes, getChannel } from '../skills/wing-session-analyzer/scripts/lib/analysis.mjs';
import { decodeRoutingSource } from '../skills/wing-session-analyzer/scripts/lib/routing.mjs';

// Handcrafted analysis data. The selectors/fields are grounded in native 3.3.4
// observations, not a complete snapshot to load or a hardware/audio fixture.
function make() {
  return { type: 'snapshot.11', ae_data: {
    ch: {
      '1': { name: 'Insert owner', mon: 'A', preins: { ins: 'FX1', on: false },
        in: { conn: { grp: 'LCL', in: 1 }, set: { srcauto: false, altsrc: false } } },
      '2': { name: 'Unassigned', mon: 'A' },
      '40': { name: 'Monitor direct input' },
    },
    aux: { '8': { name: 'Processed AUX' } },
    bus: { '16': { name: 'Monitor bus source' } },
    main: { '2': { name: 'Phones source' }, '4': { name: 'Speakers source' } },
    mtx: { '1': { name: 'Matrix' }, '8': { name: 'Last matrix' } },
    fx: { '1': { mdl: 'NONE', fxmix: 100 }, '16': { mdl: 'NONE', fxmix: 100 } },
    cfg: {
      mon: {
        '1': { src: 'MAIN.2', dirin: 'CH.40', srclvl: 0, srcmix: -144, lvl: -144 },
        '2': { src: 'MAIN.4', dirin: 'OFF', srclvl: -6, srcmix: -12, lvl: -30 },
      },
      solo: { mode: 'LIVE', mon: 'PH', mute: false, chtap: 'PFL', bustap: 'AFL', srcsolo: 'CH39' },
    },
    io: {
      in: { LCL: { '1': { name: 'Physical input' } } },
      out: { LCL: {
        '1': { grp: 'SEND', in: 1 }, '2': { grp: 'SEND', in: 2 }, '3': { grp: 'SEND', in: 32 },
        '4': { grp: 'MON', in: 1 }, '5': { grp: 'MON', in: 2 }, '6': { grp: 'MON', in: 3 }, '7': { grp: 'MON', in: 4 },
        '8': { grp: 'MTX', in: 1 },
      } },
    },
  } };
}
const output = (doc, number, maxDepth = 8) => traceOutputRoutes(doc, { bank: 'LCL', number, maxDepth });
const patch = (graph, number) => graph.edges.find(edge => edge.kind === 'output_patch' && edge.to === `output:LCL:${number}`);
const traversed = (graph, id) => graph.nodes.some(node => node.id === id && node.contextOnly === false);

test('SEND and MON side selectors resolve to their actual virtual metadata namespaces', () => {
  const doc = parseWingDocument(make());
  for (const [group, index, kind, number, side, pointer] of [
    ['SEND', 1, 'fx_send', 1, 'L', '/ae_data/fx/1'], ['SEND', 2, 'fx_send', 1, 'R', '/ae_data/fx/1'],
    ['SEND', 3, 'fx_send', 2, 'L', '/ae_data/fx/2'], ['SEND', 31, 'fx_send', 16, 'L', '/ae_data/fx/16'], ['SEND', 32, 'fx_send', 16, 'R', '/ae_data/fx/16'],
    ['MON', 1, 'monitor', 1, 'L', '/ae_data/cfg/mon/1'], ['MON', 2, 'monitor', 1, 'R', '/ae_data/cfg/mon/1'],
    ['MON', 3, 'monitor', 2, 'L', '/ae_data/cfg/mon/2'], ['MON', 4, 'monitor', 2, 'R', '/ae_data/cfg/mon/2'],
  ]) {
    const decoded = decodeRoutingSource(doc, { grp: group, in: index }, '/test/output');
    assert.equal(decoded.status, 'decoded');
    assert.equal(decoded.id, `${kind}:${number}`);
    assert.equal(decoded.targetPointer, pointer);
    assert.deepEqual(decoded.reference, { group, kind, number, side, encodedIndex: index });
  }
  assert.equal(decodeRoutingSource(doc, { grp: 'SEND', in: 33 }, '/test/output').status, 'invalid_index');
  assert.equal(decodeRoutingSource(doc, { grp: 'MON', in: 5 }, '/test/output').status, 'invalid_index');
});

test('a configured FX insert owner reaches the send before its processed return even when bypassed', () => {
  const raw = make(), before = JSON.stringify(raw), graph = traceRoutes(raw, { kind: 'ch', number: 1, maxDepth: 0 });
  const assigned = graph.edges.find(edge => edge.kind === 'fx_send');
  assert.equal(assigned.from, 'ch:1');
  assert.equal(assigned.to, 'fx_send:1');
  assert.equal(assigned.configured, true);
  assert.equal(assigned.insertEnabled.exists, true);
  assert.equal(assigned.insertEnabled.value, false);
  assert.equal(assigned.insertEnabled.sourcePointer, '/ae_data/ch/1/preins/on');
  assert.deepEqual(assigned.raw, { ins: 'FX1', on: false });
  assert.equal(assigned.ownershipScope, 'recorded-document-assignments');
  assert.equal(patch(graph, 1).side, 'L');
  assert.equal(patch(graph, 2).side, 'R');
  assert.equal(patch(graph, 3), undefined);
  assert.equal(graph.nodes.find(node => node.id === 'fx_send:1').routingRole, 'configured_insert_send_not_processed_return');
  assert.equal(graph.nodes.some(node => node.kind === 'fx_return'), false);
  assert.equal(graph.audibleOutput, 'not_determined');
  const reverse = output(raw, 2, 0);
  assert.deepEqual(reverse.edges.find(edge => edge.kind === 'fx_send'), assigned);
  assert.equal(traversed(reverse, 'ch:1'), true);
  assert.equal(traversed(reverse, 'input:LCL:1'), true);
  assert.equal(JSON.stringify(raw), before);
});

test('FX owner selectors cover supported strip families and preserve position without inventing AUX post inserts', () => {
  for (const [kind, number, position, extra] of [
    ['ch', 2, 'postins', { mode: 'FX' }], ['aux', 8, 'preins', {}], ['bus', 16, 'postins', {}], ['main', 4, 'preins', {}], ['mtx', 8, 'postins', {}],
  ]) {
    const raw = make(); raw.ae_data[kind][number][position] = { ins: 'FX16', on: true, ...extra };
    const forward = traceRoutes(raw, { kind, number, maxDepth: 0 }), reverse = output(raw, 3, 0);
    const edge = reverse.edges.find(edge => edge.kind === 'fx_send');
    assert.equal(edge.from, `${kind}:${number}`);
    assert.equal(edge.position, position);
    assert.equal(edge.sourcePointer, `/ae_data/${kind}/${number}/${position}`);
    assert.equal(patch(forward, 3).from, 'fx_send:16');
    assert.equal(patch(forward, 3).side, 'R');
  }
  const raw = make(); raw.ae_data.aux['8'].postins = { ins: 'FX16', on: true };
  const graph = traceRoutes(raw, { kind: 'aux', number: 8 });
  assert.equal(patch(graph, 3), undefined);
  assert.ok(graph.unresolved.some(issue => issue.code === 'INSERT_POSITION_UNVERIFIED'));
  raw.ae_data.ch['41'] = { preins: { ins: 'FX16', on: true } };
  const outside = traceRoutes(raw, { kind: 'ch', number: 41 });
  assert.equal(patch(outside, 3), undefined);
  assert.ok(outside.unresolved.some(issue => issue.code === 'INSERT_STRIP_RANGE_UNVERIFIED'));
});

test('duplicate FX assignments remain unresolved candidate context rather than falsely summing owners', () => {
  const raw = make(); raw.ae_data.ch['2'].postins = { ins: 'FX1', on: true, mode: 'FX' };
  const reverse = output(raw, 1);
  assert.equal(reverse.edges.some(edge => edge.kind === 'fx_send'), false);
  const candidates = reverse.edges.filter(edge => edge.kind === 'fx_send_candidate');
  assert.equal(candidates.length, 2);
  assert.ok(candidates.every(edge => edge.traversed === false && edge.selected === null));
  assert.equal(traversed(reverse, 'ch:1'), false);
  assert.equal(traversed(reverse, 'ch:2'), false);
  assert.equal(traversed(reverse, 'input:LCL:1'), false);
  assert.ok(reverse.unresolved.some(issue => issue.code === 'FX_SEND_OWNER_AMBIGUOUS' && issue.candidateCount === 2));
  for (const number of [1, 2]) {
    const forward = traceRoutes(raw, { kind: 'ch', number });
    assert.equal(patch(forward, 1), undefined);
    assert.equal(patch(forward, 2), undefined);
    assert.equal(forward.nodes.find(node => node.id === 'fx_send:1').contextOnly, true);
  }
});

test('missing channel postinsert mode stays a candidate and known automix mode cannot supply an FX send', () => {
  const raw = make(); raw.ae_data.ch['2'].postins = { ins: 'FX16', on: true };
  let graph = output(raw, 3);
  assert.ok(graph.unresolved.some(issue => issue.code === 'FX_SEND_OWNER_MODE_UNRESOLVED'));
  assert.equal(traversed(graph, 'ch:2'), false);
  raw.ae_data.ch['2'].postins.mode = 'AUTO_X';
  graph = output(raw, 3);
  assert.equal(graph.edges.some(edge => edge.kind === 'fx_send' || edge.kind === 'fx_send_candidate'), false);
  assert.ok(graph.unresolved.some(issue => issue.code === 'FX_SEND_OWNER_NOT_IN_DOCUMENT'));
  assert.ok(traceRoutes(raw, { number: 2 }).unresolved.some(issue => issue.code === 'INSERT_NOT_FX_MODE'));
  raw.ae_data.ch['2'].postins.mode = 'unrecognized';
  raw.ae_data.ch['1'].preins.ins = 'FX16';
  graph = output(raw, 3);
  assert.ok(graph.unresolved.some(issue => issue.code === 'FX_SEND_OWNER_AMBIGUOUS'));
  assert.equal(graph.edges.some(edge => edge.kind === 'fx_send'), false, 'an unknown possible owner prevents claiming the other owner is unique');
});

test('monitor outputs retain both configured selectors and separate source/mix/monitor levels', () => {
  const raw = make(), reverse = output(raw, 4);
  assert.equal(patch(reverse, 4).from, 'monitor:1');
  assert.equal(patch(reverse, 4).side, 'L');
  const monitor = reverse.nodes.find(node => node.id === 'monitor:1');
  assert.equal(monitor.label, 'PHONES');
  assert.equal(monitor.sourcePointer, '/ae_data/cfg/mon/1');
  assert.equal(monitor.runtimeSelection, 'not_determined');
  assert.equal(monitor.levels.sourceLevel.value, 0);
  assert.equal(monitor.levels.sourceMix.value, -144);
  assert.equal(monitor.levels.monitorLevel.value, -144);
  assert.equal(monitor.soloContext.srcsolo.value, 'CH39');
  assert.equal(monitor.soloContext.srcsolo.sourcePointer, '/ae_data/cfg/solo/srcsolo');
  assert.ok(reverse.edges.some(edge => edge.kind === 'monitor_source' && edge.from === 'main:2' && edge.raw === 'MAIN.2'));
  assert.ok(reverse.edges.some(edge => edge.kind === 'monitor_direct_input' && edge.from === 'ch:40' && edge.raw === 'CH.40'));
  assert.ok(reverse.unresolved.some(issue => issue.code === 'MONITOR_RUNTIME_STATE_UNKNOWN'));
  assert.equal(reverse.nodes.some(node => node.id === 'ch:39'), false, 'saved srcsolo does not identify a live contribution');
  assert.equal(reverse.nodes.some(node => node.id === 'ch:1'), false, 'strip mon:A does not imply it is being soloed');
  assert.equal(reverse.nodes.some(node => node.id === 'monitor:2'), false);
  assert.equal(reverse.nodes.some(node => node.id.startsWith('input:MON:')), false);
  for (const [kind, number] of [['main', 2], ['ch', 40]]) {
    const forward = traceRoutes(raw, { kind, number, maxDepth: 0 });
    assert.equal(patch(forward, 4).from, 'monitor:1');
    assert.equal(patch(forward, 5).side, 'R');
    assert.equal(patch(forward, 6), undefined);
  }
});

test('monitor selector indices are logical strip numbers and AUX is the processed channel namespace', () => {
  const raw = make(); raw.ae_data.cfg.mon['1'].src = 'AUX.8'; raw.ae_data.cfg.mon['1'].dirin = 'BUS.16';
  const reverse = output(raw, 4);
  assert.ok(reverse.edges.some(edge => edge.kind === 'monitor_source' && edge.from === 'aux:8'));
  assert.ok(reverse.edges.some(edge => edge.kind === 'monitor_direct_input' && edge.from === 'bus:16'));
  assert.equal(reverse.nodes.some(node => node.id === 'input:AUX:8'), false);
  assert.equal(reverse.nodes.some(node => node.id === 'bus:8'), false);
  for (const [selector, token] of [['src', 'CH.1'], ['src', 'MAIN.5'], ['dirin', 'CH.41'], ['dirin', 'USB.1'], ['src', 'BUS.0']]) {
    const next = make(); next.ae_data.cfg.mon['1'][selector] = token;
    assert.ok(output(next, 4).unresolved.some(issue => issue.code === 'MONITOR_SOURCE_TOKEN_UNRESOLVED' && issue.raw === token));
  }
});

test('matrix PHONES and SPEAKERS share monitor nodes while MON.BUS remains a distinct runtime boundary', () => {
  for (const [token, number] of [['MON.PH', 1], ['MON.SPK', 2]]) {
    const raw = make(); raw.ae_data.mtx['1'].dir = { on: true, in: token, lvl: -9 };
    const reverse = output(raw, 8);
    assert.ok(reverse.edges.some(edge => edge.kind === 'matrix_direct_input' && edge.from === `monitor:${number}` && edge.to === 'mtx:1'));
    assert.equal(reverse.nodes.some(node => node.kind === 'direct_input_source' && node.token === token), false);
    assert.ok(reverse.unresolved.some(issue => issue.code === 'MONITOR_RUNTIME_STATE_UNKNOWN'));
  }
  const raw = make(); raw.ae_data.mtx['1'].dir = { on: true, in: 'MON.BUS', lvl: -9 };
  const reverse = output(raw, 8);
  assert.ok(reverse.nodes.some(node => node.kind === 'direct_input_source' && node.token === 'MON.BUS'));
  assert.equal(reverse.nodes.some(node => node.kind === 'monitor'), false);
  assert.equal(reverse.nodes.some(node => node.kind === 'ch' || node.kind === 'bus'), false);
  assert.ok(reverse.unresolved.some(issue => issue.code === 'MONITOR_BUS_RUNTIME_STATE_UNKNOWN'));
});

test('missing metadata and OFF monitor selectors do not acquire synthesized defaults or owners', () => {
  const raw = make(); delete raw.ae_data.fx['1']; delete raw.ae_data.cfg.mon['1'];
  assert.equal(output(raw, 1).nodes.find(node => node.id === 'fx_send:1').exists, false);
  assert.ok(output(raw, 1).unresolved.some(issue => issue.code === 'OUTPUT_SOURCE_TARGET_NOT_IN_DOCUMENT'));
  let reverse = output(raw, 4);
  assert.equal(reverse.nodes.find(node => node.id === 'monitor:1').exists, false);
  assert.equal(reverse.edges.some(edge => edge.kind.startsWith('monitor_')), false);
  raw.ae_data.cfg.mon['1'] = { src: 'OFF', dirin: 'OFF' };
  reverse = output(raw, 4);
  assert.equal(reverse.edges.some(edge => edge.kind.startsWith('monitor_')), false);
  assert.equal(reverse.nodes.find(node => node.id === 'monitor:1').levels.sourceLevel.exists, false);
  assert.ok(reverse.unresolved.some(issue => issue.code === 'MONITOR_RUNTIME_STATE_UNKNOWN'));
  raw.ae_data.cfg.mon['1'] = { src: 'MAIN.2' };
  assert.ok(output(raw, 4).unresolved.some(issue => issue.code === 'MONITOR_SELECTOR_NOT_IN_DOCUMENT'));
});

test('special output sources do not broaden channel input or raw User Signal namespaces', () => {
  for (const group of ['SEND', 'MON']) {
    const raw = make(); raw.ae_data.ch['2'].in = { conn: { grp: group, in: 1 }, set: { srcauto: false, altsrc: false } };
    const channel = getChannel(raw, { kind: 'ch', number: 2 }).summary;
    assert.equal(channel.source.primary.decoding.status, 'unsupported_group_for_consumer');
    assert.equal(channel.source.primary.reference, undefined);
    const forward = traceRoutes(raw, { kind: 'ch', number: 2 });
    assert.ok(forward.unresolved.some(issue => issue.status === 'unsupported_group_for_consumer'));
    assert.equal(forward.edges.some(edge => edge.kind === 'input_candidate'), false);
    raw.ae_data.io.in.USR = { '25': { user: { grp: group, in: 1 } } };
    raw.ae_data.io.out.LCL['8'] = { grp: 'USR', in: 25 };
    const reverse = output(raw, 8);
    assert.ok(reverse.unresolved.some(issue => issue.code === 'USER_SIGNAL_ASSIGNMENT_UNRESOLVED'));
    assert.equal(reverse.edges.some(edge => edge.kind === 'user_signal'), false);
  }
});

test('monitor feedback cycles and logical depth remain bounded and leave byte input unchanged', () => {
  const raw = make(); raw.ae_data.cfg.mon['1'].src = 'MTX.1'; raw.ae_data.cfg.mon['1'].dirin = 'OFF';
  raw.ae_data.mtx['1'].dir = { on: true, in: 'MON.PH' };
  raw.ae_data.main['2'].send = { MX1: { on: true, lvl: 0 } };
  const before = JSON.stringify(raw), reverse = output(raw, 4);
  assert.equal(reverse.nodes.filter(node => node.id === 'monitor:1').length, 1);
  assert.equal(reverse.edges.filter(edge => edge.kind === 'monitor_source').length, 1);
  assert.equal(reverse.edges.filter(edge => edge.kind === 'matrix_direct_input').length, 1);
  assert.ok(reverse.nodes.length < 20);
  const shallow = traceRoutes(raw, { kind: 'main', number: 2, maxDepth: 0 });
  assert.equal(patch(shallow, 4), undefined);
  assert.ok(shallow.unresolved.some(issue => issue.code === 'MAX_DEPTH_REACHED'));
  assert.equal(patch(traceRoutes(raw, { kind: 'main', number: 2, maxDepth: 1 }), 4).from, 'monitor:1');
  assert.doesNotThrow(() => JSON.stringify(reverse));
  assert.equal(JSON.stringify(raw), before);
});

test('unverified versions do not expand new special codecs or claim their coverage', () => {
  const raw = make(); raw.type = 'snapshot.12';
  for (const number of [1, 4]) {
    const reverse = output(raw, number);
    assert.equal(reverse.edges.some(edge => edge.kind === 'output_patch'), false);
    assert.equal(reverse.coverage.fxSendSources, 'unsupported_layout');
    assert.equal(reverse.coverage.monitorSources, 'unsupported_layout');
    assert.ok(Object.values(reverse.coverage.evidenceBasis).every(value => value === 'unsupported_layout'));
    assert.ok(reverse.unresolved.some(issue => issue.status === 'unsupported_layout'));
  }
});

test('non-string insert and monitor tokens remain raw unresolved data without coercion or query failure', () => {
  for (const value of [null, { toString: 'FX1' }, { toString: null, valueOf: null }, ['FX1'], 1]) {
    const raw = make(); raw.ae_data.ch['1'].preins.ins = value;
    const before = JSON.stringify(raw);
    const forward = traceRoutes(raw, { kind: 'ch', number: 1 });
    assert.ok(forward.unresolved.some(issue => issue.code === 'INSERT_ASSIGNMENT_UNRESOLVED' && JSON.stringify(issue.raw.ins) === JSON.stringify(value)));
    assert.equal(forward.edges.some(edge => edge.kind === 'fx_send'), false);
    assert.equal(output(raw, 1).edges.some(edge => edge.kind === 'fx_send'), false);
    assert.equal(JSON.stringify(raw), before);
  }
  for (const selector of ['src', 'dirin']) for (const value of [null, { toString: 'MAIN.2' }, { toString: null, valueOf: null }, ['MAIN.2'], 2]) {
    const raw = make(); raw.ae_data.cfg.mon['1'][selector] = value;
    const before = JSON.stringify(raw), reverse = output(raw, 4);
    const kind = selector === 'src' ? 'monitor_source' : 'monitor_direct_input';
    assert.ok(reverse.unresolved.some(issue => issue.code === 'MONITOR_SOURCE_TOKEN_UNRESOLVED' && JSON.stringify(issue.raw) === JSON.stringify(value)));
    assert.equal(reverse.edges.some(edge => edge.kind === kind), false);
    assert.doesNotThrow(() => JSON.stringify(reverse));
    assert.equal(JSON.stringify(raw), before);
  }
});

test('new routing coverage distinguishes sampled saves from static-only ownership and matrix mapping', () => {
  const graph = output(make(), 1);
  assert.deepEqual(graph.coverage.evidenceBasis, {
    sendSelector: 'native-save-samples-and-static-range',
    fxOwnership: 'static-configured-assignments-only',
    monitorSelector: 'native-save-sample-ui-labels-and-static-range',
    monitorDependencies: 'native-saved-samples-and-static-enums',
    matrixMonitorInputs: 'static-token-mapping',
  });
});
