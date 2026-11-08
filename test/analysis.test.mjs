import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWingDocument, inspectDocument, listChannels, getChannel, searchParameters,
  getParameter, traceRoutes, diffDocuments, analyzeFindings, listScenes,
} from '../skills/wing-session-analyzer/scripts/lib/analysis.mjs';

// Handcrafted, small synthetic fixtures. No OEM templates or real identifiers.
function fixture() {
  return { type: 'snapshot.11', creator_model: 'synthetic', created: '2026-01-01', active_scene: 'opening',
    ae_data: {
      ch: {
        1: { name: 'Presenter', clink: false, mute: true, fdr: -144,
          in: { set: { srcauto: false, altsrc: false }, conn: { grp: 'LCL', in: 1, altgrp: 'USB', altin: 1 } },
          main: { 1: { on: true, lvl: 0, pre: false }, 2: { on: false } },
          send: { 1: { on: true, lvl: -12, mode: 'PRE' }, MX1: { on: false } } },
        2: { name: 'Stored channel label', clink: true, mute: false, fdr: -8,
          in: { set: { srcauto: false, altsrc: false }, conn: { grp: 'LCL', in: 1, altgrp: 'OFF', altin: 1 } } },
        3: { name: 'Remote', clink: true, mute: false, fdr: -4,
          in: { set: { srcauto: false, altsrc: true }, conn: { grp: 'LCL', in: 2, altgrp: 'USB', altin: 2 } } },
      },
      bus: { 1: { name: 'Speech bus', mute: false, fdr: -6, main: { 1: { on: true, lvl: 0 } }, send: { MX1: { on: true, lvl: -3 } } } },
      main: { 1: { name: 'Program', mute: false, fdr: -3, send: { MX1: { on: true, lvl: 0 } } } },
      mtx: { 1: { name: 'Lobby', mute: false, fdr: -10 } },
      dca: { 1: { name: 'Raw DCA', mute: true, fdr: -12 } },
      mgrp: { 1: { name: 'Raw mute group', mute: false } },
      io: {
        in: { LCL: { 1: { name: 'Desk mic', mode: 'M' }, 2: { name: 'Primary backup', mode: 'M' } },
          USB: { 1: { name: 'USB left', mode: 'M' }, 2: { name: 'Remote USB', mode: 'M' } } },
        out: { LCL: { 1: { grp: 'MAIN', in: 3 }, 2: { grp: 'BUS', in: 3 }, 3: { grp: 'OFF', in: 1 } } },
      },
    }, ce_data: { safes: { ch: '+  ', source: { LCL: '  ' } } }, scopes: { custom: 'raw scope' },
  };
}
const parsed = () => parseWingDocument(fixture(), { source: 'synthetic.snap' });
const hasCode = code => error => error.code === code;

test('parses native type families without fabricating snapshot sections for presets', () => {
  for (const [type, kind] of [['snapshot.11', 'snapshot'], ['showfile.1', 'show'], ['snippet.11', 'snippet'], ['chpreset.11', 'channel_preset'], ['fxpreset.11', 'fx_preset']]) {
    const document = parseWingDocument(JSON.stringify({ type, ...(kind === 'show' ? { scenes: { count: 0 } } : kind === 'snapshot' ? { ae_data: {} } : { selected: null }) }));
    assert.equal(document.kind, kind);
    assert.equal(document.version, kind === 'show' ? 1 : 11);
    assert.equal(document.coverage, 'known');
    assert.ok(document.limitations.some(limit => limit.includes('audible')));
  }
  assert.equal(parseWingDocument(new TextEncoder().encode('\uFEFF{"type":"snippet.11"}')).kind, 'snippet');
});

test('newer and legacy versions remain inspectable but explicitly have partial coverage', () => {
  for (const type of ['snapshot.12', 'snapshot.2', 'showfile.2', 'fxpreset.10']) {
    const document = parseWingDocument({ type, ae_data: {}, scenes: { count: 0 } });
    assert.equal(document.coverage, 'partial');
    assert.ok(document.limitations.some(limit => limit.includes('not validated compatibility')));
    assert.ok(analyzeFindings(document).items.some(item => item.code === 'PARTIAL_COVERAGE'));
  }
});

