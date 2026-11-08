/** Pure offline WING JSON analysis. No filesystem, network, subprocess or device APIs.
 * Native anchors: LibAction::save_snapshot 0x6dd7f0, load_snapshot 0x6d3800,
 * save_show 0x6db7c0; supplied Wing Edit 3.3.4 ELF. Names/fields are observed;
 * structural graph edges do not establish physical signal flow or audibility.
 */
import { decodeRoutingSource, traceRoutesDocument, traceOutputRoutesDocument } from './routing.mjs';

const TYPES = Object.freeze({ snapshot: 'snapshot', showfile: 'show', snippet: 'snippet', chpreset: 'channel_preset', fxpreset: 'fx_preset' });
const GROUPS = ['ch', 'aux', 'bus', 'main', 'mtx', 'dca', 'mgrp'];
const AUDIO_GROUPS = ['ch', 'aux', 'bus', 'main', 'mtx'];
const META = new Set(['creator_fw', 'creator_sn', 'creator_model', 'creator_version', 'creator_name', 'created', 'updated']);
const own = (value, key) => value !== null && typeof value === 'object' && Object.hasOwn(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => JSON.parse(JSON.stringify(value));
const escapeToken = value => String(value).replaceAll('~', '~0').replaceAll('/', '~1');
const pointer = parts => parts.length ? '/' + parts.map(escapeToken).join('/') : '';
const valueType = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
const ordered = keys => [...keys].sort((a, b) => /^(0|[1-9]\d*)$/.test(a) && /^(0|[1-9]\d*)$/.test(b) ? (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0) : a.localeCompare(b, 'en'));
function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function isIndex(value) { return /^(0|[1-9]\d*)$/.test(String(value)); }
function isSlot(value) { return /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value)); }
function jsonCopy(value) {
  const seen = new Set(), stack = [{ value, depth: 0, exit: false }];
  let nodes = 0;
  while (stack.length) {
    const current = stack.pop(), item = current.value;
    if (current.exit) { seen.delete(item); continue; }
    if (++nodes > 1000000 || current.depth > 128) fail('INPUT_LIMIT', 'JSON exceeds the supported node/depth budget.');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') continue;
    if (typeof item === 'number') { if (!Number.isFinite(item)) fail('INVALID_JSON_VALUE', 'Numbers must be finite JSON values.'); continue; }
    if (typeof item !== 'object') fail('INVALID_JSON_VALUE', 'Only JSON values are supported; undefined/functions are not accepted.');
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) fail('INVALID_JSON_VALUE', 'Only plain JSON objects are supported.');
    if (Array.isArray(item) && (Object.keys(item).length !== item.length || Array.from({ length: item.length }, (_, index) => index).some(index => !own(item, index)))) fail('INVALID_JSON_VALUE', 'Sparse arrays and extra array properties are not supported JSON values.');
    if (seen.has(item)) fail('INVALID_JSON_VALUE', 'Cyclic objects are not JSON documents.');
    seen.add(item); stack.push({ value: item, exit: true });
    for (const key of Object.keys(item)) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!own(descriptor, 'value')) fail('INVALID_JSON_VALUE', 'Accessor properties are not JSON data.');
      stack.push({ value: descriptor.value, depth: current.depth + 1, exit: false });
    }
  }
  return clone(value);
}
function tokens(raw) {
  if (typeof raw !== 'string' || (raw !== '' && !raw.startsWith('/')) || /~(?![01])/u.test(raw)) fail('INVALID_POINTER', 'Use an RFC 6901 JSON pointer, beginning with /, or empty for the document root.');
  return raw === '' ? [] : raw.slice(1).split('/').map(token => token.replaceAll('~1', '/').replaceAll('~0', '~'));
}
function lookup(data, parts) {
  let value = data;
  for (const part of parts) {
    if (Array.isArray(value) && !isIndex(part)) return { exists: false };
    if (!own(value, part)) return { exists: false };
    value = value[part];
  }
  return { exists: true, value };
}
function fact(data, parts) {
  const found = lookup(data, parts), sourcePointer = pointer(parts);
  return found.exists ? { exists: true, value: clone(found.value), valueType: valueType(found.value), sourcePointer } : { exists: false, sourcePointer };
}
function summaryFact(data, parts) {
  const found = lookup(data, parts), sourcePointer = pointer(parts);
  if (!found.exists) return { exists: false, sourcePointer };
  return { exists: true, sourcePointer, valueType: valueType(found.value),
    ...(found.value !== null && typeof found.value === 'object' ? { childCount: Object.keys(found.value).length } : typeof found.value === 'string' ? { characterCount: found.value.length } : {}),
    rawValueAccess: { operation: 'getParameter', pointer: sourcePointer } };
}
function docOf(value) { return object(value) && Object.values(TYPES).includes(value.kind) && object(value.data) ? value : parseWingDocument(value); }
function page(items, { offset = 0, limit = 50 } = {}, extra = {}) {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 0 || limit > 1000) fail('INVALID_PAGE', 'offset must be a nonnegative integer and limit an integer from 0 to 1000.');
  return { items: items.slice(offset, offset + limit), total: items.length, offset, limit, hasMore: offset + limit < items.length, ...extra };
}
function assertText(value, label) { if (typeof value !== 'string') fail('INVALID_OPTION', `${label} must be a string.`); }
function groupEntries(doc, kind = 'all') {
  if (kind !== 'all' && !GROUPS.includes(kind)) fail('INVALID_CHANNEL_KIND', `kind must be all or ${GROUPS.join(', ')}.`);
  return (kind === 'all' ? GROUPS : [kind]).flatMap(group => {
    const values = doc.data.ae_data?.[group];
    return object(values) ? ordered(Object.keys(values)).filter(key => isSlot(key) && object(values[key])).map(key => ({ kind: group, number: Number(key), value: values[key], parts: ['ae_data', group, key] })) : [];
  });
}

