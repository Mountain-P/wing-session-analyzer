/** Offline routing graph. Decoders are limited to the snapshot.11 layout observed in WING Edit 3.3.4. */
const LOGICAL = Object.freeze({ BUS: { kind: 'bus', max: 32 }, MAIN: { kind: 'main', max: 8 }, MTX: { kind: 'mtx', max: 16 } });
const AUDIO = ['ch', 'aux', 'bus', 'main', 'mtx'];
const PHYSICAL = new Set(['LCL', 'AUX', 'A', 'B', 'C', 'SC', 'USB', 'CRD', 'MOD', 'PLAY', 'AES', 'OSC']);
// Address-space limits, not a claim that a selected model has every physical connector.
const RAW_LIMITS = Object.freeze({ LCL: 24, AUX: 8, A: 48, B: 48, C: 48, SC: 32, USB: 48, CRD: 64, MOD: 64, PLAY: 4, AES: 2, OSC: 2 });
const USER_LOGICAL = Object.freeze({ CH: { kind: 'ch', max: 40 }, AUX: { kind: 'aux', max: 8 }, BUS: { kind: 'bus', max: 16 }, MAIN: { kind: 'main', max: 4 }, MTX: { kind: 'mtx', max: 8 } });
const SPECIAL = Object.freeze({ SEND: { kind: 'fx_send', max: 32 }, MON: { kind: 'monitor', max: 4 } });
const EVIDENCE_BASIS = Object.freeze({
  sendSelector: 'native-save-samples-and-static-range',
  fxOwnership: 'native-save-samples-and-static-configured-assignments',
  monitorSelector: 'native-save-sample-ui-labels-and-static-range',
  monitorDependencies: 'native-saved-samples-and-static-enums',
  matrixMonitorInputs: 'static-token-mapping',
});
// Native static evidence exists; enabled only after independent WING Edit UI save-back confirmation.
const USER_DIRECT_VERIFIED = true;
const USER_RAW_VERIFIED = true;
const CODEC = 'wing-edit-3.3.4/snapshot.11';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => object(value) && Object.hasOwn(value, key);
const clone = value => JSON.parse(JSON.stringify(value));
const token = value => String(value).replaceAll('~', '~0').replaceAll('/', '~1');
const ptr = parts => '/' + parts.map(token).join('/');
const inputId = (group, number) => `input:${encodeURIComponent(group)}:${number}`;
const outputId = (bank, number) => `output:${encodeURIComponent(bank)}:${number}`;
const validNumber = value => Number.isSafeInteger(value) && value > 0;
const supported = doc => doc.type === 'snapshot.11';
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function lookup(doc, parts) {
  let value = doc.data;
  for (const part of parts) { if (!own(value, part)) return { exists: false, sourcePointer: ptr(parts) }; value = value[part]; }
  return { exists: true, value: clone(value), sourcePointer: ptr(parts) };
}