test('fails cleanly for binary, unsupported types and non-JSON values', () => {
  assert.throws(() => parseWingDocument(new Uint8Array([0xff, 0xfe])), hasCode('UNSUPPORTED_BINARY'));
  assert.throws(() => parseWingDocument('MZ\0binary'), hasCode('UNSUPPORTED_BINARY'));
  assert.throws(() => parseWingDocument('PK\x03\x04archive'), hasCode('UNSUPPORTED_BINARY'));
  assert.throws(() => parseWingDocument('{broken'), hasCode('INVALID_JSON'));
  assert.throws(() => parseWingDocument('[]'), hasCode('INVALID_DOCUMENT'));
  assert.throws(() => parseWingDocument({ type: 'not-wing' }), hasCode('UNSUPPORTED_TYPE'));
  assert.throws(() => parseWingDocument({ type: 'snapshot.11', bad: undefined }), hasCode('INVALID_JSON_VALUE'));
  assert.throws(() => parseWingDocument({ type: 'snapshot.11', bad: Infinity }), hasCode('INVALID_JSON_VALUE'));
  assert.throws(() => parseWingDocument({ type: 'snapshot.11', bad: new Array(2) }), hasCode('INVALID_JSON_VALUE'));
  const cycle = { type: 'snapshot.11' }; cycle.self = cycle;
  assert.throws(() => parseWingDocument(cycle), hasCode('INVALID_JSON_VALUE'));
  let executed = false;
  const accessor = { type: 'snapshot.11', get bad() { executed = true; return 1; } };
  assert.throws(() => parseWingDocument(accessor), hasCode('INVALID_JSON_VALUE'));
  assert.equal(executed, false, 'object accessors must not be executed as document data');
});

test('inspection counts recorded slots rather than used channels and preserves raw controls', () => {
  const info = inspectDocument(parsed());
  assert.equal(info.channels.ch.slotsPresent, 3);
  assert.equal(info.channels.ch.usedChannels, null);
  assert.equal(info.channels.ch.explicitUnmutedSlots, 2);
  assert.equal(info.rawControls.safes.sourcePointer, '/ce_data/safes');
  assert.equal(info.rawControls.safes.valueType, 'object');
  assert.equal(info.rawControls.dca.childCount, 1);
  assert.equal(info.rawControls.scopes.rawValueAccess.operation, 'getParameter');
  assert.equal(Object.hasOwn(info.rawControls.scopes, 'value'), false);
  assert.deepEqual(getParameter(parsed(), info.rawControls.safes.sourcePointer).value, fixture().ce_data.safes);
  assert.match(info.rawControls.muteGroups.semantics, /raw/);
  assert.equal(info.metadata.source, 'synthetic.snap');
});

test('channel lookup distinguishes stored name, clink source metadata and primary/alternate selection', () => {
  const doc = parsed();
  const first = getChannel(doc, { kind: 'ch', number: 1 });
  assert.equal(first.summary.effectiveLabel.value, 'Presenter');
  assert.equal(first.summary.effectiveLabel.origin, 'channel');
  const second = getChannel(doc, { number: 2 }).summary;
  assert.equal(second.name, 'Stored channel label');
  assert.equal(second.effectiveLabel.value, 'Desk mic');
  assert.equal(second.effectiveLabel.sourcePointer, '/ae_data/io/in/LCL/1/name');
  const third = getChannel(doc, { number: 3 }).summary;
  assert.equal(third.source.selected, 'alternate');
  assert.deepEqual(third.source.effective.reference, { group: 'USB', number: 2 });
  assert.equal(third.effectiveLabel.value, 'Remote USB');
  assert.equal(getChannel(doc, { number: 4 }).exists, false);
  assert.throws(() => getChannel(doc, { kind: 'all' }), hasCode('INVALID_CHANNEL_KIND'));
});

