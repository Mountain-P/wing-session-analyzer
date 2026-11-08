import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWingDocument, traceRoutes, traceOutputRoutes, getChannel, analyzeFindings } from '../skills/wing-session-analyzer/scripts/lib/analysis.mjs';
import { decodeRoutingSource } from '../skills/wing-session-analyzer/scripts/lib/routing.mjs';

// Small handcrafted analysis fixtures, grounded in WING Edit 3.3.4 controlled-save observations.
const make = () => ({ type: 'snapshot.11', creator_model: 'synthetic-not-hardware-proof', ae_data: {
  ch: {
    '1': { name: 'HOST', mute: true, fdr: -144, ptap: '5', in: { conn: { grp: 'LCL', in: 1, altgrp: 'USB', altin: 9 }, set: { srcauto: false, altsrc: false } }, send: { '1': { on: true, lvl: 0, mode: 'PRE' } } },
    '2': { name: 'OTHER', mute: false, fdr: 0, ptap: '3', in: { conn: { grp: 'USB', in: 2 }, set: { srcauto: false, altsrc: false } }, main: { '2': { on: true, lvl: 0 } } },
  },
  aux: { '1': { name: 'Aux strip', mute: false, fdr: 0 } },
  bus: { '1': { name: 'Speech', mute: false, fdr: 0, main: { '1': { on: true, lvl: 0 } } }, '2': { name: 'Other bus' }, '16': { name: 'Last bus' } },
  main: { '1': { name: 'Main', send: { MX1: { on: true, lvl: 0 } } }, '2': { name: 'Remote' }, '4': { name: 'Last main' } },
  mtx: { '1': { name: 'Lobby' }, '8': { name: 'Last matrix' } },
  io: {
    in: { LCL: { '1': { name: 'Lectern source', mode: 'S' } }, USB: { '2': { name: 'Other USB' }, '9': { name: 'Backup' } }, USR: { '1': { name: 'CH2 tap', mode: 'M', user: { grp: 'CH', in: 2, tap: 'PRE', lr: 'L+R' } } } },
    out: { LCL: { '1': { grp: 'BUS', in: 1 }, '2': { grp: 'BUS', in: 2 }, '3': { grp: 'BUS', in: 3 }, '4': { grp: 'MAIN', in: 4 }, '5': { grp: 'MTX', in: 1 }, '6': { grp: 'OFF', in: 1 }, '7': { grp: 'MAIN', in: 8 }, '8': { grp: 'MTX', in: 16 } },
      A: { '48': { grp: 'BUS', in: 32 } }, USB: { '1': { grp: 'USR', in: 1 }, '2': { grp: 'LCL', in: 1 } } },
  },
} });
const edge = (trace, to) => trace.edges.find(item => item.kind === 'output_patch' && item.to === to);

test('known logical source encodings decode interleaved sides and retain encoded indices', () => {
  const doc = parseWingDocument(make());
  for (const [group, index, kind, number, side] of [
    ['BUS', 1, 'bus', 1, 'L'], ['BUS', 2, 'bus', 1, 'R'], ['BUS', 3, 'bus', 2, 'L'], ['BUS', 32, 'bus', 16, 'R'],
    ['MAIN', 1, 'main', 1, 'L'], ['MAIN', 4, 'main', 2, 'R'], ['MAIN', 8, 'main', 4, 'R'], ['MTX', 1, 'mtx', 1, 'L'], ['MTX', 16, 'mtx', 8, 'R'],
  ]) {
    const decoded = decodeRoutingSource(doc, { grp: group, in: index }, '/synthetic/patch');
    assert.equal(decoded.status, 'decoded');
    assert.equal(decoded.id, `${kind}:${number}`);
    assert.deepEqual(decoded.reference, { group, kind, number, side, encodedIndex: index });
  }
});

test('decoding does not fabricate unknown groups, invalid indices or newer-version compatibility', () => {
  const doc = parseWingDocument(make());
  for (const group of ['CH', 'SEND', 'MON', '__proto__', 'toString']) assert.equal(decodeRoutingSource(doc, { grp: group, in: 1 }, '/patch').status, 'unsupported_group');
  for (const [group, index] of [['BUS', 33], ['MAIN', 9], ['MTX', 17], ['USR', 57]]) assert.equal(decodeRoutingSource(doc, { grp: group, in: index }, '/patch').status, 'invalid_index');
  for (const index of [0, -1, 1.5, '1', null]) assert.equal(decodeRoutingSource(doc, { grp: 'BUS', in: index }, '/patch').status, 'invalid_reference');
  const newer = make(); newer.type = 'snapshot.12';
  assert.equal(decodeRoutingSource(parseWingDocument(newer), { grp: 'BUS', in: 1 }, '/patch').status, 'unsupported_layout');
  assert.equal(decodeRoutingSource(doc, { grp: 'OFF', in: 1 }, '/patch').status, 'off');
});