/** A source selector is decoded independently of whether its target metadata is included. */
export function decodeRoutingSource(doc, raw, sourcePointer, { consumer = 'general' } = {}) {
  const result = { sourcePointer, raw: object(raw) ? clone(raw) : raw, codec: CODEC };
  if (!object(raw) || typeof raw.grp !== 'string' || !validNumber(raw.in)) return { ...result, status: 'invalid_reference', reason: 'A source requires a group string and a positive integer index.' };
  if (raw.grp === 'OFF') return { ...result, status: 'off' };
  if (!supported(doc)) return { ...result, status: 'unsupported_layout', reason: 'The source-index codec is verified only for snapshot.11.' };
  if (consumer === 'channel_input' && ['SEND', 'MON'].includes(raw.grp)) return { ...result, status: 'unsupported_group_for_consumer', reason: 'The inspected channel input selector excludes SEND and MON; a general output selector cannot validate this field.' };
  const special = Object.hasOwn(SPECIAL, raw.grp) ? SPECIAL[raw.grp] : null;
  if (special) {
    if (raw.in > special.max) return { ...result, status: 'invalid_index', reason: 'The encoded FX send or monitor source index is outside the verified range.' };
    const number = Math.ceil(raw.in / 2), side = raw.in % 2 ? 'L' : 'R';
    return { ...result, status: 'decoded', id: `${special.kind}:${number}`, targetPointer: raw.grp === 'SEND' ? `/ae_data/fx/${number}` : `/ae_data/cfg/mon/${number}`,
      reference: { group: raw.grp, kind: special.kind, number, side, encodedIndex: raw.in } };
  }
  const logical = Object.hasOwn(LOGICAL, raw.grp) ? LOGICAL[raw.grp] : null;
  if (logical) {
    if (raw.in > logical.max) return { ...result, status: 'invalid_index', reason: 'The encoded logical source index is outside the verified range.' };
    const number = Math.ceil(raw.in / 2), side = raw.in % 2 ? 'L' : 'R';
    return { ...result, status: 'decoded', id: `${logical.kind}:${number}`, targetPointer: `/ae_data/${logical.kind}/${number}`,
      reference: { group: raw.grp, kind: logical.kind, number, side, encodedIndex: raw.in } };
  }
  if (raw.grp === 'USR') {
    if (raw.in > 56) return { ...result, status: 'invalid_index', reason: 'User source index is outside the inspected 1–56 layout.' };
    return { ...result, status: 'decoded', id: inputId(raw.grp, raw.in), targetPointer: `/ae_data/io/in/USR/${raw.in}`, reference: { group: raw.grp, number: raw.in } };
  }
  if (PHYSICAL.has(raw.grp)) {
    if (raw.in > RAW_LIMITS[raw.grp]) return { ...result, status: 'invalid_index', reason: 'The raw source index is outside the inspected address-space range; this is not a model-specific connector check.' };
    return { ...result, status: 'decoded', id: inputId(raw.grp, raw.in), targetPointer: `/ae_data/io/in/${token(raw.grp)}/${raw.in}`, reference: { group: raw.grp, number: raw.in } };
  }
  return { ...result, status: 'unsupported_group', reason: 'This source group has no verified decoder; its raw selector is retained.' };
}