export function parseWingDocument(input, { source } = {}) {
  let value = input;
  if (input instanceof Uint8Array || input instanceof ArrayBuffer) {
    try { value = new TextDecoder('utf-8', { fatal: true }).decode(input); }
    catch { fail('UNSUPPORTED_BINARY', 'Input is not UTF-8 JSON; binary WING/internal-state formats are not supported.'); }
  }
  if (typeof value === 'string') {
    value = value.replace(/^\uFEFF/u, '');
    if (value.includes('\0') || /^(?:MZ|PK\x03\x04|\x7fELF)/u.test(value)) fail('UNSUPPORTED_BINARY', 'Binary/archive/internal-state input is unsupported; supply an exported WING JSON document.');
    try { value = JSON.parse(value); }
    catch { fail('INVALID_JSON', 'Input could not be parsed as JSON.'); }
  }
  if (!object(value)) fail('INVALID_DOCUMENT', 'The document root must be a JSON object.');
  const data = jsonCopy(value);
  const match = typeof data.type === 'string' && /^(snapshot|showfile|snippet|chpreset|fxpreset)\.(\d+)$/u.exec(data.type);
  if (!match || !Number.isSafeInteger(Number(match[2]))) fail('UNSUPPORTED_TYPE', 'Supported WING types are snapshot.N, showfile.N, snippet.N, chpreset.N and fxpreset.N.');
  const kind = TYPES[match[1]], version = Number(match[2]), expectedVersion = kind === 'show' ? 1 : 11;
  const limitations = [
    'Offline file facts and bounded structural interpretations only; no runtime, hardware, audible-output or recall validation.',
    'Recorded slots are not a count of used microphones/channels; omitted fields remain unknown and are not filled from factory defaults.',
    'DCA/mute-group memberships, scopes and safes remain raw unless explicitly described; no effective mute/recall simulation is performed.',
  ];
  let coverage = version === expectedVersion ? 'known' : 'partial';
  if (version !== expectedVersion) limitations.push(`Version ${version} is not the inspected ${match[1]}.${expectedVersion} layout. Generic JSON inspection/diff remain available; semantic coverage is partial, not validated compatibility.`);
  if (kind !== 'snapshot' && kind !== 'show') limitations.push('This may contain only selected parameters; missing channel/source/route sections are not globally classified as errors.');
  if ((kind === 'snapshot' && !object(data.ae_data)) || (kind === 'show' && !object(data.scenes))) {
    coverage = 'partial'; limitations.push('Expected primary section is absent or has an unrecognized layout; preserve and inspect the raw JSON.');
  }
  const metadata = { source: source === undefined ? null : String(source), sourcePointers: {} };
  for (const key of META) if (own(data, key)) { metadata[key] = clone(data[key]); metadata.sourcePointers[key] = pointer([key]); }
  return { kind, type: data.type, version, data, metadata, coverage, limitations };
}

