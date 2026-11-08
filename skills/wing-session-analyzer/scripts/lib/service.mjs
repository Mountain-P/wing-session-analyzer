import fs from 'node:fs/promises';
import { constants, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  parseWingDocument, inspectDocument, listChannels, getChannel, searchParameters,
  getParameter, traceRoutes, diffDocuments, analyzeFindings, listScenes,
} from './analysis.mjs';

export const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;

export class AnalyzerError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AnalyzerError';
    this.code = code;
    this.details = details;
  }
}
const fail = (code, message, details) => { throw new AnalyzerError(code, message, details); };
const inside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

function positiveBound(value, fallback, max, name, allowZero = false) {
  const selected = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(selected) || selected < (allowZero ? 0 : 1) || selected > max) {
    fail('INVALID_ARGUMENT', `${name} must be an integer between ${allowZero ? 0 : 1} and ${max}.`);
  }
  return selected;
}

/** Root-confined, read-only local file operations shared by the CLI and MCP. */
export function createAnalyzerService({ roots, maxFileBytes = DEFAULT_MAX_FILE_BYTES, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES } = {}) {
  if (!Array.isArray(roots) || roots.length < 1) fail('ROOT_REQUIRED', 'Supply at least one explicit allowed directory with --root.');
  const rootEntries = roots.map(root => {
    if (typeof root !== 'string' || !path.isAbsolute(root)) fail('ROOT_INVALID', 'Allowed directories must use absolute paths.');
    try {
      const canonical = realpathSync(root);
      if (!statSync(canonical).isDirectory()) fail('ROOT_INVALID', 'An allowed root must be a directory.');
      return { selected: path.resolve(root), canonical };
    } catch (error) {
      if (error instanceof AnalyzerError) throw error;
      fail('ROOT_INVALID', 'An allowed directory does not exist or cannot be accessed.');
    }
  });
  const allowed = [...new Set(rootEntries.map(root => root.canonical))];
  const aliases = rootEntries.filter(root => root.selected !== root.canonical).sort((a, b) => b.selected.length - a.selected.length);
  positiveBound(maxFileBytes, DEFAULT_MAX_FILE_BYTES, 64 * 1024 * 1024, 'maxFileBytes');
  positiveBound(maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 4 * 1024 * 1024, 'maxOutputBytes');

  function requestedPath(value, base = allowed[0]) {
    if (typeof value !== 'string' || !value || value.includes('\0')) fail('INVALID_PATH', 'A local file path is required.');
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) fail('INVALID_PATH', 'URLs are not local session files.');
    let candidate = path.resolve(base, value);
    const alias = aliases.find(root => inside(root.selected, candidate));
    if (alias) candidate = path.resolve(alias.canonical, path.relative(alias.selected, candidate));
    if (!allowed.some(root => inside(root, candidate))) fail('OUTSIDE_ROOT', 'The requested path is outside the allowed directories.');
    return candidate;
  }

  async function authorizedPath(value, base, { directory = false } = {}) {
    const candidate = requestedPath(value, base);
    let canonical, stat;
    try { canonical = await fs.realpath(candidate); stat = await fs.stat(canonical); }
    catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') fail('FILE_NOT_FOUND', 'The selected local path was not found.');
      fail('FILE_UNREADABLE', 'The selected local path cannot be accessed.');
    }
    if (!allowed.some(root => inside(root, canonical))) fail('OUTSIDE_ROOT', 'The selected path resolves outside the allowed directories.');
    if (directory ? !stat.isDirectory() : !stat.isFile()) fail(directory ? 'NOT_DIRECTORY' : 'NOT_FILE', directory ? 'The selected asset root must be a directory.' : 'The selected session must be a regular file.');
    return { candidate, canonical, stat };
  }

  async function readDocument(filePath) {
    const location = await authorizedPath(filePath);
    if (location.stat.size > maxFileBytes) fail('FILE_TOO_LARGE', `Session exceeds the ${maxFileBytes}-byte input limit.`);
    let handle;
    try {
      handle = await fs.open(location.canonical, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const opened = await handle.stat();
      if (!opened.isFile() || opened.ino !== location.stat.ino || opened.dev !== location.stat.dev) fail('FILE_CHANGED', 'The selected file changed while it was opened; retry the analysis.');
      const chunks = [];
      let bytes = 0;
      while (bytes <= maxFileBytes) {
        const buffer = Buffer.alloc(Math.min(64 * 1024, maxFileBytes + 1 - bytes));
        const result = await handle.read(buffer, 0, buffer.length, null);
        if (!result.bytesRead) break;
        chunks.push(buffer.subarray(0, result.bytesRead));
        bytes += result.bytesRead;
      }
      if (bytes > maxFileBytes) fail('FILE_TOO_LARGE', `Session exceeds the ${maxFileBytes}-byte input limit.`);
      const current = await fs.realpath(location.candidate);
      if (current !== location.canonical || !allowed.some(root => inside(root, current))) fail('FILE_CHANGED', 'The selected file path changed while it was read; retry the analysis.');
      const buffer = Buffer.concat(chunks, bytes);
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
      catch { fail('INVALID_ENCODING', 'The selected file is not UTF-8 JSON. Binary WING-Live recordings are not supported.'); }
      const doc = parseWingDocument(text, { source: location.canonical });
      return {
        doc, location,
        evidence: {
          path: location.canonical,
          sha256: createHash('sha256').update(buffer).digest('hex'),
          bytes,
          sourceType: 'local-file',
          parserVersion: '0.1.0',
        },
      };
    } catch (error) {
      if (error instanceof AnalyzerError || typeof error.code === 'string' && !error.code.startsWith('E')) throw error;
      fail('FILE_UNREADABLE', 'The selected local session could not be read.');
    } finally { await handle?.close(); }
  }

  function bounded(result) {
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > maxOutputBytes) fail('RESPONSE_TOO_LARGE', 'Result exceeds the output limit. Use a narrower pointer, query, prefix or smaller page limit.');
    return result;
  }
  function page(options = {}) {
    return {
      ...options,
      offset: positiveBound(options.offset, 0, 1_000_000, 'offset', true),
      limit: positiveBound(options.limit, 50, 200, 'limit'),
    };
  }
  async function one({ path: filePath, ...options }, operation, paged = false) {
    const { doc, evidence } = await readDocument(filePath);
    const selected = paged ? page(options) : options;
    return bounded({ ...operation(doc, selected), evidence });
  }

  async function assets({ path: filePath, assetRoot, ...options }) {
    const { doc, evidence, location } = await readDocument(filePath);
    if (doc.kind !== 'show') fail('UNSUPPORTED_OPERATION', 'Asset checks require a showfile document.');
    const pageOptions = page(options);
    const root = assetRoot ? (await authorizedPath(assetRoot, undefined, { directory: true })).canonical : path.dirname(location.canonical);
    const scenes = listScenes(doc, { offset: 0, limit: 1000 });
    if (scenes.total > 10_000) fail('TOO_MANY_SCENES', 'Asset checks support up to 10000 scene entries per show. Use scene inspection for larger documents.');
    const allScenes = [...scenes.items];
    for (let offset = 1000; offset < scenes.total; offset += 1000) {
      allScenes.push(...listScenes(doc, { offset, limit: 1000 }).items);
    }
    const references = allScenes.filter(scene => {
      const raw = scene.raw || scene.scene || scene;
      const reference = scene.file ?? raw.file;
      return reference !== undefined && reference !== null && reference !== '';
    });
    const items = [];
    for (const scene of references.slice(pageOptions.offset, pageOptions.offset + pageOptions.limit)) {
      const raw = scene.raw || scene.scene || scene;
      const reference = scene.file ?? raw.file;
      if (reference === undefined || reference === null || reference === '') continue;
      const fact = {
        scene: scene.number ?? scene.id ?? scene.index ?? null,
        sceneName: scene.name ?? raw.name ?? '',
        reference,
        sourcePointer: `${scene.sourcePointer || '/scenes'}/file`,
      };
      if (typeof reference !== 'string' || reference.includes('\0')) { items.push({ ...fact, status: 'invalid_reference' }); continue; }
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(reference) || /^[a-z]:[\\/]/i.test(reference) || /^[\\]{2}/.test(reference)) {
        items.push({ ...fact, status: 'external_reference', note: 'Remote URLs, Windows drive paths and UNC references are not fetched or searched.' }); continue;
      }
      const normalized = reference.replaceAll('\\', '/');
      const candidate = path.resolve(root, normalized);
      if (!inside(root, candidate) || !allowed.some(allowedRoot => inside(allowedRoot, candidate))) { items.push({ ...fact, status: 'outside_asset_root' }); continue; }
      try {
        const canonical = await fs.realpath(candidate);
        if (!inside(root, canonical) || !allowed.some(allowedRoot => inside(allowedRoot, canonical))) {
          items.push({ ...fact, status: 'outside_asset_root' }); continue;
        }
        const stat = await fs.stat(canonical);
        items.push({ ...fact, resolvedPath: canonical, status: stat.isFile() ? 'present' : 'not_regular_file', ...(stat.isFile() ? { bytes: stat.size } : {}) });
      } catch (error) {
        items.push({ ...fact, status: ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'missing' : 'unreadable' });
      }
    }
    return bounded({
      items,
      total: references.length, offset: pageOptions.offset, limit: pageOptions.limit,
      hasMore: pageOptions.offset + pageOptions.limit < references.length,
      assetRoot: root,
      counts: Object.fromEntries([...new Set(items.map(item => item.status))].map(status => [status, items.filter(item => item.status === status).length])),
      countsScope: 'returned-page',
      evidence,
      limitations: ['References are checked only relative to the selected asset root; no global basename search or network access is performed.', 'A present file is not proof that Wing Edit can parse or recall it.', ...(doc.limitations || [])],
    });
  }

  return Object.freeze({
    roots: [...allowed],
    inspect: args => one(args, inspectDocument),
    channels: args => one(args, listChannels, true),
    channel: args => one(args, getChannel),
    search: args => one(args, searchParameters, true),
    parameter: args => one(args, (doc, options) => getParameter(doc, options.pointer)),
    routes: args => one(args, traceRoutes),
    findings: async args => {
      const { doc, evidence } = await readDocument(args.path);
      const options = page(args);
      if (args.severity && !['info', 'warning', 'error'].includes(args.severity)) fail('INVALID_ARGUMENT', 'severity must be info, warning or error.');
      return bounded({ ...analyzeFindings(doc, options), evidence });
    },
    scenes: args => one(args, listScenes, true),
    assets,
    diff: async ({ before, after, ...options }) => {
      const [a, b] = await Promise.all([readDocument(before), readDocument(after)]);
      const result = diffDocuments(a.doc, b.doc, page(options));
      return bounded({ ...result, evidence: { before: a.evidence, after: b.evidence } });
    },
  });
}
