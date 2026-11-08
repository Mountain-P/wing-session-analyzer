/** Pure, evidence-preserving reports. This module never reads or writes files. */
import {
  parseWingDocument, inspectDocument, listChannels, getParameter, traceRoutes,
  diffDocuments, analyzeFindings, listScenes,
} from './analysis.mjs';

const KINDS = new Set(['snapshot', 'show', 'snippet', 'channel_preset', 'fx_preset']);
const AUDIO_KINDS = new Set(['ch', 'aux', 'bus', 'main', 'mtx']);
const CHANNEL_KINDS = new Set([...AUDIO_KINDS, 'dca', 'mgrp']);
const META = new Set(['creator_fw', 'creator_sn', 'creator_model', 'creator_version', 'creator_name', 'created', 'updated']);
const COPY = value => JSON.parse(JSON.stringify(value));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const escapeToken = value => String(value).replaceAll('~', '~0').replaceAll('/', '~1');
const join = (base, key) => `${base}/${escapeToken(key)}`;
const decode = pointer => pointer === '' ? [] : pointer.slice(1).split('/').map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'));

function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function documentOf(value) { return object(value) && KINDS.has(value.kind) && object(value.data) ? value : parseWingDocument(value); }
function validatePage(offset, limit) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
    fail('INVALID_PAGE', 'Report offset must be nonnegative and limit must be between 1 and 1000.');
  }
}
function paged(items, offset, limit) { return { items: items.slice(offset, offset + limit), total: items.length, offset, limit, hasMore: offset + limit < items.length }; }
function collect(query, options = {}, maximum = 100000) {
  const first = query({ ...options, offset: 0, limit: 1000 });
  if (first.total > maximum) fail('REPORT_LIMIT', `This report requires ${first.total} records, exceeding the ${maximum} record budget. Use a narrower query or comparison prefix.`);
  const items = [...first.items];
  for (let offset = 1000; offset < first.total; offset += 1000) items.push(...query({ ...options, offset, limit: 1000 }).items);
  return items;
}
function fact(doc, pointer) { const { limitations, pointer: duplicatePointer, ...value } = getParameter(doc, pointer); return value; }
function parameter(doc, base, key, label, unit) {
  return { key, label, ...(unit ? { unit } : {}), ...fact(doc, join(base, key)) };
}

const FILTER_FIELDS = [
  ['lc', 'Low-cut enabled'], ['lcf', 'Low-cut frequency', 'Hz'], ['lcs', 'Low-cut slope token'],
  ['hc', 'High-cut enabled'], ['hcf', 'High-cut frequency', 'Hz'], ['hcs', 'High-cut slope token'],
];
const STD_EQ_FIELDS = [
  ['mix', 'EQ mix'], ['lf', 'Low-band frequency', 'Hz'], ['lg', 'Low-band gain', 'dB'], ['lq', 'Low-band Q'], ['leq', 'Low-band shape token'],
  ...[1, 2, 3, 4].flatMap(band => [[`${band}f`, `Band ${band} frequency`, 'Hz'], [`${band}g`, `Band ${band} gain`, 'dB'], [`${band}q`, `Band ${band} Q`]]),
  ['hf', 'High-band frequency', 'Hz'], ['hg', 'High-band gain', 'dB'], ['hq', 'High-band Q'], ['heq', 'High-band shape token'],
];
const DYNAMICS_FIELDS = [['thr', 'Threshold'], ['range', 'Range'], ['ratio', 'Ratio'], ['att', 'Attack'], ['hld', 'Hold'], ['rel', 'Release'], ['mix', 'Mix'], ['gain', 'Gain'], ['knee', 'Knee']];