function sourceReference(doc, channelParts, connection, groupKey, inputKey) {
  const group = fact(doc.data, [...channelParts, 'in', 'conn', groupKey]);
  const input = fact(doc.data, [...channelParts, 'in', 'conn', inputKey]);
  const result = { sourcePointer: pointer([...channelParts, 'in', 'conn']), group, input, status: 'not_included' };
  if (!group.exists || !input.exists) return result;
  const decoded = decodeRoutingSource(doc, { grp: group.value, in: input.value }, result.sourcePointer, { consumer: 'channel_input' });
  if (decoded.status === 'off') return { ...result, status: 'off' };
  if (decoded.status !== 'decoded') return { ...result, status: 'unrecognized_reference', decoding: decoded };
  result.reference = decoded.reference;
  result.targetPointer = decoded.targetPointer;
  result.codec = decoded.codec;
  const targetParts = tokens(decoded.targetPointer);
  const target = fact(doc.data, targetParts);
  if (target.exists && object(target.value)) {
    result.status = 'present';
    result.label = fact(doc.data, [...targetParts, 'name']);
    result.mode = fact(doc.data, [...targetParts, 'mode']);
  } else result.status = 'target_not_in_document';
  return result;
}
function sourceSummary(doc, entry) {
  const { value: channel, parts } = entry;
  const primary = sourceReference(doc, parts, channel.in?.conn, 'grp', 'in');
  const alternate = sourceReference(doc, parts, channel.in?.conn, 'altgrp', 'altin');
  const automatic = fact(doc.data, [...parts, 'in', 'set', 'srcauto']);
  const alternateSelected = fact(doc.data, [...parts, 'in', 'set', 'altsrc']);
  let selected = 'unknown', effective = null;
  if (automatic.exists && automatic.value === true) selected = 'automatic_runtime_unknown';
  else if (automatic.exists && automatic.value === false && alternateSelected.exists && alternateSelected.value === true) { selected = 'alternate'; effective = alternate; }
  else if (automatic.exists && automatic.value === false && alternateSelected.exists && alternateSelected.value === false) { selected = 'primary'; effective = primary; }
  return { primary, alternate, automatic, alternateSelected, selected, effective };
}
function channelSummary(doc, entry) {
  const { kind, number, value, parts } = entry;
  const source = sourceSummary(doc, entry), clink = fact(doc.data, [...parts, 'clink']);
  const storedName = fact(doc.data, [...parts, 'name']);
  let effectiveLabel = { exists: false, reason: 'clink/selected-source label semantics are not fully recorded', sourcePointer: pointer(parts) };
  if (clink.exists && clink.value === false && storedName.exists) effectiveLabel = { ...storedName, origin: 'channel' };
  if (clink.exists && clink.value === true && source.effective?.label?.exists) effectiveLabel = { ...source.effective.label, origin: 'linked_source', interpretation: 'linked source metadata; native empty-name fallback is not modeled' };
  const name = typeof value.name === 'string' ? value.name : '';
  return {
    kind, number, sourcePointer: pointer(parts), name, storedName, clink, effectiveLabel,
    displayLabel: effectiveLabel.exists && typeof effectiveLabel.value === 'string' && effectiveLabel.value ? effectiveLabel.value : name || `${kind.toUpperCase()} ${number}`,
    displayLabelIsPresentationFallback: !(effectiveLabel.exists && typeof effectiveLabel.value === 'string' && effectiveLabel.value),
    mute: fact(doc.data, [...parts, 'mute']), fader: fact(doc.data, [...parts, 'fdr']),
    source, usage: 'unknown',
    enabledMainRoutes: object(value.main) ? Object.entries(value.main).filter(([, route]) => route?.on === true).map(([key]) => ({ kind: 'main', number: isIndex(key) ? Number(key) : key, sourcePointer: pointer([...parts, 'main', key]) })) : [],
    enabledSends: object(value.send) ? Object.entries(value.send).filter(([, route]) => route?.on === true).map(([key]) => ({ rawDestination: key, sourcePointer: pointer([...parts, 'send', key]) })) : [],
  };
}