test('forward routes reach the exact BUS/Main/Matrix output patches, not other sides or strips by group alone', () => {
  const trace = traceRoutes(parseWingDocument(make()));
  assert.equal(trace.direction, 'downstream');
  assert.equal(trace.audibleOutput, 'not_determined');
  assert.equal(edge(trace, 'output:LCL:1').side, 'L');
  assert.equal(edge(trace, 'output:LCL:2').side, 'R');
  assert.equal(edge(trace, 'output:LCL:5').from, 'mtx:1');
  for (const id of ['output:LCL:3', 'output:LCL:4', 'output:LCL:6', 'output:LCL:7', 'output:LCL:8', 'output:A:48']) assert.equal(edge(trace, id), undefined);
  assert.equal(trace.nodes.find(node => node.id === 'ch:1').mute.value, true);
  assert.equal(trace.outputs.every(node => node.physicalPortValidation === 'not_performed'), true);
  assert.equal(trace.coverage.outputPatches.total, 11);
});

test('reverse output lookup shares the same oriented patch edge and records exact source pointer', () => {
  const doc = parseWingDocument(make());
  const forward = traceRoutes(doc), reverse = traceOutputRoutes(doc, { bank: 'LCL', number: 2 });
  assert.equal(reverse.direction, 'upstream');
  assert.equal(reverse.start, 'output:LCL:2');
  assert.deepEqual(edge(reverse, 'output:LCL:2'), edge(forward, 'output:LCL:2'));
  assert.equal(edge(reverse, 'output:LCL:2').sourcePointer, '/ae_data/io/out/LCL/2');
  assert.ok(reverse.nodes.some(node => node.id === 'ch:1'));
  assert.equal(reverse.outputs[0].source.reference.side, 'R');
  assert.equal(reverse.audibleOutput, 'not_determined');
});

test('direct physical input passthrough is not downstream of a strip using the same input', () => {
  const doc = parseWingDocument(make());
  assert.equal(edge(traceRoutes(doc), 'output:USB:2'), undefined);
  const reverse = traceOutputRoutes(doc, { bank: 'USB', number: 2 });
  assert.equal(edge(reverse, 'output:USB:2').from, 'input:LCL:1');
  assert.equal(reverse.nodes.some(node => node.kind === 'ch'), false);
  assert.equal(reverse.nodes.find(node => node.id === 'input:LCL:1').mode.value, 'S');
});

test('USR direct signals connect logical strips through user source without inventing PRE as pre-fader', () => {
  const doc = parseWingDocument(make()), trace = traceRoutes(doc, { number: 2 });
  const user = trace.edges.find(item => item.kind === 'user_signal');
  assert.equal(user.from, 'ch:2'); assert.equal(user.to, 'input:USR:1');
  assert.equal(user.tap, 'PRE'); assert.equal(user.side, 'L+R');
  assert.equal(user.sideInterpretation, 'stored_mono_sum_selection');
  assert.equal(user.tapInterpretation, 'stored_channel_tap');
  assert.equal(user.channelTap.value, '3');
  assert.equal(edge(trace, 'output:USB:1').from, 'input:USR:1');
  const reverse = traceOutputRoutes(doc, { bank: 'USB', number: 1 });
  assert.ok(reverse.nodes.some(node => node.id === 'ch:2'));
  assert.ok(reverse.nodes.some(node => node.id === 'input:USB:2'));
  assert.equal(reverse.nodes.find(node => node.id === 'input:USR:1').assignment.value.tap, 'PRE');
});

test('USR logical assignment selectors use noninterleaved strip numbers and preserve side and POST token', () => {
  const raw = make(); raw.ae_data.io.in.USR['1'].user = { grp: 'BUS', in: 16, tap: 'POST', lr: 'R' };
  const trace = traceOutputRoutes(parseWingDocument(raw), { bank: 'USB', number: 1 });
  const assignment = trace.edges.find(item => item.kind === 'user_signal');
  assert.equal(assignment.from, 'bus:16');
  assert.equal(assignment.side, 'R'); assert.equal(assignment.tap, 'POST');
  assert.equal(Object.hasOwn(assignment, 'channelTap'), false);
});

