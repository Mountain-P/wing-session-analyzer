import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { parseWingDocument, traceRoutes, traceOutputRoutes } from '../skills/wing-session-analyzer/scripts/lib/analysis.mjs';

const ledger = JSON.parse(await fs.readFile(new URL('../docs/fx-owner-experiments.json', import.meta.url), 'utf8'));
const copy = value => JSON.parse(JSON.stringify(value));
const insertLocation = pointer => /^\/ae_data\/(ch|aux|bus|main|mtx)\/([1-9]\d*)\/(preins|postins)$/.exec(pointer);
const fxLocation = pointer => /^\/ae_data\/fx\/([1-9]\d*)$/.exec(pointer);
const observations = entry => new Map(entry.observations.map(item => [item.pointer, item.value]));
const cases = new Map(ledger.cases.map(entry => [entry.id, entry]));
const prepared = new Map(ledger.preparedInputs.map(entry => [entry.id, entry]));

function assignObserved(document, observation) {
  assert.ok(insertLocation(observation.pointer) || fxLocation(observation.pointer), 'Only published insert/FX metadata pointers belong in an analysis reconstruction.');
  const parts = observation.pointer.slice(1).split('/');
  let parent = document;
  for (const part of parts.slice(0, -1)) parent = parent[part] ??= {};
  parent[parts.at(-1)] = copy(observation.value);
}

function recordedClaims(entry) {
  return entry.observations.flatMap(observation => {
    const location = insertLocation(observation.pointer);
    const fx = location && /^FX([1-9]\d*)$/.exec(observation.value.ins);
    if (!fx) return [];
    return [{ fx: Number(fx[1]), kind: location[1], number: Number(location[2]), position: location[3],
      source: `${location[1]}:${location[2]}`, sourcePointer: observation.pointer, raw: observation.value }];
  });
}

/** The added TEST output patches are analysis probes, never native SAVE or recall templates. */
function reconstruct(entry) {
  const document = { type: entry.type, info_text: 'Handcrafted analysis-only reconstruction; TEST outputs are synthetic probes, not native saved patches.',
    ae_data: { io: { out: { TEST: {} } } } };
  for (const observation of entry.observations) assignObserved(document, observation);
  const claims = recordedClaims(entry);
  const fxNumbers = [...new Set([
    ...entry.observations.flatMap(observation => fxLocation(observation.pointer) ? [Number(fxLocation(observation.pointer)[1])] : []),
    ...claims.map(claim => claim.fx),
  ])].sort((a, b) => a - b);
  for (const fx of fxNumbers) document.ae_data.io.out.TEST[fx] = { grp: 'SEND', in: fx * 2 - 1 };
  return { document, claims, fxNumbers };
}

const patchAt = (graph, fx) => graph.edges.find(edge => edge.kind === 'output_patch' && edge.to === `output:TEST:${fx}`);
const byPointer = entries => [...entries].sort(([left], [right]) => left.localeCompare(right));

function assertClaimEvidence(edge, claim) {
  assert.equal(edge.from, claim.source);
  assert.equal(edge.to, `fx_send:${claim.fx}`);
  assert.equal(edge.position, claim.position);
  assert.equal(edge.sourcePointer, claim.sourcePointer);
  assert.deepEqual(edge.raw, claim.raw);
  assert.equal(edge.insertEnabled.sourcePointer, `${claim.sourcePointer}/on`);
  assert.equal(edge.insertEnabled.exists, true);
  assert.equal(edge.insertEnabled.value, claim.raw.on);
}