export function inspectDocument(value) {
  const doc = docOf(value), channels = groupEntries(doc), counts = {};
  for (const kind of GROUPS) {
    const entries = channels.filter(entry => entry.kind === kind);
    counts[kind] = { sourcePointer: `/ae_data/${kind}`, slotsPresent: entries.length,
      namedSlots: entries.filter(entry => typeof entry.value.name === 'string' && entry.value.name.trim()).length,
      explicitUnmutedSlots: entries.filter(entry => entry.value.mute === false).length,
      usedChannels: null };
  }
  const rawControls = {};
  for (const [name, parts] of [['dca', ['ae_data', 'dca']], ['muteGroups', ['ae_data', 'mgrp']], ['scopes', ['scopes']], ['safes', ['ce_data', 'safes']]]) {
    rawControls[name] = { ...summaryFact(doc.data, parts), semantics: 'raw; effective membership/recall behavior not inferred' };
  }
  const ioCounts = side => object(doc.data.ae_data?.io?.[side]) ? Object.entries(doc.data.ae_data.io[side]).map(([group, slots]) => ({ group, slotsPresent: object(slots) ? Object.keys(slots).length : null, sourcePointer: pointer(['ae_data', 'io', side, group]) })) : [];
  return { kind: doc.kind, type: doc.type, version: doc.version, coverage: doc.coverage,
    metadata: clone(doc.metadata), sourcePointer: '',
    topLevel: Object.entries(doc.data).map(([key, item]) => ({ key, valueType: valueType(item), sourcePointer: pointer([key]) })),
    channels: counts, inputs: ioCounts('in'), outputs: ioCounts('out'), rawControls,
    scenes: doc.kind === 'show' ? { declaredCount: fact(doc.data, ['scenes', 'count']), recordsPresent: sceneEntries(doc).length } : null,
    limitations: [...doc.limitations],
  };
}

export function listChannels(value, { kind = 'all', query = '', offset = 0, limit = 50 } = {}) {
  const doc = docOf(value); assertText(query, 'query');
  const needle = query.toLowerCase();
  const items = groupEntries(doc, kind).map(entry => channelSummary(doc, entry)).filter(item => !needle || JSON.stringify([item.kind, item.number, item.name, item.effectiveLabel, item.source.primary.reference, item.source.alternate.reference]).toLowerCase().includes(needle));
  return page(items, { offset, limit }, { limitations: [...doc.limitations] });
}
export function getChannel(value, { kind = 'ch', number = 1 } = {}) {
  const doc = docOf(value);
  if (!GROUPS.includes(kind)) fail('INVALID_CHANNEL_KIND', `kind must be ${GROUPS.join(', ')} for a single channel.`);
  if (!Number.isInteger(number) || number < 1) fail('INVALID_CHANNEL_NUMBER', 'number must be a positive integer.');
  const entry = groupEntries(doc, kind).find(item => item.kind === kind && item.number === number);
  return entry ? { kind, number, exists: true, sourcePointer: pointer(entry.parts), channel: clone(entry.value), summary: channelSummary(doc, entry), limitations: [...doc.limitations] }
    : { kind, number, exists: false, sourcePointer: `/ae_data/${escapeToken(kind)}/${number}`, limitations: ['This slot is not present in the supplied document; it may be a partial document.', ...doc.limitations] };
}

function leaves(data, parts = [], output = []) {
  if (data !== null && typeof data === 'object' && Object.keys(data).length) {
    for (const key of ordered(Object.keys(data))) leaves(data[key], [...parts, key], output);
  } else output.push({ pointer: pointer(parts), sourcePointer: pointer(parts), value: clone(data), valueType: valueType(data) });
  return output;
}
export function searchParameters(value, { query = '', prefix = '', offset = 0, limit = 50 } = {}) {
  const doc = docOf(value); assertText(query, 'query'); const parts = tokens(prefix), found = lookup(doc.data, parts);
  const needle = query.toLowerCase();
  const items = found.exists ? leaves(found.value, parts).filter(item => !needle || `${item.pointer} ${JSON.stringify(item.value)}`.toLowerCase().includes(needle)) : [];
  return page(items, { offset, limit }, { limitations: [...doc.limitations] });
}
export function getParameter(value, rawPointer) {
  const doc = docOf(value), parts = tokens(rawPointer), result = fact(doc.data, parts);
  return { pointer: rawPointer, ...result, limitations: result.exists ? [] : ['Absent means not present in this file, not a reset/default value.'] };
}