function buildGraph(doc) {
  const nodes = new Map(), edges = [], problems = new Map();
  const addNode = node => { if (!nodes.has(node.id)) nodes.set(node.id, node); return nodes.get(node.id); };
  const issue = (owner, value) => { if (!problems.has(owner)) problems.set(owner, []); problems.get(owner).push(value); };
  const addEdge = edge => edges.push(edge);
  const strip = (kind, number) => {
    const id = `${kind}:${number}`, parts = ['ae_data', kind, String(number)], value = lookup(doc, parts);
    return addNode({ id, kind, number, sourcePointer: ptr(parts), exists: value.exists && object(value.value), mute: lookup(doc, [...parts, 'mute']), fader: lookup(doc, [...parts, 'fdr']) });
  };
  const fxSend = number => {
    const parts = ['ae_data', 'fx', String(number)], value = lookup(doc, parts);
    return addNode({ id: `fx_send:${number}`, kind: 'fx_send', number, sourcePointer: ptr(parts), exists: value.exists && object(value.value),
      virtual: true, routingRole: 'configured_insert_send_not_processed_return', model: lookup(doc, [...parts, 'mdl']), mix: lookup(doc, [...parts, 'fxmix']) });
  };
  const monitor = number => {
    const parts = ['ae_data', 'cfg', 'mon', String(number)], value = lookup(doc, parts);
    const soloParts = ['ae_data', 'cfg', 'solo'];
    return addNode({ id: `monitor:${number}`, kind: 'monitor', number, label: number === 1 ? 'PHONES' : 'SPEAKERS', sourcePointer: ptr(parts), exists: value.exists && object(value.value), virtual: true,
      selectors: { source: lookup(doc, [...parts, 'src']), directInput: lookup(doc, [...parts, 'dirin']) },
      levels: { sourceLevel: lookup(doc, [...parts, 'srclvl']), sourceMix: lookup(doc, [...parts, 'srcmix']), monitorLevel: lookup(doc, [...parts, 'lvl']) },
      soloContext: Object.fromEntries(['mode', 'mon', 'mute', 'chtap', 'bustap', 'maintap', 'mtxtap', 'srcsolo'].map(key => [key, lookup(doc, [...soloParts, key])])),
      runtimeSelection: 'not_determined' });
  };
  const source = decoded => {
    if (decoded.status !== 'decoded') return null;
    if (decoded.reference.kind === 'fx_send') return fxSend(decoded.reference.number);
    if (decoded.reference.kind === 'monitor') return monitor(decoded.reference.number);
    if (decoded.reference.kind) return strip(decoded.reference.kind, decoded.reference.number);
    const parts = ['ae_data', 'io', 'in', decoded.reference.group, String(decoded.reference.number)], value = lookup(doc, parts);
    return addNode({ id: decoded.id, kind: 'input_reference', reference: clone(decoded.reference), sourcePointer: ptr(parts), exists: value.exists && object(value.value), label: lookup(doc, [...parts, 'name']), mode: lookup(doc, [...parts, 'mode']),
      ...(decoded.reference.group === 'USR' ? { assignment: lookup(doc, [...parts, 'user']) } : {}) });
  };
  const registerSource = (owner, raw, location, edge, context) => {
    const decoded = decodeRoutingSource(doc, raw, location, context), node = source(decoded);
    if (!node) {
      if (decoded.status !== 'off') issue(owner, { code: 'SOURCE_REFERENCE_UNRESOLVED', sourcePointer: location, status: decoded.status, raw: clone(raw), reason: decoded.reason });
      return decoded;
    }
    if (!node.exists) issue(owner, { code: 'SOURCE_TARGET_NOT_IN_DOCUMENT', sourcePointer: location, targetPointer: decoded.targetPointer, reference: clone(decoded.reference), reason: 'The recorded reference is decoded but its target data is not included.' });
    if (edge) addEdge({ from: node.id, ...edge, sourcePointer: location, reference: clone(decoded.reference), side: decoded.reference.side ?? null, codec: decoded.codec });
    return decoded;
  };

  for (const kind of AUDIO) {
    const values = doc.data.ae_data?.[kind];
    if (!object(values)) continue;
    for (const [number, raw] of Object.entries(values)) if (/^[1-9]\d*$/.test(number) && validNumber(Number(number)) && object(raw)) strip(kind, Number(number));
  }
  const actualStrips = [...nodes.values()];
  for (const node of actualStrips) {
    const raw = doc.data.ae_data[node.kind][node.number], base = ['ae_data', node.kind, String(node.number)];
    if (['ch', 'aux'].includes(node.kind)) {
      const automatic = raw.in?.set?.srcauto, alternate = raw.in?.set?.altsrc;
      const selected = automatic === false && typeof alternate === 'boolean' ? alternate ? 'alternate' : 'primary' : null;
      for (const [label, groupKey, inputKey] of [['primary', 'grp', 'in'], ['alternate', 'altgrp', 'altin']]) {
        const connection = raw.in?.conn;
        if (!object(connection) || !Object.hasOwn(connection, groupKey) || !Object.hasOwn(connection, inputKey)) continue;
        registerSource(node.id, { grp: connection[groupKey], in: connection[inputKey] }, ptr([...base, 'in', 'conn']), { to: node.id, kind: 'input_candidate', candidate: label, selected: selected === null ? null : selected === label,
          interpretation: 'Recorded candidate input; only an explicit selected=true edge is followed as a configured dependency.' }, { consumer: 'channel_input' });
      }
      if (selected === null) issue(node.id, { code: 'EFFECTIVE_SOURCE_UNKNOWN', sourcePointer: ptr([...base, 'in', 'set']), reason: 'Automatic switching or omitted selection flags prevent a definite effective source.' });
    }
    for (const routeKind of ['main', 'send']) {
      if (!object(raw[routeKind])) continue;
      for (const [key, route] of Object.entries(raw[routeKind])) {
        const location = ptr([...base, routeKind, key]);
        if (!object(route)) { issue(node.id, { code: 'ROUTE_LAYOUT_UNKNOWN', sourcePointer: location, raw: clone(route) }); continue; }
        if (route.on === false) continue;
        if (route.on !== true) { issue(node.id, { code: 'ROUTE_ENABLE_UNKNOWN', sourcePointer: location, raw: clone(route) }); continue; }
        let destination;
        if (routeKind === 'main' && /^[1-9]\d*$/.test(key) && validNumber(Number(key))) destination = strip('main', Number(key));
        else if (routeKind === 'send' && /^MX[1-9]\d*$/.test(key) && validNumber(Number(key.slice(2)))) destination = strip('mtx', Number(key.slice(2)));
        else if (routeKind === 'send' && ['ch', 'aux', 'bus'].includes(node.kind) && /^[1-9]\d*$/.test(key) && validNumber(Number(key))) destination = strip('bus', Number(key));
        if (!destination) { issue(node.id, { code: 'ROUTE_DESTINATION_UNKNOWN', sourcePointer: location, rawDestination: key, raw: clone(route) }); continue; }
        addEdge({ from: node.id, to: destination.id, kind: routeKind, enabled: true, sourcePointer: location, raw: clone(route), interpretation: 'Stored enabled routing relationship, not an audible-path verdict.' });
        if (!destination.exists) issue(destination.id, { code: 'ROUTE_TARGET_NOT_IN_DOCUMENT', sourcePointer: location, targetPointer: destination.sourcePointer, reference: { kind: destination.kind, number: destination.number }, reason: 'The referenced strip is absent; its state remains unknown.' });
      }
    }
    if (object(raw.dir)) {
      if (raw.dir.on === true) {
        const location = ptr([...base, 'dir']);
        // This is the matrix direct INPUT selector, not a channel Direct Out assignment.
        if (node.kind === 'mtx' && supported(doc) && ['AES', 'MON.PH', 'MON.SPK', 'MON.BUS'].includes(raw.dir.in)) {
          let id;
          if (['MON.PH', 'MON.SPK'].includes(raw.dir.in)) id = monitor(raw.dir.in === 'MON.PH' ? 1 : 2).id;
          else {
            id = `direct-input:${encodeURIComponent(raw.dir.in)}`;
            addNode({ id, kind: 'direct_input_source', token: raw.dir.in, sourcePointer: `${location}/in`, physicalMapping: 'not_expanded', ...(raw.dir.in === 'MON.BUS' ? { runtimeSelection: 'not_determined' } : {}) });
            if (raw.dir.in === 'MON.BUS') issue(id, { code: 'MONITOR_BUS_RUNTIME_STATE_UNKNOWN', sourcePointer: `${location}/in`, reason: 'MON.BUS is a distinct internal monitor/solo bus; its live contribution set is not captured by saved monitor selectors.' });
          }
          addEdge({ from: id, to: node.id, kind: 'matrix_direct_input', enabled: true, sourcePointer: location, raw: clone(raw.dir), interpretation: 'Stored matrix direct-input assignment; monitor output references share their configuration nodes, while internal bus/AES paths remain boundaries.' });
        } else if (raw.dir.in !== 'OFF') issue(node.id, { code: 'DIRECT_INPUT_TOKEN_UNRESOLVED', sourcePointer: location, raw: clone(raw.dir), reason: 'This direct-input token has no verified expansion.' });
      } else if (raw.dir.on !== false) issue(node.id, { code: 'DIRECT_INPUT_ENABLE_UNKNOWN', sourcePointer: ptr([...base, 'dir']), raw: clone(raw.dir) });
    }
  }

  const fxClaims = new Map();
  if (supported(doc)) for (const node of actualStrips) {
    const raw = doc.data.ae_data[node.kind][node.number];
    for (const position of ['preins', 'postins']) {
      const assignment = raw[position], location = `/ae_data/${node.kind}/${node.number}/${position}`;
      if (!object(assignment) || assignment.ins === 'NONE' || !Object.hasOwn(assignment, 'ins')) continue;
      const match = typeof assignment.ins === 'string' ? /^FX([1-9]\d*)$/.exec(assignment.ins) : null;
      if (!match || Number(match[1]) > 16) { issue(node.id, { code: 'INSERT_ASSIGNMENT_UNRESOLVED', sourcePointer: location, raw: clone(assignment), reason: 'The insert assignment is not a verified FX1–FX16 token.' }); continue; }
      const stripLimit = { ch: 40, aux: 8, bus: 16, main: 4, mtx: 8 }[node.kind];
      if (node.number > stripLimit) { issue(node.id, { code: 'INSERT_STRIP_RANGE_UNVERIFIED', sourcePointer: location, raw: clone(assignment), reason: 'The recorded strip number is outside the inspected insert-owner layout.' }); continue; }
      if (node.kind === 'aux' && position === 'postins') { issue(node.id, { code: 'INSERT_POSITION_UNVERIFIED', sourcePointer: location, raw: clone(assignment), reason: 'An AUX post-insert is not part of the inspected saved layout.' }); continue; }
      const number = Number(match[1]), target = fxSend(number);
      let eligible = true;
      if (node.kind === 'ch' && position === 'postins' && assignment.mode !== 'FX') {
        if (['AUTO_X', 'AUTO_Y'].includes(assignment.mode)) { issue(node.id, { code: 'INSERT_NOT_FX_MODE', sourcePointer: location, raw: clone(assignment), reason: 'This post-insert is assigned to automix, not an FX send.' }); continue; }
        eligible = false;
      }
      if (!fxClaims.has(number)) fxClaims.set(number, []);
      fxClaims.get(number).push({ from: node.id, to: target.id, position, sourcePointer: location, raw: clone(assignment), eligible,
        insertEnabled: lookup(doc, ['ae_data', node.kind, String(node.number), position, 'on']) });
    }
  }

  if (supported(doc) && object(doc.data.ae_data?.cfg?.mon)) for (const number of [1, 2]) if (own(doc.data.ae_data.cfg.mon, String(number))) monitor(number);

  const users = doc.data.ae_data?.io?.in?.USR;
  if (object(users)) for (const [key, raw] of Object.entries(users)) {
    if (!/^[1-9]\d*$/.test(key) || !validNumber(Number(key)) || !object(raw)) continue;
    const number = Number(key), decoded = decodeRoutingSource(doc, { grp: 'USR', in: number }, `/ae_data/io/in/USR/${key}`), node = source(decoded);
    const location = `/ae_data/io/in/USR/${key}/user`;
    if (!node) continue;
    if (!object(raw.user)) { issue(node.id, { code: 'USER_SIGNAL_LAYOUT_UNKNOWN', sourcePointer: location, reason: 'The user-signal assignment is absent or not an object.' }); continue; }
    if (raw.user.grp === 'OFF') continue;
    if (!(number <= 24 ? USER_DIRECT_VERIFIED : USER_RAW_VERIFIED) || !supported(doc)) { issue(node.id, { code: 'USER_SIGNAL_MAPPING_UNVERIFIED', sourcePointer: location, raw: clone(raw.user), reason: 'User-signal expansion is awaiting runtime save-back verification.' }); continue; }
    const assignment = raw.user;
    if (number <= 24 && Object.hasOwn(USER_LOGICAL, assignment.grp)) {
      const logical = USER_LOGICAL[assignment.grp];
      if (!validNumber(assignment.in) || assignment.in > logical.max || !['PRE', 'POST'].includes(assignment.tap) || !['L+R', 'L', 'R'].includes(assignment.lr)) {
        issue(node.id, { code: 'USER_SIGNAL_ASSIGNMENT_UNRESOLVED', sourcePointer: location, raw: clone(assignment) }); continue;
      }
      const upstream = strip(logical.kind, assignment.in);
      addEdge({ from: upstream.id, to: node.id, kind: 'user_signal', sourcePointer: location, raw: clone(assignment), side: assignment.lr, sideInterpretation: assignment.lr === 'L+R' ? 'stored_mono_sum_selection' : 'stored_channel_side', tap: assignment.tap,
        ...(assignment.tap === 'PRE' && ['ch', 'aux'].includes(logical.kind) ? { channelTap: lookup(doc, ['ae_data', logical.kind, String(assignment.in), 'ptap']), tapInterpretation: 'stored_channel_tap' } : { tapInterpretation: 'stored_user_tap_token' }), codec: CODEC });
      if (!upstream.exists) issue(node.id, { code: 'USER_SIGNAL_TARGET_NOT_IN_DOCUMENT', sourcePointer: location, targetPointer: upstream.sourcePointer });
    } else if (number >= 25 && number <= 56 && PHYSICAL.has(assignment.grp) && assignment.grp !== 'OSC') {
      registerSource(node.id, assignment, location, { to: node.id, kind: 'user_signal', interpretation: 'Recorded raw input source assigned to a user signal.' });
    } else issue(node.id, { code: 'USER_SIGNAL_ASSIGNMENT_UNRESOLVED', sourcePointer: location, raw: clone(assignment) });
  }

  const outputs = doc.data.ae_data?.io?.out;
  if (object(outputs)) for (const [bank, values] of Object.entries(outputs)) {
    if (!object(values)) continue;
    for (const [slot, raw] of Object.entries(values)) {
      if (!/^[1-9]\d*$/.test(slot) || !validNumber(Number(slot))) continue;
      const location = ptr(['ae_data', 'io', 'out', bank, slot]), decoded = decodeRoutingSource(doc, raw, location);
      const node = addNode({ id: outputId(bank, Number(slot)), kind: 'output_patch', bank, number: Number(slot), exists: true, sourcePointer: location, source: decoded, physicalPortValidation: 'not_performed' });
      const upstream = source(decoded);
      if (upstream) {
        addEdge({ from: upstream.id, to: node.id, kind: 'output_patch', sourcePointer: location, side: decoded.reference.side ?? null, reference: clone(decoded.reference), raw: clone(raw), codec: CODEC,
          interpretation: 'The file assigns this source/side to this output patch; hardware and audibility are not validated.' });
        if (!upstream.exists) issue(node.id, { code: 'OUTPUT_SOURCE_TARGET_NOT_IN_DOCUMENT', sourcePointer: location, targetPointer: decoded.targetPointer, reference: clone(decoded.reference) });
      } else if (decoded.status !== 'off') issue(node.id, { code: 'OUTPUT_SOURCE_UNRESOLVED', sourcePointer: location, raw: object(raw) ? clone(raw) : raw, status: decoded.status, reason: decoded.reason });
    }
  }
  for (const node of [...nodes.values()].filter(node => node.kind === 'fx_send')) {
    const claims = fxClaims.get(node.number) || [];
    if (claims.length === 0) issue(node.id, { code: 'FX_SEND_OWNER_NOT_IN_DOCUMENT', sourcePointer: node.sourcePointer, reason: 'No configured insert owner is recorded for this FX send; the document may omit relevant strips.' });
    else if (claims.length === 1 && claims[0].eligible) {
      const { eligible, ...claim } = claims[0];
      addEdge({ ...claim, kind: 'fx_send', configured: true, ownershipScope: 'recorded-document-assignments', interpretation: 'Configured insert send dependency. Insert on/off is retained separately; bypass, processed return and stereo DSP are not simulated.' });
    } else {
      issue(node.id, { code: claims.length > 1 ? 'FX_SEND_OWNER_AMBIGUOUS' : 'FX_SEND_OWNER_MODE_UNRESOLVED', sourcePointer: node.sourcePointer, candidateCount: claims.length,
        reason: claims.length > 1 ? 'Several recorded inserts claim this FX send. Native ownership arbitration is not simulated; candidates are shown without traversing them as definite dependencies.' : 'The channel post-insert does not record a verified FX mode; its owner is only a candidate.' });
      for (const { eligible, ...claim } of claims) addEdge({ ...claim, kind: 'fx_send_candidate', selected: null, traversed: false, interpretation: 'Unresolved possible FX-send owner; context only, not a summed or selected signal path.' });
    }
  }
  for (const node of [...nodes.values()].filter(node => node.kind === 'monitor')) {
    const parts = ['ae_data', 'cfg', 'mon', String(node.number)];
    issue(node.id, { code: 'MONITOR_RUNTIME_STATE_UNKNOWN', sourcePointer: '/ae_data/cfg/solo', monitorPointer: node.sourcePointer,
      reason: 'Saved source/direct-input dependencies do not determine live solo/PFL/SIP, mute, dim, talkback, or which source level/mix is currently used. Solo settings are context, not active contributions.' });
    if (!node.exists) continue;
    for (const [selector, kind] of [['src', 'monitor_source'], ['dirin', 'monitor_direct_input']]) {
      const selected = lookup(doc, [...parts, selector]);
      if (!selected.exists) { issue(node.id, { code: 'MONITOR_SELECTOR_NOT_IN_DOCUMENT', sourcePointer: selected.sourcePointer, reason: 'This saved monitor selector is absent; no default is substituted.' }); continue; }
      if (selected.value === 'OFF') continue;
      const match = typeof selected.value === 'string' ? /^(CH|AUX|BUS|MAIN|MTX)\.([1-9]\d*)$/.exec(selected.value) : null;
      const logical = match && Object.hasOwn(USER_LOGICAL, match[1]) ? USER_LOGICAL[match[1]] : null;
      if (!logical || Number(match[2]) > logical.max || selector === 'src' && match[1] === 'CH') { issue(node.id, { code: 'MONITOR_SOURCE_TOKEN_UNRESOLVED', sourcePointer: selected.sourcePointer, raw: selected.value, reason: 'This token is not in the inspected monitor selector namespace.' }); continue; }
      const upstream = strip(logical.kind, Number(match[2]));
      addEdge({ from: upstream.id, to: node.id, kind, configured: true, sourcePointer: selected.sourcePointer, raw: selected.value, reference: { group: match[1], kind: logical.kind, number: Number(match[2]) },
        levels: clone(node.levels), runtimeSelected: 'not_determined', interpretation: 'Stored monitor dependency, not an exclusive current audio source. Saved levels do not gate this structural relationship.' });
      if (!upstream.exists) issue(node.id, { code: 'MONITOR_SOURCE_TARGET_NOT_IN_DOCUMENT', sourcePointer: selected.sourcePointer, targetPointer: upstream.sourcePointer });
    }
  }
  return { nodes, edges, problems };
}

