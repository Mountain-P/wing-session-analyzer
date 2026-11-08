import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { parseWingDocument, traceRoutes, traceOutputRoutes } from '../skills/wing-session-analyzer/scripts/lib/analysis.mjs';

const ledger = JSON.parse(await fs.readFile(new URL('../docs/send-mon-experiments.json', import.meta.url), 'utf8'));
const copy = value => JSON.parse(JSON.stringify(value));
const outputLocation = pointer => /^\/ae_data\/io\/out\/([^/]+)\/([1-9]\d*)$/.exec(pointer);
const monitorLocation = pointer => /^\/ae_data\/cfg\/mon\/([12])\/(src|dirin)$/.exec(pointer);
const logicalSource = source => /^(ch|aux|bus|main|mtx):([1-9]\d*)$/.exec(source || '');

function assign(document, pointer, value) {
  const parts = pointer.slice(1).split('/').map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'));
  let parent = document;
  for (const part of parts.slice(0, -1)) parent = parent[part] ??= {};
  parent[parts.at(-1)] = copy(value);
}

function reconstruct(entry) {
  const document = { type: entry.type,
    info_text: 'Handcrafted analysis-only reconstruction of public observations; added empty metadata and test probes are not native recall evidence.',
    ae_data: { io: { in: {}, out: {} } } };
  const testOnlyProbes = [];
  for (const observation of entry.observations) assign(document, observation.pointer, observation.value);
  for (const observation of entry.observations) {
    const source = observation.expectedGraph?.source;
    const logical = logicalSource(source);
    if (logical) {
      document.ae_data[logical[1]] ??= {};
      document.ae_data[logical[1]][logical[2]] ??= {};
    }
    const fx = /^fx_send:([1-9]\d*)$/.exec(source || '');
    if (fx) {
      // Empty metadata lets the decoder name the slot without inventing an insert owner.
      document.ae_data.fx ??= {};
      document.ae_data.fx[fx[1]] ??= {};
    }
    const monitor = /^monitor:([12])$/.exec(source || '');
    if (monitor) {
      document.ae_data.cfg ??= {};
      document.ae_data.cfg.mon ??= {};
      document.ae_data.cfg.mon[monitor[1]] ??= {};
    }
  }
  if (['10', '11'].includes(entry.id)) {
    const probe = { pointer: '/ae_data/io/out/LCL/8', value: { grp: 'MON', in: 1 },
      origin: 'test-only output probe; not a patch observed in this native save' };
    assign(document, probe.pointer, probe.value);
    testOnlyProbes.push(probe);
  }
  return { document, testOnlyProbes };
}

const patchAt = (graph, pointer) => graph.edges.find(edge => edge.kind === 'output_patch' && edge.sourcePointer === pointer);
const monitorEdgeAt = (graph, pointer) => graph.edges.find(edge => ['monitor_source', 'monitor_direct_input'].includes(edge.kind) && edge.sourcePointer === pointer);

