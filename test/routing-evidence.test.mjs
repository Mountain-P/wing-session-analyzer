import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  parseWingDocument, traceRoutes, traceOutputRoutes,
} from '../skills/wing-session-analyzer/scripts/lib/analysis.mjs';

const ledger = JSON.parse(await fs.readFile(new URL('../docs/routing-experiments.json', import.meta.url), 'utf8'));
const copy = value => JSON.parse(JSON.stringify(value));
const logicalId = source => /^(ch|aux|bus|main|mtx):([1-9]\d*)$/.exec(source || '');
const outputLocation = pointer => /^\/ae_data\/io\/out\/([^/]+)\/([1-9]\d*)$/.exec(pointer);
const userLocation = pointer => /^\/ae_data\/io\/in\/USR\/([1-9]\d*)\/user$/.exec(pointer);
const tokens = pointer => pointer.slice(1).split('/').map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'));

function assign(document, pointer, value) {
  const parts = tokens(pointer);
  let parent = document;
  for (const part of parts.slice(0, -1)) parent = parent[part] ??= {};
  parent[parts.at(-1)] = copy(value);
}

function includeSource(document, source) {
  const logical = logicalId(source);
  if (logical) {
    document.ae_data[logical[1]] ??= {};
    document.ae_data[logical[1]][logical[2]] ??= {};
    return;
  }
  const input = /^input:([^:]+):([1-9]\d*)$/.exec(source || '');
  if (input) {
    const group = decodeURIComponent(input[1]);
    document.ae_data.io.in[group] ??= {};
    document.ae_data.io.in[group][input[2]] ??= {};
  }
}

/** These are small analysis probes, never native WING snapshots or recall templates. */
function reconstruct(entry) {
  const document = {
    type: entry.type,
    info_text: 'Handcrafted analysis reconstruction of published scalar observations; added objects and probes are not native SAVE evidence.',
    ae_data: { io: { in: {}, out: {} } },
  };
  const testOnlyProbes = [];
  for (const observation of entry.observations) assign(document, observation.pointer, observation.value);
  for (const observation of entry.observations) includeSource(document, observation.expectedGraph?.source);
  for (const observation of entry.observations) {
    const user = userLocation(observation.pointer);
    if (!user) continue;
    // An output probe is necessary for an isolated user assignment such as case 18.
    // It is deliberately LCL, not the unsuccessful native USB assignment in case 19.
    if (!document.ae_data.io.out.LCL?.['1']) {
      const probe = { pointer: '/ae_data/io/out/LCL/1', value: { grp: 'USR', in: Number(user[1]) }, origin: 'test-only output probe; not an observed native patch' };
      assign(document, probe.pointer, probe.value);
      testOnlyProbes.push(probe);
    }
  }
  return { document, testOnlyProbes };
}

const patchTo = (graph, bank, number) => graph.edges.find(edge => edge.kind === 'output_patch' && edge.to === `output:${encodeURIComponent(bank)}:${number}`);