function trace(doc, { start, direction, maxDepth }) {
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 32) fail('INVALID_DEPTH', 'maxDepth must be an integer from 0 to 32.');
  const graph = buildGraph(doc), selectedNodes = new Map(), selectedEdges = new Map(), unresolved = [], problemKeys = new Set(), visited = new Set();
  const addIssues = id => { for (const issue of graph.problems.get(id) || []) { const key = JSON.stringify(issue); if (!problemKeys.has(key)) { problemKeys.add(key); unresolved.push(issue); } } };
  const include = id => { const node = graph.nodes.get(id); if (node) { selectedNodes.set(id, node); addIssues(id); } return node; };
  const includeEdge = edge => selectedEdges.set(`${edge.kind}:${edge.sourcePointer}:${edge.from}:${edge.to}:${edge.candidate || ''}`, edge);
  const adjacent = new Map();
  for (const edge of graph.edges) { const id = direction === 'downstream' ? edge.from : edge.to; if (!adjacent.has(id)) adjacent.set(id, []); adjacent.get(id).push(edge); }
  const initial = graph.nodes.get(start), queue = [{ id: start, depth: 0, seenStrip: !!initial && AUDIO.includes(initial.kind) }];
  if (!initial) unresolved.push({ code: direction === 'upstream' ? 'OUTPUT_NOT_IN_DOCUMENT' : 'SLOT_NOT_IN_DOCUMENT', reference: start, reason: 'The selected starting point is not present in this document.' });
  while (queue.length) {
    const current = queue.shift();
    if (visited.has(current.id)) continue;
    visited.add(current.id);
    const node = include(current.id);
    if (!node) continue;
    if (direction === 'downstream' && ['ch', 'aux'].includes(node.kind)) for (const edge of graph.edges.filter(edge => edge.kind === 'input_candidate' && edge.to === node.id)) { include(edge.from); includeEdge(edge); }
    for (const edge of adjacent.get(current.id) || []) {
      const nextId = direction === 'downstream' ? edge.to : edge.from, next = graph.nodes.get(nextId);
      includeEdge(edge);
      if (edge.kind === 'input_candidate' && edge.selected !== true || edge.traversed === false) { include(nextId); continue; }
      const stripStep = !!next && AUDIO.includes(next.kind) && current.seenStrip ? 1 : 0;
      const depth = current.depth + stripStep;
      if (depth > maxDepth) {
        unresolved.push({ code: 'MAX_DEPTH_REACHED', reference: nextId, sourcePointer: edge.sourcePointer, maxDepth }); continue;
      }
      const queued = { id: nextId, depth, seenStrip: current.seenStrip || !!next && AUDIO.includes(next.kind) };
      if (stripStep === 0) queue.unshift(queued); else queue.push(queued);
    }
  }
  const nodes = [...selectedNodes.values()].map(node => ({ ...node, contextOnly: !visited.has(node.id) })), edges = [...selectedEdges.values()];
  const allOutputs = [...graph.nodes.values()].filter(node => node.kind === 'output_patch');
  const outputStatus = Object.fromEntries([...new Set(allOutputs.map(node => node.source.status))].map(status => [status, allOutputs.filter(node => node.source.status === status).length]));
  return { start, direction, sourcePointer: initial?.sourcePointer ?? '', nodes, edges, outputs: nodes.filter(node => node.kind === 'output_patch'), unresolved, maxDepth,
    depthUnit: 'logical-strip-hops', terminalPatchEdgesConsumeDepth: false, interpretation: 'structural_reachability_only', audibleOutput: 'not_determined',
    coverage: { codec: CODEC, supportedType: supported(doc), physicalOutputMapping: supported(doc) ? 'verified_source_groups_only' : 'unsupported_layout',
      evidenceBasis: Object.fromEntries(Object.entries(EVIDENCE_BASIS).map(([key, basis]) => [key, supported(doc) ? basis : 'unsupported_layout'])), userSignalAssignments: {
      direct: supported(doc) ? USER_DIRECT_VERIFIED ? 'verified_layout' : 'not_verified' : 'unsupported_layout', raw: supported(doc) ? USER_RAW_VERIFIED ? 'verified_layout' : 'not_verified' : 'unsupported_layout',
    }, fxSendSources: supported(doc) ? 'verified_selectors_configured_insert_owners' : 'unsupported_layout', monitorSources: supported(doc) ? 'verified_selectors_configured_dependencies_runtime_unknown' : 'unsupported_layout',
      matrixDirectInputs: supported(doc) ? 'monitor_outputs_and_named_runtime_boundaries' : 'unsupported_layout', outputPatches: { total: allOutputs.length, byStatus: outputStatus, countsScope: 'entire-document' } },
    limitations: [...doc.limitations, 'Only stored explicit routing and selected input dependencies are traversed. Muting, tap order, inserts, DCA and runtime state are not simulated.',
      'Output L/R labels describe the selected source side; they do not simulate stereo propagation through processing or prove physical cabling.',
      'Logical depth counts strip hops; terminal patch/user-signal connections do not consume a strip hop. Non-selected and runtime-unknown input candidates are shown but not followed.'],
  };
}

export function traceRoutesDocument(doc, options = {}) {
  if (!object(options) || Object.keys(options).some(key => !['kind', 'number', 'maxDepth'].includes(key))) fail('INVALID_OPTION', 'Route tracing accepts only kind, number and maxDepth.');
  const { kind = 'ch', number = 1, maxDepth = 8 } = options;
  if (!AUDIO.includes(kind) || !validNumber(number)) fail('INVALID_ROUTE_START', 'Select a positive ch/aux/bus/main/mtx slot.');
  return trace(doc, { start: `${kind}:${number}`, direction: 'downstream', maxDepth });
}

export function traceOutputRoutesDocument(doc, options = {}) {
  if (!object(options) || Object.keys(options).some(key => !['bank', 'number', 'maxDepth'].includes(key))) fail('INVALID_OPTION', 'Output route tracing accepts only bank, number and maxDepth.');
  const { bank, number = 1, maxDepth = 8 } = options;
  if (typeof bank !== 'string' || !bank || bank.length > 256 || !validNumber(number)) fail('INVALID_OUTPUT_START', 'Select a nonempty output bank and positive slot number.');
  return trace(doc, { start: outputId(bank, number), direction: 'upstream', maxDepth });
}