test('public native SEND/MON observations remain executable decoder evidence without adding native-save claims', async t => {
  assert.equal(ledger.method.successfulNativeArtifacts, 9);
  assert.equal(ledger.method.controlledVariants, 8);
  assert.equal(ledger.cases.length, 9);
  assert.equal(new Set(ledger.cases.map(entry => entry.id)).size, 9);
  for (const entry of ledger.cases) await t.test(`native save ${entry.id}: ${entry.nativeSave}`, () => {
    const { document, testOnlyProbes } = reconstruct(entry), before = JSON.stringify(document);
    const parsed = parseWingDocument(document);
    for (const observation of entry.observations) {
      const location = outputLocation(observation.pointer);
      if (!location) continue;
      const expected = observation.expectedGraph;
      const reverse = traceOutputRoutes(parsed, { bank: location[1], number: Number(location[2]) });
      const patch = patchAt(reverse, observation.pointer);
      assert.equal(patch?.from, expected.source, observation.uiSelection);
      assert.equal(patch?.side, expected.side, observation.uiSelection);
      assert.deepEqual(patch.raw, observation.value);
      assert.equal(reverse.audibleOutput, 'not_determined');
      assert.equal(reverse.nodes.find(node => node.id === expected.source).exists, true);
      if (observation.value.grp === 'SEND') {
        assert.equal(reverse.edges.some(edge => edge.kind === 'fx_send'), false, 'no native insert-owner observation was supplied for this case');
        assert.ok(reverse.unresolved.some(issue => issue.code === 'FX_SEND_OWNER_NOT_IN_DOCUMENT'));
      }
    }
    for (const observation of entry.observations) {
      const location = monitorLocation(observation.pointer);
      if (!location) continue;
      const expected = observation.expectedGraph;
      const nativeOutput = entry.observations.find(item => outputLocation(item.pointer) && item.value.grp === 'MON');
      const probe = testOnlyProbes[0];
      if (expected.status === 'off') {
        // Baseline has no output patch; MAIN.1 still exposes its configured monitor dependency.
        const graph = nativeOutput || probe
          ? traceOutputRoutes(parsed, { bank: 'LCL', number: nativeOutput ? 1 : 8 })
          : traceRoutes(parsed, { kind: 'main', number: 1 });
        assert.equal(monitorEdgeAt(graph, observation.pointer), undefined);
        continue;
      }
      const logical = logicalSource(expected.source);
      assert.ok(logical, 'monitor selector expectations use logical strip IDs');
      const forward = traceRoutes(parsed, { kind: logical[1], number: Number(logical[2]), maxDepth: 0 });
      const edge = monitorEdgeAt(forward, observation.pointer);
      assert.equal(edge?.from, expected.source);
      assert.equal(edge?.to, `monitor:${location[1]}`);
      assert.equal(edge?.kind, expected.kind);
      assert.equal(edge?.raw, observation.value);
      assert.equal(edge.runtimeSelected, 'not_determined');
      const monitor = forward.nodes.find(node => node.id === edge.to);
      assert.equal(monitor.levels.sourceLevel.value, 0);
      assert.equal(monitor.levels.sourceMix.value, -144);
      assert.equal(monitor.levels.monitorLevel.value, -144);
      assert.equal(monitor.levels.sourceLevel.sourcePointer, `/ae_data/cfg/mon/${location[1]}/srclvl`);
      assert.equal(monitor.levels.sourceMix.sourcePointer, `/ae_data/cfg/mon/${location[1]}/srcmix`);
      assert.ok(forward.unresolved.some(issue => issue.code === 'MONITOR_RUNTIME_STATE_UNKNOWN'));
      if (nativeOutput || probe) {
        const pointer = (nativeOutput || probe).pointer;
        const reverse = traceOutputRoutes(parsed, { bank: 'LCL', number: nativeOutput ? 1 : 8, maxDepth: 0 });
        assert.deepEqual(monitorEdgeAt(reverse, observation.pointer), edge);
        assert.deepEqual(patchAt(forward, pointer), patchAt(reverse, pointer), 'saved levels do not gate the structural dependency');
      }
    }
    assert.equal(JSON.stringify(document), before, 'queries preserve all reconstructed observed values');
  });
});

test('isolated BUS.16 and CH.40 monitor settings use only an explicit synthetic PHONES output probe', () => {
  for (const id of ['10', '11']) {
    const entry = ledger.cases.find(item => item.id === id);
    assert.equal(entry.observations.some(item => outputLocation(item.pointer)), false);
    const { document, testOnlyProbes } = reconstruct(entry);
    assert.equal(testOnlyProbes.length, 1);
    assert.equal(testOnlyProbes[0].pointer, '/ae_data/io/out/LCL/8');
    assert.deepEqual(testOnlyProbes[0].value, { grp: 'MON', in: 1 });
    const reverse = traceOutputRoutes(document, { bank: 'LCL', number: 8 });
    assert.equal(patchAt(reverse, testOnlyProbes[0].pointer).from, 'monitor:1');
    assert.ok(reverse.edges.some(edge => edge.kind === 'monitor_source' && edge.from === 'bus:16'));
    assert.equal(reverse.edges.some(edge => edge.kind === 'monitor_direct_input' && edge.from === 'ch:40'), id === '11');
    assert.equal(reverse.nodes.some(node => node.id === 'bus:8'), false, 'BUS.16 is a logical number, not an interleaved index');
    assert.equal(reverse.audibleOutput, 'not_determined');
  }
});

test('MON R and speaker mappings retain their static/UI basis without becoming additional native saves', () => {
  const nativePatches = ledger.cases.flatMap(entry => entry.observations).filter(item => outputLocation(item.pointer));
  const monitor = nativePatches.filter(item => item.value.grp === 'MON');
  assert.deepEqual(monitor.map(item => item.value.in), [1]);
  assert.deepEqual(ledger.uiLabelObservations[0].nativeSavedIndices, [1]);
  assert.equal(ledger.uncompletedExperiments.length > 0, true);
  const lastSend = nativePatches.find(item => item.value.grp === 'SEND' && item.value.in === 32);
  assert.equal(lastSend.expectedGraph.source, 'fx_send:16');
  assert.equal(lastSend.expectedGraph.side, 'R');
});