test('automatic or omitted input selection flags remain unknown instead of guessing primary', () => {
  const raw = fixture(); raw.ae_data.ch['2'].in.set.srcauto = true;
  const summary = getChannel(parseWingDocument(raw), { number: 2 }).summary;
  assert.equal(summary.source.selected, 'automatic_runtime_unknown');
  assert.equal(summary.source.effective, null);
  assert.equal(summary.effectiveLabel.exists, false);
  delete raw.ae_data.ch['2'].in.set;
  assert.equal(getChannel(parseWingDocument(raw), { number: 2 }).summary.source.selected, 'unknown');
  raw.ae_data.ch['2'].in.set = { altsrc: false };
  assert.equal(getChannel(parseWingDocument(raw), { number: 2 }).summary.source.selected, 'unknown', 'missing srcauto is not false');
});

test('channel paging and query are bounded and operate on effective labels', () => {
  const result = listChannels(parsed(), { kind: 'ch', query: 'Desk mic', offset: 0, limit: 1 });
  assert.equal(result.total, 1);
  assert.equal(result.items[0].number, 2);
  const all = listChannels(parsed(), { kind: 'ch', offset: 1, limit: 1 });
  assert.equal(all.total, 3); assert.equal(all.items[0].number, 2); assert.equal(all.hasMore, true);
  assert.throws(() => listChannels(parsed(), { limit: 1001 }), hasCode('INVALID_PAGE'));
});

test('RFC6901 lookup preserves absent versus null and never walks object prototypes', () => {
  const doc = parseWingDocument('{"type":"snippet.11","a/b":{"~key":null},"__proto__":{"own":7}}');
  assert.deepEqual(getParameter(doc, '/a~1b/~0key').value, null);
  assert.equal(getParameter(doc, '/a~1b/~0key').exists, true);
  const absent = getParameter(doc, '/missing');
  assert.equal(absent.exists, false); assert.equal(Object.hasOwn(absent, 'value'), false);
  assert.equal(getParameter(doc, '/__proto__/own').value, 7);
  assert.equal(getParameter(doc, '/constructor/prototype').exists, false);
  assert.throws(() => getParameter(doc, 'ae_data/ch'), hasCode('INVALID_POINTER'));
  assert.throws(() => getParameter(doc, '/a~2b'), hasCode('INVALID_POINTER'));
});

test('search respects pointer segment boundaries and retains explicitly empty objects', () => {
  const doc = parseWingDocument({ type: 'snippet.11', ae_data: { ch: { 1: { name: 'One', mute: null }, 10: { name: 'Ten', mute: false } } }, empty: {} });
  const result = searchParameters(doc, { prefix: '/ae_data/ch/1', query: 'name' });
  assert.equal(result.total, 1); assert.equal(result.items[0].value, 'One');
  assert.equal(searchParameters(doc, { prefix: '/empty' }).items[0].valueType, 'object');
  assert.equal(searchParameters(doc, { prefix: '/not-here' }).total, 0);
});

test('diff distinguishes absence, null, type changes and empty containers with stable paging', () => {
  const before = parseWingDocument({ type: 'snippet.11', absentLater: null, flag: false, empty: {} });
  const after = parseWingDocument({ type: 'snippet.11', addedNull: null, flag: 0, empty: [] });
  const result = diffDocuments(before, after);
  assert.equal(result.total, 4);
  const removed = result.items.find(item => item.pointer === '/absentLater');
  assert.equal(removed.operation, 'removed'); assert.equal(removed.before, null); assert.equal(removed.afterExists, false); assert.equal(Object.hasOwn(removed, 'after'), false);
  assert.equal(result.items.find(item => item.pointer === '/addedNull').operation, 'added');
  assert.deepEqual(result.items.find(item => item.pointer === '/empty').after, []);
  const page = diffDocuments(before, after, { offset: 1, limit: 2 });
  assert.equal(page.total, 4); assert.equal(page.items.length, 2); assert.equal(page.hasMore, true);
});