function processingSection(doc, channelPointer, key, label) {
  const sourcePointer = join(channelPointer, key), section = fact(doc, sourcePointer);
  if (!section.exists) return { key, label, sourcePointer, exists: false, semanticCoverage: 'not_in_document' };
  const enabled = fact(doc, join(sourcePointer, 'on')), model = fact(doc, join(sourcePointer, 'mdl'));
  let fields = [], semanticCoverage = 'raw_model_parameters';
  if (!object(section.value)) semanticCoverage = 'unrecognized_section_layout';
  else if (key === 'flt') { fields = FILTER_FIELDS; semanticCoverage = 'common_filter_fields'; }
  else if (key === 'eq' && model.value === 'STD') { fields = STD_EQ_FIELDS; semanticCoverage = 'STD_parameter_summary'; }
  else if (key === 'gate' && model.value === 'GATE') { fields = DYNAMICS_FIELDS; semanticCoverage = 'GATE_parameter_summary'; }
  else if (key === 'dyn' && model.value === 'COMP') { fields = DYNAMICS_FIELDS; semanticCoverage = 'COMP_parameter_summary'; }
  else if (['preins', 'postins'].includes(key)) { fields = [['ins', 'Stored insert token'], ['mode', 'Stored insert mode']]; semanticCoverage = 'raw_insert_assignment'; }
  const parameters = fields.map(([field, fieldLabel, unit]) => parameter(doc, sourcePointer, field, fieldLabel, unit)).filter(value => value.exists);
  const covered = new Set(['on', 'mdl', ...parameters.map(value => value.key)]);
  const otherKeys = object(section.value) ? Object.keys(section.value).filter(field => !covered.has(field)) : [];
  return {
    key, label, sourcePointer, exists: section.exists, ...(section.exists ? { valueType: section.valueType } : {}),
    enabled, model, semanticCoverage, parameters,
    otherParameters: { keys: otherKeys.slice(0, 20), total: otherKeys.length, hasMore: otherKeys.length > 20 },
    rawValueAccess: { operation: 'getParameter', pointer: sourcePointer },
  };
}
function processing(doc, channelPointer) {
  return [['flt', 'Filters'], ['eq', 'EQ'], ['gate', 'Gate slot'], ['dyn', 'Dynamics slot'], ['preins', 'Pre insert'], ['postins', 'Post insert']]
    .map(([key, label]) => processingSection(doc, channelPointer, key, label));
}
function routeSummary(doc, channel) {
  if (!AUDIO_KINDS.has(channel.kind)) return { supported: false, reason: 'This control group is not an audio routing strip.' };
  const graph = traceRoutes(doc, { kind: channel.kind, number: channel.number, maxDepth: 8 });
  const byCode = {};
  for (const issue of graph.unresolved) byCode[issue.code] = (byCode[issue.code] || 0) + 1;
  const direct = graph.edges.filter(edge => edge.from === graph.start).map(edge => ({
    destination: edge.to, sourcePointer: edge.sourcePointer,
    level: fact(doc, join(edge.sourcePointer, 'lvl')), pre: fact(doc, join(edge.sourcePointer, 'pre')), mode: fact(doc, join(edge.sourcePointer, 'mode')),
  }));
  return {
    supported: true, interpretation: graph.interpretation, audibleOutput: graph.audibleOutput, maxDepth: graph.maxDepth,
    reachableNodes: graph.nodes.length, observedEdges: graph.edges.length,
    direct: { items: direct.slice(0, 8), total: direct.length, hasMore: direct.length > 8 },
    unresolved: { total: graph.unresolved.length, byCode, items: graph.unresolved.slice(0, 3).map(({ raw, ...issue }) => issue), hasMore: graph.unresolved.length > 3 },
    detailAccess: { operation: 'traceRoutes', kind: channel.kind, number: channel.number },
  };
}
function compactReference(value) {
  if (!value) return value;
  return Object.fromEntries(['status', 'sourcePointer', 'reference', 'targetPointer', 'label', 'mode'].filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
}
function compactChannel(channel) {
  const source = channel.source;
  return { ...channel, source: { selected: source.selected, automatic: source.automatic, alternateSelected: source.alternateSelected,
    primary: compactReference(source.primary), alternate: compactReference(source.alternate), effective: compactReference(source.effective) } };
}

/** Detailed lists are paged; overview and finding counts describe the whole document. */
export function buildSessionReport(value, { kind = 'all', offset = 0, limit = 10 } = {}) {
  validatePage(offset, limit);
  const doc = documentOf(value), overview = inspectDocument(doc);
  const channels = listChannels(doc, { kind, offset, limit });
  channels.items = channels.items.map(channel => ({ ...compactChannel(channel), processing: processing(doc, channel.sourcePointer), routes: routeSummary(doc, channel) }));
  const allFindings = collect(options => analyzeFindings(doc, options));
  const byCode = {}, bySeverity = {};
  for (const finding of allFindings) {
    byCode[finding.code] = (byCode[finding.code] || 0) + 1;
    bySeverity[finding.severity] = (bySeverity[finding.severity] || 0) + 1;
  }
  let scenes = null;
  if (doc.kind === 'show') {
    const page = listScenes(doc, { offset, limit });
    scenes = { ...page, items: page.items.map(({ raw, scene, ...entry }) => entry) };
  }
  let preset = null;
  if (doc.kind === 'channel_preset') preset = { sourceChannel: fact(doc, '/source_channel'), processing: processing(doc, '/ch_data'), rawValueAccess: { operation: 'getParameter', pointer: '/ch_data' } };
  if (doc.kind === 'fx_preset') preset = { sourceFxEngine: fact(doc, '/source_fx_engine'), data: { exists: fact(doc, '/fx_data').exists, sourcePointer: '/fx_data', semanticCoverage: 'raw_model_parameters' }, rawValueAccess: { operation: 'getParameter', pointer: '/fx_data' } };
  return {
    schemaVersion: 'wing-session-report.v1', overview, channels,
    findings: { ...paged(allFindings, offset, limit), summary: { total: allFindings.length, byCode, bySeverity, countsScope: 'entire-document' } },
    scenes, preset,
    sections: {
      overview: { scope: 'entire-document' }, channels: { scope: 'selected-kind-page', kind },
      findings: { scope: 'entire-document-summary-and-paged-details' },
      routing: { scope: 'displayed-channels-depth-8', physicalOutputMapping: 'unverified', audibility: 'not_determined' },
      dsp: { scope: 'stored-model-dependent-parameters', frequencyResponse: 'not_simulated' },
      assets: { scope: 'not_checked', operation: 'assets' },
    },
    limitations: [...doc.limitations, 'Report detail lists share offset/limit. Summary counts are complete, while displayed channels, findings and scenes are paged.', 'DSP parameters describe stored settings, including bypassed slots; no room response, automatic EQ or exact plugin response is inferred.'],
  };
}

function changeContext(change, before, after) {
  const parts = decode(change.pointer), channelPath = parts[0] === 'ae_data' && CHANNEL_KINDS.has(parts[1]) && /^[1-9]\d*$/.test(parts[2] || '');
  const channel = channelPath ? {
    kind: parts[1], number: Number(parts[2]), sourcePointer: `/ae_data/${parts[1]}/${parts[2]}`,
    beforeName: fact(before, `/ae_data/${parts[1]}/${parts[2]}/name`), afterName: fact(after, `/ae_data/${parts[1]}/${parts[2]}/name`),
  } : null;
  let groupKey = 'document', groupLabel = 'Document';
  if (channel) {
    groupKey = `${channel.kind}:${channel.number}`; groupLabel = `${channel.kind.toUpperCase()} ${channel.number}`;
    const beforeName = channel.beforeName.value, afterName = channel.afterName.value;
    if (typeof beforeName === 'string' && typeof afterName === 'string' && beforeName !== afterName) {
      groupLabel += ` (stored name: ${beforeName || '(empty)'} → ${afterName || '(empty)'})`;
    } else {
      const storedName = channel.afterName.exists ? afterName : beforeName;
      if (typeof storedName === 'string' && storedName) groupLabel += ` (stored name: ${storedName})`;
    }
  }
  else if (parts[0] === 'ae_data' && parts[1] === 'io') {
    groupKey = parts.slice(1, 5).join(':'); groupLabel = parts.slice(1, 5).join(' ');
  } else if (parts[0] === 'scenes') { groupKey = parts.slice(0, 2).join(':'); groupLabel = `Scene ${parts[1] || 'inventory'}`; }
  else if (parts.length) { groupKey = parts[0]; groupLabel = parts[0]; }
  const field = channel ? parts[3] : null;
  const category = META.has(parts[0]) ? 'metadata' : channel && ['name', 'col', 'icon', 'clink'].includes(field) ? 'identity'
    : channel && field === 'in' || parts[0] === 'ae_data' && parts[1] === 'io' && parts[2] === 'in' ? 'input'
      : channel && ['flt', 'eq', 'gate', 'dyn', 'preins', 'postins'].includes(field) ? 'processing'
        : channel && ['main', 'send', 'dir'].includes(field) || parts[0] === 'ae_data' && parts[1] === 'io' && parts[2] === 'out' ? 'routing'
          : channel && ['mute', 'fdr', 'pan', 'bal', 'wid'].includes(field) ? 'control' : 'other';
  let label = change.pointer || 'Document root';
  if (channel) {
    const relative = parts.slice(3).join('/');
    const known = {
      'name': 'Channel name', 'clink': 'Follow source customization', 'col': 'Channel color', 'mute': 'Channel mute', 'fdr': 'Channel fader',
      'in/conn/grp': 'Primary input group', 'in/conn/in': 'Primary input number', 'in/conn/altgrp': 'Alternate input group', 'in/conn/altin': 'Alternate input number',
      'in/set/srcauto': 'Automatic source switching', 'in/set/altsrc': 'Alternate source selected',
      'flt/lc': 'Low-cut enabled', 'flt/lcf': 'Low-cut frequency (Hz)', 'flt/hc': 'High-cut enabled', 'flt/hcf': 'High-cut frequency (Hz)',
      'eq/on': 'EQ enabled', 'eq/mdl': 'EQ model', 'gate/on': 'Gate slot enabled', 'gate/mdl': 'Gate slot model', 'dyn/on': 'Dynamics slot enabled', 'dyn/mdl': 'Dynamics slot model',
      'preins/on': 'Pre insert enabled', 'postins/on': 'Post insert enabled',
    };
    label = known[relative] || label;
    const band = /^eq\/([1-4])([fgq])$/.exec(relative);
    if (band) {
      const models = [fact(before, `${channel.sourcePointer}/eq/mdl`), fact(after, `${channel.sourcePointer}/eq/mdl`)].filter(value => value.exists);
      if (models.length && models.every(value => value.value === 'STD')) label = `EQ band ${band[1]} ${ { f: 'frequency (Hz)', g: 'gain (dB)', q: 'Q' }[band[2]]}`;
    }
    const send = /^(main|send)\/([^/]+)\/(on|lvl|pre|mode)$/.exec(relative);
    if (send) label = `${send[1] === 'main' ? 'Main' : 'Send'} ${send[2]} ${ { on: 'enabled', lvl: 'level', pre: 'pre flag', mode: 'mode token' }[send[3]]}`;
  }
  return { ...change, category, label, groupKey, groupLabel, channel };
}

/** Summaries include every diff record, including records beyond the requested page. */
export function compareSessions(beforeValue, afterValue, { prefix = '', ignoreMetadata = false, offset = 0, limit = 50 } = {}) {
  validatePage(offset, limit);
  const before = documentOf(beforeValue), after = documentOf(afterValue);
  const changes = collect(options => diffDocuments(before, after, options), { prefix, ignoreMetadata });
  const groups = new Map(), categories = {}, operations = {};
  const enriched = changes.map(change => {
    const result = changeContext(change, before, after);
    if (!groups.has(result.groupKey)) groups.set(result.groupKey, { key: result.groupKey, label: result.groupLabel, channel: result.channel, changes: 0, categories: {} });
    const group = groups.get(result.groupKey);
    group.changes++; group.categories[result.category] = (group.categories[result.category] || 0) + 1;
    categories[result.category] = (categories[result.category] || 0) + 1;
    operations[result.operation] = (operations[result.operation] || 0) + 1;
    return result;
  });
  return {
    schemaVersion: 'wing-session-comparison.v1',
    before: { type: before.type, kind: before.kind, coverage: before.coverage }, after: { type: after.type, kind: after.kind, coverage: after.coverage },
    prefix, ignoreMetadata, ...paged(enriched, offset, limit),
    summary: { totalChanges: changes.length, countUnit: 'diff-record', countsScope: 'entire-comparison', categories, operations, groups: [...groups.values()] },
    limitations: [...new Set([...before.limitations, ...after.limitations]), ...(before.kind !== after.kind ? ['Document kinds differ. This is a structural data comparison, not a comparison of equivalent complete console states.'] : []),
      'Changes are grouped by recorded channel slot, not matched across renamed or moved channels. Added/removed containers remain one diff record with their original values.', 'A settings change does not establish its audible effect or whether a recall will apply it.'],
  };
}

// Escape all data used in Markdown, including HTML, links, tables, fences and headings.
function markdown(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replace(/[\\*_[\]{}()#+.!|~\-]/g, '\\$&')
    .replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('`', '&#96;').replaceAll(':', '&#58;')
    .replace(/[\r\n\u2028\u2029]+/g, ' ↵ ').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '�');
}
function display(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return markdown(text.length > 600 ? `${text.slice(0, 600)} … [display shortened from ${text.length} characters; use the JSON Pointer for full data]` : text);
}
const factText = value => !value?.exists ? 'not in document' : display(value.value);
const pageText = page => `${page.items.length} shown; total ${page.total}; offset ${page.offset}; limit ${page.limit}; hasMore ${page.hasMore}`;
function evidenceLines(evidence) {
  if (!evidence) return [];
  if (evidence.before || evidence.after) return ['### Source evidence', ...['before', 'after'].flatMap(side => evidence[side] ? [`- ${side}: ${markdown(evidence[side].path)}; SHA-256 ${markdown(evidence[side].sha256)}`] : []), ''];
  return ['### Source evidence', `- Path: ${markdown(evidence.path)}`, `- SHA-256: ${markdown(evidence.sha256)}`, ...(evidence.bytes === undefined ? [] : [`- Bytes: ${evidence.bytes}`]), ''];
}
function renderSingle(report) {
  const lines = ['# WING session report', '', ...evidenceLines(report.evidence),
    `Type: ${markdown(report.overview.type)}; coverage: ${markdown(report.overview.coverage)}.`, '',
    '## Channel inventory', '', `${pageText(report.channels)}. Counts describe recorded slots, not used microphones.`, '',
    '| Strip | Stored / effective label | Selected input | Mute | Fader |', '| --- | --- | --- | --- | --- |'];
  for (const channel of report.channels.items) {
    const source = channel.source.effective?.reference;
    lines.push(`| ${markdown(`${channel.kind.toUpperCase()} ${channel.number}`)} | ${factText(channel.storedName)} / ${factText(channel.effectiveLabel)} | ${source ? markdown(`${source.group} ${source.number}`) : markdown(channel.source.selected)} | ${factText(channel.mute)} | ${factText(channel.fader)} |`);
  }
  for (const channel of report.channels.items) {
    lines.push('', `### ${markdown(`${channel.kind.toUpperCase()} ${channel.number}: ${channel.displayLabel}`)}`, '', `Evidence: ${markdown(channel.sourcePointer)}`, '');
    for (const section of channel.processing.filter(item => item.exists)) {
      lines.push(`- ${markdown(section.label)}: model ${factText(section.model)}; enabled ${factText(section.enabled)}; coverage ${markdown(section.semanticCoverage)}.`);
      for (const field of section.parameters) lines.push(`  - ${markdown(field.label)}: ${factText(field)}${field.unit ? ` ${markdown(field.unit)}` : ''}; ${markdown(field.sourcePointer)}`);
      if (section.otherParameters.total) lines.push(`  - ${section.otherParameters.total} other stored parameter keys; inspect ${markdown(section.sourcePointer)} for raw model data.`);
    }
    if (channel.routes.supported) {
      lines.push(`- Structural routing within depth ${channel.routes.maxDepth}: ${channel.routes.observedEdges} observed edges; ${channel.routes.unresolved.total} unresolved observations. Audible output is not determined.`);
      for (const route of channel.routes.direct.items) lines.push(`  - Enabled to ${markdown(route.destination)}; level ${factText(route.level)}; pre ${factText(route.pre)}; mode ${factText(route.mode)}; ${markdown(route.sourcePointer)}`);
      if (channel.routes.direct.hasMore) lines.push(`  - ${channel.routes.direct.items.length} of ${channel.routes.direct.total} direct sends shown; use the routing query for details.`);
    }
  }
  lines.push('', '## Findings', '', `${pageText(report.findings)}. Complete-document counts: ${display(report.findings.summary.byCode)}.`, '');
  for (const finding of report.findings.items) lines.push(`- ${markdown(finding.code)}: ${markdown(finding.message)} (${markdown(finding.sourcePointer)})`);
  if (report.scenes) {
    lines.push('', '## Scenes', '', `${pageText(report.scenes)}. References have not been checked by this report.`, '');
    for (const scene of report.scenes.items) lines.push(`- Scene ${scene.number}: ${factText(scene.nameFact)}; file ${factText(scene.fileFact)}; ${markdown(scene.sourcePointer)}`);
  }
  if (report.preset) {
    lines.push('', '## Preset', '', `Raw preset details: ${markdown(report.preset.rawValueAccess.pointer)}. The preset is not a complete console state.`);
    for (const section of report.preset.processing || []) if (section.exists) {
      lines.push(`- ${markdown(section.label)}: model ${factText(section.model)}; enabled ${factText(section.enabled)}; ${markdown(section.sourcePointer)}`);
      for (const field of section.parameters) lines.push(`  - ${markdown(field.label)}: ${factText(field)}; ${markdown(field.sourcePointer)}`);
    }
  }
  return lines;
}
function renderComparison(report) {
  const lines = ['# WING session comparison', '', ...evidenceLines(report.evidence),
    `${report.summary.totalChanges} diff records across the complete comparison; ignoreMetadata ${report.ignoreMetadata}; prefix ${markdown(report.prefix || '(document root)')}.`, '',
    '## Complete change summary', '', '| Group | Changes | Categories |', '| --- | --- | --- |'];
  for (const group of report.summary.groups) lines.push(`| ${markdown(group.label)} | ${group.changes} | ${display(group.categories)} |`);
  lines.push('', '## Change details', '', `${pageText(report)}.`, '', '| Group | Setting | Before | After | Evidence |', '| --- | --- | --- | --- | --- |');
  for (const item of report.items) lines.push(`| ${markdown(item.groupLabel)} | ${markdown(item.label)} | ${item.beforeExists ? display(item.before) : 'MISSING'} | ${item.afterExists ? display(item.after) : 'MISSING'} | ${markdown(item.pointer)} |`);
  return lines;
}

/** Format an already-computed result; data strings cannot inject Markdown/HTML. */
export function renderMarkdownReport(result) {
  if (!object(result)) fail('UNSUPPORTED_REPORT', 'Supply a session report, comparison or batch result.');
  let lines;
  if (result.schemaVersion === 'wing-session-report.v1') lines = renderSingle(result);
  else if (result.schemaVersion === 'wing-session-comparison.v1') lines = renderComparison(result);
  else if (result.schemaVersion === 'wing-session-batch.v1') {
    lines = ['# WING batch report', '', `Summary: ${display(result.summary)}.`, '', `${pageText(result)}. Counts scope: ${markdown(result.countsScope || result.summary?.countsScope || 'not specified')}.`];
    for (const item of result.items) {
      lines.push('', '---', '', `## ${markdown(item.path)}`, '', `Status: ${markdown(item.status)}.`, '');
      if (item.status === 'ok' && item.report) lines.push(...renderSingle(item.report));
      else lines.push(`Error: ${markdown(item.error?.code)} — ${markdown(item.error?.message)}`);
    }
  } else fail('UNSUPPORTED_REPORT', 'Unknown report schemaVersion.');
  if (result.limitations?.length) lines.push('', '## Limitations', '', ...result.limitations.map(value => `- ${markdown(value)}`));
  return lines.join('\n') + '\n';
}