export function diffDocuments(beforeValue, afterValue, { prefix = '', offset = 0, limit = 100, numericTolerance = 0, ignoreMetadata = false } = {}) {
  const beforeDoc = docOf(beforeValue), afterDoc = docOf(afterValue), parts = tokens(prefix);
  if (typeof numericTolerance !== 'number' || !Number.isFinite(numericTolerance) || numericTolerance < 0) fail('INVALID_TOLERANCE', 'numericTolerance must be a finite nonnegative number.');
  if (typeof ignoreMetadata !== 'boolean') fail('INVALID_OPTION', 'ignoreMetadata must be boolean.');
  const changes = [];
  function compare(left, right, location) {
    if (ignoreMetadata && location.length === 1 && META.has(location[0])) return;
    if (left.exists && right.exists) {
      if (typeof left.value === 'number' && typeof right.value === 'number' && Math.abs(left.value - right.value) <= numericTolerance) return;
      if (Object.is(left.value, right.value)) return;
      const leftContainer = left.value !== null && typeof left.value === 'object';
      const rightContainer = right.value !== null && typeof right.value === 'object';
      if (leftContainer && rightContainer && Array.isArray(left.value) === Array.isArray(right.value)) {
        for (const key of ordered(new Set([...Object.keys(left.value), ...Object.keys(right.value)]))) {
          compare(own(left.value, key) ? { exists: true, value: left.value[key] } : { exists: false }, own(right.value, key) ? { exists: true, value: right.value[key] } : { exists: false }, [...location, key]);
        }
        return;
      }
    }
    if (!left.exists && !right.exists) return;
    const sourcePointer = pointer(location);
    changes.push({ operation: !left.exists ? 'added' : !right.exists ? 'removed' : 'changed', pointer: sourcePointer, sourcePointer,
      beforeExists: left.exists, afterExists: right.exists,
      ...(left.exists ? { before: clone(left.value), beforeType: valueType(left.value), beforeSourcePointer: sourcePointer } : {}),
      ...(right.exists ? { after: clone(right.value), afterType: valueType(right.value), afterSourcePointer: sourcePointer } : {}) });
  }
  compare(lookup(beforeDoc.data, parts), lookup(afterDoc.data, parts), parts);
  return page(changes, { offset, limit }, { limitations: [...new Set([...beforeDoc.limitations, ...afterDoc.limitations])], numericTolerance, ignoreMetadata });
}

function routeDestination(kind, routeKind, key) {
  if (routeKind === 'main' && isSlot(key)) return { kind: 'main', number: Number(key) };
  if (routeKind === 'send' && /^MX[1-9]\d*$/u.test(key) && isSlot(key.slice(2))) return { kind: 'mtx', number: Number(key.slice(2)) };
  if (routeKind === 'send' && ['ch', 'aux', 'bus'].includes(kind) && isSlot(key)) return { kind: 'bus', number: Number(key) };
  return null;
}
function outgoing(entry) {
  const routes = [];
  for (const routeKind of ['main', 'send']) if (object(entry.value[routeKind])) {
    for (const [key, raw] of Object.entries(entry.value[routeKind])) {
      routes.push({ destination: routeDestination(entry.kind, routeKind, key), routeKind, key, raw, parts: [...entry.parts, routeKind, key] });
    }
  }
  return routes;
}
export function traceRoutes(value, options = {}) {
  return traceRoutesDocument(docOf(value), options);
}

export function traceOutputRoutes(value, options = {}) {
  return traceOutputRoutesDocument(docOf(value), options);
}

function sceneEntries(doc) {
  const scenes = doc.data.scenes;
  // save_show increments its index from 0 before writing "%d" (ELF 0x6db9b0),
  // establishing 1-based native output. Retain a hand-edited/new-layout zero key
  // as raw evidence instead of silently dropping an unverified record.
  return object(scenes) ? ordered(Object.keys(scenes)).filter(key => isIndex(key) && Number.isSafeInteger(Number(key)) && object(scenes[key])).map(key => ({ number: Number(key), value: scenes[key], parts: ['scenes', key] })) : [];
}
export function listScenes(value, { offset = 0, limit = 100 } = {}) {
  const doc = docOf(value);
  const items = sceneEntries(doc).map(({ number, value: scene, parts }) => ({ number, sourcePointer: pointer(parts), raw: clone(scene), scene: clone(scene),
    numbering: number === 0 ? 'unverified_zero_key_retained' : 'native_writer_one_based',
    ...(own(scene, 'name') ? { name: clone(scene.name) } : {}), ...(own(scene, 'type') ? { type: clone(scene.type) } : {}), ...(own(scene, 'file') ? { file: clone(scene.file) } : {}),
    nameFact: fact(doc.data, [...parts, 'name']), typeFact: fact(doc.data, [...parts, 'type']), fileFact: fact(doc.data, [...parts, 'file']),
    skip: fact(doc.data, [...parts, 'skip']), link: fact(doc.data, [...parts, 'link']),
    referenceStatus: 'not_checked', interpretation: 'Scene metadata only; file existence/recall behavior is not checked by this pure module.' }));
  return page(items, { offset, limit }, { declaredCount: fact(doc.data, ['scenes', 'count']), limitations: [...doc.limitations] });
}