test('raw user-signal assignments use raw source ordinals and reject unknown or out-of-range mappings', () => {
  const raw = make(); raw.ae_data.io.in.USR['25'] = { user: { grp: 'A', in: 48 } }; raw.ae_data.io.out.USB['3'] = { grp: 'USR', in: 25 };
  const trace = traceOutputRoutes(parseWingDocument(raw), { bank: 'USB', number: 3 });
  assert.ok(trace.edges.some(item => item.from === 'input:A:48' && item.to === 'input:USR:25'));
  raw.ae_data.io.in.USR['25'].user = { grp: 'BUS', in: 1 };
  assert.ok(traceOutputRoutes(parseWingDocument(raw), { bank: 'USB', number: 3 }).unresolved.some(item => item.code === 'USER_SIGNAL_ASSIGNMENT_UNRESOLVED'));
  raw.ae_data.io.in.USR['25'].user = { grp: 'OSC', in: 1 };
  assert.ok(traceOutputRoutes(parseWingDocument(raw), { bank: 'USB', number: 3 }).unresolved.some(item => item.code === 'USER_SIGNAL_ASSIGNMENT_UNRESOLVED'));
  raw.ae_data.io.in.USR['25'].user = { grp: 'A', in: 49 };
  assert.ok(traceOutputRoutes(parseWingDocument(raw), { bank: 'USB', number: 3 }).unresolved.some(item => item.code === 'SOURCE_REFERENCE_UNRESOLVED' && item.status === 'invalid_index'));
});

test('logical primary and alternate inputs map to actual strip labels and retain L/R identity', () => {
  const raw = make(); raw.ae_data.ch['1'].clink = true;
  raw.ae_data.ch['1'].in.conn = { grp: 'BUS', in: 2, altgrp: 'MAIN', altin: 4 };
  const doc = parseWingDocument(raw), selected = getChannel(doc, { number: 1 }).summary;
  assert.deepEqual(selected.source.primary.reference, { group: 'BUS', kind: 'bus', number: 1, side: 'R', encodedIndex: 2 });
  assert.equal(selected.source.primary.targetPointer, '/ae_data/bus/1');
  assert.equal(selected.effectiveLabel.value, 'Speech');
  assert.deepEqual(selected.source.alternate.reference, { group: 'MAIN', kind: 'main', number: 2, side: 'R', encodedIndex: 4 });
});

test('selected-false and runtime-unknown input candidates are not followed as configured dependencies', () => {
  const raw = make(); raw.ae_data.ch['2'].in.conn = { grp: 'BUS', in: 1, altgrp: 'USB', altin: 2 };
  raw.ae_data.ch['2'].in.set.altsrc = true;
  let trace = traceRoutes(parseWingDocument(raw), { kind: 'bus', number: 1 });
  assert.equal(edge(trace, 'output:LCL:4'), undefined);
  assert.ok(trace.edges.some(item => item.kind === 'input_candidate' && item.from === 'bus:1' && item.selected === false));
  assert.equal(trace.nodes.find(node => node.id === 'ch:2').contextOnly, true);
  raw.ae_data.ch['2'].in.set.srcauto = true;
  trace = traceRoutes(parseWingDocument(raw), { kind: 'bus', number: 1 });
  assert.equal(edge(trace, 'output:LCL:4'), undefined);
  raw.ae_data.ch['2'].in.set = { srcauto: false, altsrc: false };
  trace = traceRoutes(parseWingDocument(raw), { kind: 'bus', number: 1 });
  assert.equal(edge(trace, 'output:LCL:4').from, 'main:2');
});

test('matrix direct INPUT tokens remain named sources, not falsely equated to a physical AES port', () => {
  const raw = make(); raw.ae_data.mtx['1'].dir = { on: true, in: 'MON.PH', lvl: -12 };
  const trace = traceOutputRoutes(parseWingDocument(raw), { bank: 'LCL', number: 5 });
  assert.ok(trace.edges.some(item => item.kind === 'matrix_direct_input' && item.to === 'mtx:1'));
  assert.ok(trace.nodes.some(node => node.kind === 'direct_input_source' && node.token === 'MON.PH' && node.physicalMapping === 'not_expanded'));
  assert.equal(trace.nodes.some(node => node.id === 'input:AES:1'), false);
  raw.ae_data.mtx['1'].dir.in = 'BUS.3';
  assert.ok(traceOutputRoutes(parseWingDocument(raw), { bank: 'LCL', number: 5 }).unresolved.some(item => item.code === 'DIRECT_INPUT_TOKEN_UNRESOLVED'));
});