test('native owner observations drive configured-route regressions without injecting observed UI winners', async t => {
  for (const entry of ledger.cases) await t.test(`native save ${entry.id}: ${entry.nativeSave}`, () => {
    const { document, claims, fxNumbers } = reconstruct(entry), before = JSON.stringify(document);
    const parsed = parseWingDocument(document), parsedBefore = JSON.stringify(parsed.data);
    assert.equal(Object.hasOwn(parsed.data, 'observedUiOwners'), false);
    for (const fx of fxNumbers) {
      const selected = claims.filter(claim => claim.fx === fx);
      const reverse = traceOutputRoutes(parsed, { bank: 'TEST', number: fx, maxDepth: 0 });
      const patch = patchAt(reverse, fx);
      assert.equal(patch.from, `fx_send:${fx}`);
      assert.equal(patch.side, 'L');
      assert.deepEqual(patch.raw, { grp: 'SEND', in: fx * 2 - 1 });
      assert.equal(patch.sourcePointer, `/ae_data/io/out/TEST/${fx}`);
      assert.equal(reverse.audibleOutput, 'not_determined');
      const definite = reverse.edges.filter(edge => edge.kind === 'fx_send' && edge.to === `fx_send:${fx}`);
      const candidates = reverse.edges.filter(edge => edge.kind === 'fx_send_candidate' && edge.to === `fx_send:${fx}`);
      if (selected.length === 0) {
        assert.equal(definite.length, 0);
        assert.equal(candidates.length, 0);
        assert.ok(reverse.unresolved.some(issue => issue.code === 'FX_SEND_OWNER_NOT_IN_DOCUMENT'));
      } else if (selected.length === 1) {
        const claim = selected[0];
        assert.equal(definite.length, 1);
        assert.equal(candidates.length, 0);
        assertClaimEvidence(definite[0], claim);
        assert.equal(definite[0].configured, true);
        assert.equal(definite[0].ownershipScope, 'recorded-document-assignments');
        const forward = traceRoutes(parsed, { kind: claim.kind, number: claim.number, maxDepth: 0 });
        assert.deepEqual(patchAt(forward, fx), patch);
        assert.deepEqual(forward.edges.find(edge => edge.kind === 'fx_send' && edge.to === `fx_send:${fx}`), definite[0]);
      } else {
        assert.equal(definite.length, 0, 'an observed native UI winner is not a serialized or globally inferred owner');
        assert.equal(candidates.length, selected.length);
        assert.ok(reverse.unresolved.some(issue => issue.code === 'FX_SEND_OWNER_AMBIGUOUS' && issue.candidateCount === selected.length));
        for (const claim of selected) {
          const candidate = candidates.find(edge => edge.sourcePointer === claim.sourcePointer);
          assertClaimEvidence(candidate, claim);
          assert.equal(candidate.selected, null);
          assert.equal(candidate.traversed, false);
          assert.equal(reverse.nodes.find(node => node.id === claim.source).contextOnly, true);
          const forward = traceRoutes(parsed, { kind: claim.kind, number: claim.number, maxDepth: 0 });
          assert.equal(patchAt(forward, fx), undefined);
          assert.equal(forward.nodes.find(node => node.id === `fx_send:${fx}`).contextOnly, true);
        }
        for (const uiOwner of entry.observedUiOwners.filter(owner => owner.fx === fx)) {
          assert.ok(selected.some(claim => claim.kind === uiOwner.kind && claim.number === uiOwner.number && claim.position === uiOwner.position));
          assert.equal(reverse.edges.some(edge => edge.kind === 'fx_send'), false);
        }
      }
    }
    assert.equal(JSON.stringify(document), before);
    assert.equal(JSON.stringify(parsed.data), parsedBefore);
  });
});

test('native ON/OFF and occupied-slot Cancel/Confirm preserve distinct stored facts', () => {
  const off = observations(cases.get('01')), on = observations(cases.get('02'));
  const source = '/ae_data/ch/1/preins', destination = '/ae_data/ch/2/postins';
  assert.deepEqual(off.get(source), { on: false, ins: 'FX1' });
  assert.deepEqual(on.get(source), { on: true, ins: 'FX1' });
  for (const [pointer, value] of off) if (pointer !== source) assert.deepEqual(on.get(pointer), value);
  assert.deepEqual(byPointer(observations(cases.get('03'))), byPointer(on));
  const confirmed = observations(cases.get('04'));
  assert.equal(confirmed.get(source).ins, 'NONE');
  assert.equal(confirmed.get(source).on, on.get(source).on, 'reassignment clears a selector without clearing its saved ON value');
  assert.equal(confirmed.get(destination).ins, 'FX1');
  assert.equal(confirmed.get(destination).on, false, 'a transferred configured owner can remain bypassed');
  for (const group of ledger.checks.byteIdenticalNativeGroups) {
    const first = cases.get(group[0]);
    for (const id of group.slice(1)) {
      assert.equal(cases.get(id).sha256, first.sha256);
      assert.deepEqual(byPointer(observations(cases.get(id))), byPointer(observations(first)), 'byte-identical saves cannot disagree on their published fields');
    }
  }
});

test('loaded duplicate claims survive native SAVE and key-order repeat without becoming definite owners', () => {
  for (const [preparedId, savedId] of ledger.checks.loadedClaimsRetainedBySave) {
    const input = prepared.get(preparedId), saved = cases.get(savedId), retained = observations(saved);
    assert.equal(saved.sourceId, input.id);
    for (const patch of input.patches) assert.deepEqual(retained.get(patch.pointer), patch.value, 'native SAVE must retain each published prepared claim');
  }
  const repeat = [cases.get('11'), cases.get('14')].map(entry => reconstruct(entry).document);
  assert.deepEqual(repeat[0], repeat[1]);
  // Carrier member order is deliberately reversed before parsing, independent of
  // JavaScript's canonical enumeration of numeric object keys after JSON.parse.
  const serialized = repeat.map((document, index) => {
    const ch = document.ae_data.ch;
    const members = Object.keys(ch).sort((left, right) => index ? Number(right) - Number(left) : Number(left) - Number(right));
    const text = JSON.stringify(document);
    return text.replace(JSON.stringify(ch), '{' + members.map(key => JSON.stringify(key) + ':' + JSON.stringify(ch[key])).join(',') + '}');
  });
  assert.notEqual(serialized[0], serialized[1]);
  const graphs = serialized.map(text => traceOutputRoutes(parseWingDocument(text), { bank: 'TEST', number: 1 }));
  assert.deepEqual(graphs[0], graphs[1]);
  assert.equal(graphs[0].edges.some(edge => edge.kind === 'fx_send'), false);
  assert.equal(graphs[0].edges.filter(edge => edge.kind === 'fx_send_candidate').length, recordedClaims(cases.get('11')).length);
});