test('published successful native-save observations drive the routing decoder regressions', async t => {
  assert.equal(ledger.method.successfulNativeArtifacts, 20);
  assert.equal(ledger.cases.length, 20);
  assert.equal(new Set(ledger.cases.map(entry => entry.id)).size, 20);
  assert.equal(ledger.cases.some(entry => entry.id === '19'), false, 'an unsuccessful requested patch must not enter successful codec evidence');
  for (const entry of ledger.cases) await t.test(`native save ${entry.id}: ${entry.nativeSave}`, () => {
    const { document } = reconstruct(entry), before = JSON.stringify(document);
    const parsed = parseWingDocument(document, { source: `handcrafted-ledger-reconstruction:${entry.id}` });
    for (const observation of entry.observations) {
      const location = outputLocation(observation.pointer);
      if (!location) continue;
      const bank = location[1], number = Number(location[2]), expected = observation.expectedGraph;
      assert.ok(expected?.source, `case ${entry.id} output observation requires an independently recorded expected source`);
      const reverse = traceOutputRoutes(parsed, { bank, number });
      const patch = patchTo(reverse, bank, number);
      assert.equal(patch?.from, expected.source, observation.uiSelection);
      assert.equal(patch?.side, expected.side, observation.uiSelection);
      assert.equal(patch.sourcePointer, observation.pointer);
      assert.deepEqual(patch.raw, observation.value);
      assert.equal(reverse.audibleOutput, 'not_determined');
      let logical = logicalId(expected.source);
      const userSource = /^input:USR:([1-9]\d*)$/.exec(expected.source);
      if (!logical && userSource) {
        const assignmentObservation = entry.observations.find(item => userLocation(item.pointer)?.[1] === userSource[1]);
        logical = logicalId(assignmentObservation?.expectedGraph?.source);
      }
      if (logical) {
        const forward = traceRoutes(parsed, { kind: logical[1], number: Number(logical[2]), maxDepth: 0 });
        assert.deepEqual(patchTo(forward, bank, number), patch, 'a decoded native patch must agree in both query directions');
      }
    }
    for (const observation of entry.observations) {
      const user = userLocation(observation.pointer);
      if (!user) continue;
      const userId = `input:USR:${user[1]}`, expected = observation.expectedGraph;
      const reverse = traceOutputRoutes(parsed, { bank: 'LCL', number: 1 });
      const assignment = reverse.edges.find(edge => edge.kind === 'user_signal' && edge.to === userId);
      if (expected.status === 'off') {
        assert.equal(assignment, undefined, 'the native OFF assignment has no synthetic upstream edge');
        continue;
      }
      assert.equal(assignment?.from, expected.source, observation.uiSelection);
      assert.equal(assignment?.side, expected.side, observation.uiSelection);
      assert.equal(assignment.sourcePointer, observation.pointer);
      if (expected.tap !== undefined) {
        assert.equal(assignment.tap, expected.tap);
        assert.deepEqual(assignment.raw, observation.value);
      } else assert.equal(Object.hasOwn(assignment, 'tap'), false, 'raw user patches do not gain an invented processing tap');
      const logical = logicalId(expected.source);
      if (logical) {
        const forward = traceRoutes(parsed, { kind: logical[1], number: Number(logical[2]), maxDepth: 0 });
        assert.ok(patchTo(forward, 'LCL', 1), 'the observed logical strip must reach its User Signal output');
        assert.deepEqual(forward.edges.find(edge => edge.kind === 'user_signal' && edge.to === userId), assignment);
      }
      const tapObservation = entry.observations.find(item => item.pointer.endsWith('/ptap'));
      if (tapObservation && expected.tap === 'PRE') {
        assert.equal(assignment.channelTap.value, tapObservation.value);
        assert.equal(assignment.channelTap.sourcePointer, tapObservation.pointer);
      }
    }
    assert.equal(JSON.stringify(document), before, 'decoding never mutates the reconstructed observations');
  });
});

test('an isolated raw USR assignment uses an explicitly synthetic LCL probe, not claimed native USB evidence', () => {
  const entry = ledger.cases.find(item => item.id === '18');
  const { document, testOnlyProbes } = reconstruct(entry);
  assert.equal(entry.observations.some(item => outputLocation(item.pointer)), false);
  assert.equal(testOnlyProbes.length, 1);
  assert.equal(testOnlyProbes[0].pointer, '/ae_data/io/out/LCL/1');
  assert.equal(Object.hasOwn(document.ae_data.io.out, 'USB'), false);
  const reverse = traceOutputRoutes(parseWingDocument(document), { bank: 'LCL', number: 1 });
  assert.ok(reverse.edges.some(edge => edge.from === 'input:A:48' && edge.to === 'input:USR:25'));
  assert.equal(patchTo(reverse, 'LCL', 1).from, 'input:USR:25');
});

test('the unsuccessful USB attempt retains its OFF patch and byte-identical prior-save identity', () => {
  const prior = ledger.cases.find(entry => entry.id === '18');
  const failed = ledger.unsuccessfulExperiments.find(entry => entry.id === '19');
  assert.equal(failed.sha256, prior.sha256, 'the published native saves have identical byte hashes');
  assert.deepEqual(failed.observed.value, { grp: 'OFF', in: 1 });
  const { document } = reconstruct(prior);
  assign(document, failed.observed.pointer, failed.observed.value);
  const reverse = traceOutputRoutes(parseWingDocument(document), { bank: 'USB', number: 48 });
  assert.equal(reverse.outputs[0].source.status, 'off');
  assert.equal(reverse.edges.some(edge => edge.kind === 'output_patch'), false);
});

test('the observed raw-input passthrough bypasses a handcrafted strip selecting that same source', () => {
  const { document } = reconstruct(ledger.cases.find(entry => entry.id === '08'));
  document.ae_data.ch = { '7': { in: { conn: { grp: 'LCL', in: 7 }, set: { srcauto: false, altsrc: false } } } };
  const parsed = parseWingDocument(document);
  assert.equal(patchTo(traceRoutes(parsed, { kind: 'ch', number: 7 }), 'LCL', 1), undefined);
  const reverse = traceOutputRoutes(parsed, { bank: 'LCL', number: 1 });
  assert.equal(patchTo(reverse, 'LCL', 1).from, 'input:LCL:7');
  assert.equal(reverse.nodes.some(node => node.kind === 'ch'), false);
});