export function analyzeFindings(value, { offset = 0, limit = 100, severity = 'all' } = {}) {
  const doc = docOf(value), findings = [], entries = groupEntries(doc), inputs = new Map();
  if (!['all', 'info', 'warning', 'error'].includes(severity)) fail('INVALID_OPTION', 'severity must be all, info, warning or error.');
  const add = (code, message, sourcePointer, details = {}, severity = 'info') => findings.push({ severity, code, message, sourcePointer, ...details });
  for (const entry of entries.filter(entry => AUDIO_GROUPS.includes(entry.kind))) {
    const source = sourceSummary(doc, entry);
    if (['ch', 'aux'].includes(entry.kind) && source.effective?.reference && source.effective.status !== 'off') {
      const key = `${source.effective.reference.group}:${source.effective.reference.number}${source.effective.reference.side ? ':' + source.effective.reference.side : ''}`;
      if (!inputs.has(key)) inputs.set(key, []);
      inputs.get(key).push({ kind: entry.kind, number: entry.number, sourcePointer: source.effective.sourcePointer, mute: fact(doc.data, [...entry.parts, 'mute']) });
    }
    for (const route of outgoing(entry)) if (route.raw?.on === true) {
      const sp = pointer(route.parts), states = [];
      if (entry.value.mute === true) states.push(fact(doc.data, [...entry.parts, 'mute']));
      if (entry.value.fdr === -144) states.push(fact(doc.data, [...entry.parts, 'fdr']));
      if (states.length) add('ENABLED_ROUTE_WITH_MUTED_OR_MINIMUM_FADER', 'A route is explicitly enabled while its source strip is muted or its fader equals the observed -144 minimum; this is a file fact, not an inaudibility verdict.', sp, { states, route: clone(route.raw), source: { kind: entry.kind, number: entry.number } });
      if (route.destination && !entries.some(target => target.kind === route.destination.kind && target.number === route.destination.number)) add('ROUTE_TARGET_NOT_IN_DOCUMENT', 'An enabled structural route points to a slot not present in this document; partial documents may intentionally omit it.', sp, { reference: route.destination });
      if (!route.destination) add('ROUTE_DESTINATION_UNKNOWN', 'An enabled route has a destination token outside the bounded mapping.', sp, { rawDestination: route.key });
    }
    for (const which of ['primary', 'alternate']) if (source[which].status === 'target_not_in_document') {
      add('SOURCE_TARGET_NOT_IN_DOCUMENT', 'A recorded input reference has no corresponding input metadata in this file; this does not establish a missing physical source.', source[which].sourcePointer, { which, reference: source[which].reference, targetPointer: source[which].targetPointer });
    }
  }
  for (const [reference, channels] of inputs) if (channels.length > 1) add('DUPLICATE_SELECTED_INPUT', 'Multiple slots select the same recorded input. This may be an intentional split and is not inherently an error; selected does not mean audible.', channels[0].sourcePointer, { reference, channels });
  if (doc.kind === 'show') {
    const declared = fact(doc.data, ['scenes', 'count']), scenes = sceneEntries(doc);
    if (declared.exists && Number.isInteger(declared.value) && declared.value !== scenes.length) add('SCENE_COUNT_MISMATCH', 'scenes.count differs from the number of numbered scene records present.', declared.sourcePointer, { declaredCount: declared.value, recordsPresent: scenes.length });
    for (const scene of scenes) {
      if (own(scene.value, 'file') && typeof scene.value.file === 'string' && scene.value.file) add('SCENE_FILE_NOT_CHECKED', 'The scene references a file; this pure module does not access the filesystem or establish whether it exists.', pointer([...scene.parts, 'file']), { reference: scene.value.file });
    }
  }
  if (doc.coverage === 'partial') add('PARTIAL_COVERAGE', 'This type/version/layout has partial semantic coverage; generic JSON facts remain available.', '/type', { type: doc.type });
  return page(findings.filter(finding => severity === 'all' || finding.severity === severity), { offset, limit }, { limitations: [...doc.limitations] });
}