test('diff tolerance is opt-in; ignoring metadata does not hide active scene changes', () => {
  const before = parseWingDocument({ type: 'snippet.11', created: 'old', active_scene: 'A', gain: 1 });
  const after = parseWingDocument({ type: 'snippet.11', created: 'new', active_scene: 'B', gain: 1.05 });
  assert.equal(diffDocuments(before, after).total, 3);
  const changed = diffDocuments(before, after, { numericTolerance: 0.1, ignoreMetadata: true });
  assert.equal(changed.total, 1); assert.equal(changed.items[0].pointer, '/active_scene');
  assert.throws(() => diffDocuments(before, after, { numericTolerance: -1 }), hasCode('INVALID_TOLERANCE'));
});

test('trace follows enabled channel→bus/main→matrix structural links without claiming sound', () => {
  const trace = traceRoutes(parsed());
  assert.equal(trace.interpretation, 'structural_reachability_only');
  assert.equal(trace.audibleOutput, 'not_determined');
  assert.ok(trace.edges.some(edge => edge.from === 'ch:1' && edge.to === 'bus:1'));
  assert.ok(trace.edges.some(edge => edge.from === 'bus:1' && edge.to === 'main:1'));
  assert.ok(trace.edges.some(edge => edge.from === 'main:1' && edge.to === 'mtx:1'));
  assert.ok(!trace.edges.some(edge => edge.to === 'main:2'));
  assert.ok(trace.nodes.find(node => node.id === 'ch:1').mute.value);
  assert.ok(trace.edges.every(edge => typeof edge.sourcePointer === 'string'));
});

test('output interleaving and direct-source tokens remain unresolved rather than fabricated', () => {
  const raw = fixture(); raw.ae_data.mtx['1'].dir = { on: true, in: 'BUS.3', lvl: 0 };
  const trace = traceRoutes(parseWingDocument(raw));
  const output = trace.unresolved.find(item => item.code === 'OUTPUT_SOURCE_INDEX_UNVERIFIED' && item.raw.grp === 'BUS');
  assert.equal(output.raw.in, 3);
  assert.equal(output.sourcePointer, '/ae_data/io/out/LCL/2');
  assert.ok(trace.unresolved.some(item => item.code === 'DIRECT_SOURCE_TOKEN_UNRESOLVED'));
  assert.ok(!trace.edges.some(edge => edge.to.startsWith('output:')), 'no physical output side guessed');
});

test('trace handles cycles, missing targets and depth bounds deterministically', () => {
  const raw = fixture(); raw.ae_data.bus['1'].send['1'] = { on: true, lvl: 0 };
  raw.ae_data.ch['1'].main['4'] = { on: true, lvl: 0 };
  const doc = parseWingDocument(raw), trace = traceRoutes(doc);
  assert.ok(trace.nodes.length < 20);
  assert.ok(trace.unresolved.some(item => item.code === 'ROUTE_TARGET_NOT_IN_DOCUMENT' && item.reference.number === 4));
  assert.ok(traceRoutes(doc, { maxDepth: 0 }).unresolved.some(item => item.code === 'MAX_DEPTH_REACHED'));
  assert.ok(traceRoutes(doc, { number: 99 }).unresolved.some(item => item.code === 'SLOT_NOT_IN_DOCUMENT'));
  assert.throws(() => traceRoutes(doc, { maxDepth: 33 }), hasCode('INVALID_DEPTH'));
  assert.throws(() => traceRoutes(doc, { offset: 0 }), hasCode('INVALID_OPTION'));
  assert.throws(() => traceRoutes(doc, { prefix: '/ae_data/ch' }), hasCode('INVALID_OPTION'));
});

test('findings describe selected-source splits and enabled muted/minimum-fader routes as facts', () => {
  const result = analyzeFindings(parsed());
  const split = result.items.find(item => item.code === 'DUPLICATE_SELECTED_INPUT');
  assert.equal(split.severity, 'info'); assert.equal(split.channels.length, 2);
  assert.match(split.message, /intentional split/);
  const muted = result.items.find(item => item.code === 'ENABLED_ROUTE_WITH_MUTED_OR_MINIMUM_FADER');
  assert.equal(muted.states.length, 2);
  assert.ok(muted.states.some(state => state.sourcePointer.endsWith('/fdr') && state.value === -144));
  assert.match(muted.message, /not an inaudibility verdict/);
  assert.equal(analyzeFindings(parsed(), { severity: 'error' }).total, 0);
});

