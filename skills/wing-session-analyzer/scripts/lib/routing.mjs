/** Offline routing graph. Decoders are limited to the snapshot.11 layout observed in WING Edit 3.3.4. */
const LOGICAL = Object.freeze({ BUS: { kind: 'bus', max: 32 }, MAIN: { kind: 'main', max: 8 }, MTX: { kind: 'mtx', max: 16 } });
const AUDIO = ['ch', 'aux', 'bus', 'main', 'mtx'];
const PHYSICAL = new Set(['LCL', 'AUX', 'A', 'B', 'C', 'SC', 'USB', 'CRD', 'MOD', 'PLAY', 'AES', 'OSC']);
// Address-space limits, not a claim that a selected model has every physical connector.
const RAW_LIMITS = Object.freeze({ LCL: 24, AUX: 8, A: 48, B: 48, C: 48, SC: 32, USB: 48, CRD: 64, MOD: 64, PLAY: 4, AES: 2, OSC: 2 });
const USER_LOGICAL = Object.freeze({ CH: { kind: 'ch', max: 40 }, AUX: { kind: 'aux', max: 8 }, BUS: { kind: 'bus', max: 16 }, MAIN: { kind: 'main', max: 4 }, MTX: { kind: 'mtx', max: 8 } });
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
export function decodeRoutingSource(doc, raw, sourcePointer) {
  const result = { sourcePointer, raw: object(raw) ? clone(raw) : raw, codec: CODEC };
  if (!object(raw) || typeof raw.grp !== 'string' || !validNumber(raw.in)) return { ...result, status: 'invalid_reference', reason: 'A source requires a group string and a positive integer index.' };
  if (raw.grp === 'OFF') return { ...result, status: 'off' };
  if (!supported(doc)) return { ...result, status: 'unsupported_layout', reason: 'The source-index codec is verified only for snapshot.11.' };
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
  const source = decoded => {
    if (decoded.status !== 'decoded') return null;
    if (decoded.reference.kind) return strip(decoded.reference.kind, decoded.reference.number);
    const parts = ['ae_data', 'io', 'in', decoded.reference.group, String(decoded.reference.number)], value = lookup(doc, parts);
    return addNode({ id: decoded.id, kind: 'input_reference', reference: clone(decoded.reference), sourcePointer: ptr(parts), exists: value.exists && object(value.value), label: lookup(doc, [...parts, 'name']), mode: lookup(doc, [...parts, 'mode']),
      ...(decoded.reference.group === 'USR' ? { assignment: lookup(doc, [...parts, 'user']) } : {}) });
  };
  const registerSource = (owner, raw, location, edge) => {
    const decoded = decodeRoutingSource(doc, raw, location), node = source(decoded);
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
          interpretation: 'Recorded candidate input; only an explicit selected=true edge is followed as a configured dependency.' });
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
          const id = `direct-input:${encodeURIComponent(raw.dir.in)}`;
          addNode({ id, kind: 'direct_input_source', token: raw.dir.in, sourcePointer: `${location}/in`, physicalMapping: 'not_expanded' });
          addEdge({ from: id, to: node.id, kind: 'matrix_direct_input', enabled: true, sourcePointer: location, raw: clone(raw.dir), interpretation: 'Named matrix direct-input source; its internal monitor/AES path is not expanded.' });
        } else if (raw.dir.in !== 'OFF') issue(node.id, { code: 'DIRECT_INPUT_TOKEN_UNRESOLVED', sourcePointer: location, raw: clone(raw.dir), reason: 'This direct-input token has no verified expansion.' });
      } else if (raw.dir.on !== false) issue(node.id, { code: 'DIRECT_INPUT_ENABLE_UNKNOWN', sourcePointer: ptr([...base, 'dir']), raw: clone(raw.dir) });
    }
  }

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
      if (edge.kind === 'input_candidate' && edge.selected !== true) { include(nextId); continue; }
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
    coverage: { codec: CODEC, supportedType: supported(doc), physicalOutputMapping: supported(doc) ? 'verified_source_groups_only' : 'unsupported_layout', userSignalAssignments: {
      direct: supported(doc) ? USER_DIRECT_VERIFIED ? 'verified_layout' : 'not_verified' : 'unsupported_layout', raw: supported(doc) ? USER_RAW_VERIFIED ? 'verified_layout' : 'not_verified' : 'unsupported_layout',
    }, matrixDirectInputs: supported(doc) ? 'named_tokens_only' : 'unsupported_layout', outputPatches: { total: allOutputs.length, byStatus: outputStatus, countsScope: 'entire-document' } },
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