test('depth bounds count logical strip hops and terminal patches remain available at depth zero', () => {
  const doc = parseWingDocument(make());
  const shallow = traceRoutes(doc, { kind: 'bus', number: 1, maxDepth: 0 });
  assert.ok(edge(shallow, 'output:LCL:1'));
  assert.equal(edge(shallow, 'output:LCL:5'), undefined);
  assert.ok(shallow.unresolved.some(item => item.code === 'MAX_DEPTH_REACHED'));
  const reverse = traceOutputRoutes(doc, { bank: 'LCL', number: 2, maxDepth: 0 });
  assert.ok(reverse.nodes.some(node => node.id === 'bus:1'));
  assert.equal(reverse.nodes.some(node => node.id === 'ch:1'), false);
  assert.equal(reverse.depthUnit, 'logical-strip-hops');
});

test('cycles, missing strip data, unknown patches and newer versions stay bounded and explicit', () => {
  const raw = make(); raw.ae_data.bus['1'].send = { '1': { on: true } };
  raw.ae_data.io.out.LCL['3'] = { grp: 'MAIN', in: 7 }; delete raw.ae_data.main['4'];
  raw.ae_data.io.out.LCL['6'] = { grp: 'MAIN', in: 9 };
  let doc = parseWingDocument(raw), trace = traceRoutes(doc);
  assert.equal(trace.edges.filter(item => item.to === 'output:LCL:1').length, 1);
  const missing = traceOutputRoutes(doc, { bank: 'LCL', number: 3 });
  assert.equal(missing.nodes.find(node => node.id === 'main:4').exists, false);
  assert.ok(missing.unresolved.some(item => item.code === 'OUTPUT_SOURCE_TARGET_NOT_IN_DOCUMENT'));
  assert.ok(traceOutputRoutes(doc, { bank: 'LCL', number: 6 }).unresolved.some(item => item.code === 'OUTPUT_SOURCE_UNRESOLVED'));
  assert.ok(traceOutputRoutes(doc, { bank: 'NOT PRESENT', number: 1 }).unresolved.some(item => item.code === 'OUTPUT_NOT_IN_DOCUMENT'));
  raw.type = 'snapshot.12'; doc = parseWingDocument(raw);
  trace = traceOutputRoutes(doc, { bank: 'LCL', number: 1 });
  assert.equal(trace.edges.some(item => item.kind === 'output_patch'), false);
  assert.equal(trace.coverage.physicalOutputMapping, 'unsupported_layout');
  assert.equal(trace.coverage.userSignalAssignments.direct, 'unsupported_layout');
  assert.equal(trace.coverage.userSignalAssignments.raw, 'unsupported_layout');
});

test('different logical source sides are not classified as duplicate selected inputs', () => {
  const raw = make();
  raw.ae_data.ch['1'].in.conn = { grp: 'BUS', in: 1 };
  raw.ae_data.ch['2'].in.conn = { grp: 'BUS', in: 2 };
  assert.equal(analyzeFindings(parseWingDocument(raw)).items.some(item => item.code === 'DUPLICATE_SELECTED_INPUT'), false);
});

test('queries reject ignored or malformed options and never mutate source documents', () => {
  const raw = make(), before = JSON.stringify(raw), doc = parseWingDocument(raw);
  for (const options of [{ bank: 'LCL', number: 0 }, { bank: '' }, { bank: 'LCL', maxDepth: 33 }, { bank: 'LCL', prefix: '/ae_data' }]) assert.throws(() => traceOutputRoutes(doc, options));
  assert.throws(() => traceRoutes(doc, { kind: 'dca' }));
  assert.throws(() => traceRoutes(doc, { limit: 2 }));
  traceRoutes(doc); traceOutputRoutes(doc, { bank: 'LCL', number: 1 });
  assert.equal(JSON.stringify(raw), before);
  assert.equal(JSON.stringify(doc.data), before);
});