test('partial snippets and presets support inspect/search/diff without global missing-source alarms', () => {
  const snippet = parseWingDocument({ type: 'snippet.11', ae_data: { ch: { 1: { mute: true } } } });
  assert.equal(analyzeFindings(snippet).total, 0);
  assert.equal(listChannels(snippet, { kind: 'ch' }).total, 1);
  const preset = parseWingDocument({ type: 'chpreset.11', source_channel: 'CH.1', ch_data: { name: 'Synthetic preset', eq: { on: true } } });
  assert.equal(listChannels(preset).total, 0, 'do not invent a numbered channel from a preset');
  assert.equal(searchParameters(preset, { prefix: '/ch_data' }).total, 2);
  assert.ok(inspectDocument(preset).topLevel.some(item => item.sourcePointer === '/ch_data'));
  assert.equal(diffDocuments(preset, parseWingDocument({ ...preset.data, ch_data: { name: 'Changed', eq: { on: true } } })).total, 1);
});

test('actual show scenes/count object yields numbered records with raw filenames and scoped facts', () => {
  const doc = parseWingDocument({ type: 'showfile.1', scenes: { count: 3,
    2: { name: 'Welcome', type: 'SNIP', file: 'cues/welcome.snip', targets: { ch: '1' } },
    1: { name: 'Opening', type: 'SNAP', file: 'snapshots/open.snap', skip: false, link: true },
  } });
  const result = listScenes(doc, { limit: 1 });
  assert.equal(result.total, 2); assert.equal(result.items[0].number, 1); assert.equal(result.hasMore, true);
  assert.equal(result.items[0].file, 'snapshots/open.snap');
  assert.equal(result.items[0].fileFact.sourcePointer, '/scenes/1/file');
  assert.equal(result.items[0].referenceStatus, 'not_checked');
  assert.equal(result.declaredCount.value, 3);
  assert.ok(analyzeFindings(doc).items.some(item => item.code === 'SCENE_COUNT_MISMATCH'));
  assert.ok(analyzeFindings(doc).items.some(item => item.code === 'SCENE_FILE_NOT_CHECKED'));
  const zero = parseWingDocument({ type: 'showfile.2', scenes: { count: 1, 0: { name: 'Unverified zero-based record', file: 'zero.snap' } } });
  assert.equal(listScenes(zero).items[0].number, 0);
  assert.equal(listScenes(zero).items[0].numbering, 'unverified_zero_key_retained');
});

test('inspection remains bounded when safes/scopes contain large raw strings', () => {
  const doc = parseWingDocument({ type: 'snapshot.11', ae_data: {}, scopes: { payload: 'x'.repeat(300000) }, ce_data: { safes: { payload: 'y'.repeat(300000) } } });
  assert.ok(JSON.stringify(inspectDocument(doc)).length < 10000);
  assert.equal(getParameter(doc, '/scopes/payload').value.length, 300000);
});

test('analysis does not mutate supplied documents and every API result serializes as JSON', () => {
  const doc = parsed(), before = JSON.stringify(doc);
  const results = [inspectDocument(doc), listChannels(doc), getChannel(doc), searchParameters(doc),
    getParameter(doc, '/ae_data/ch/1'), traceRoutes(doc), diffDocuments(doc, doc), analyzeFindings(doc), listScenes(doc)];
  assert.equal(JSON.stringify(doc), before);
  for (const result of results) assert.doesNotThrow(() => JSON.parse(JSON.stringify(result)));
  const input = fixture(), document = parseWingDocument(input); document.data.ae_data.ch['1'].name = 'Independent clone';
  assert.equal(input.ae_data.ch['1'].name, 'Presenter');
});
