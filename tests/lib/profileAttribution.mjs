/**
 * Attributing a CDP CPU profile of the editor to SOURCE files and functions —
 * the half of issue #113 the minified bundle made impossible: a profile of
 * editor.html names `Ft editor.html:40`, which says nothing about which plugin
 * or which ProseMirror path spent the frame.
 *
 * Two pure pieces, so the device script (tests/android-editor-attribution.mjs)
 * is only plumbing:
 *
 * - `scriptsFromParsedEvents` turns the `Debugger.scriptParsed` events of a page
 *   into a lookup from V8 script id to that script's inline source map (the
 *   bundle is built with `build.sourcemap: 'inline'`) plus the offset of the
 *   inline <script> inside editor.html — V8 reports an inline script's call
 *   frames in DOCUMENT coordinates, the map in SCRIPT coordinates.
 * - `attributeProfile` folds the profile's samples by resolved function,
 *   source file and owner (the repo area or the npm package).
 */

import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';

const INLINE_MAP = /^data:application\/json(?:;charset=[^;,]+)?;base64,(.+)$/s;

/** The source-map JSON from a `data:` sourceMapURL, or null for any other URL. */
export function decodeInlineSourceMap(sourceMapURL) {
  const match = INLINE_MAP.exec(sourceMapURL ?? '');
  if (!match) return null;
  return JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
}

/**
 * `{ scriptId → { startLine, startColumn, lookup(line, column) } }` for every
 * parsed script that carried an inline source map. `lookup` takes a GENERATED
 * position in script coordinates (0-based line, 0-based column) and returns
 * `{ source, line, column, name }` or null.
 */
export function scriptsFromParsedEvents(events) {
  const scripts = new Map();
  for (const event of events) {
    const map = decodeInlineSourceMap(event.sourceMapURL);
    if (!map) continue;
    const tracer = new TraceMap(map);
    scripts.set(event.scriptId, {
      startLine: event.startLine ?? 0,
      startColumn: event.startColumn ?? 0,
      lookup: (line, column) => {
        const pos = originalPositionFor(tracer, { line: line + 1, column });
        return pos.source ? pos : null;
      },
    });
  }
  return scripts;
}

/**
 * The original position of a profile call frame, or null when the frame's
 * script has no map (a browser-internal script, `(program)`, `(idle)`).
 * Converts V8's document coordinates to the inline script's own.
 */
export function resolveCallFrame(frame, scripts) {
  const script = scripts.get(frame.scriptId);
  if (!script) return null;
  const line = frame.lineNumber - script.startLine;
  const column =
    frame.columnNumber - (frame.lineNumber === script.startLine ? script.startColumn : 0);
  if (line < 0 || column < 0) return null;
  return script.lookup(line, column);
}

/**
 * A readable repo-relative path for a source-map source. Vite writes them
 * relative to the output dir (`../../src/...`), and pnpm's store path for a
 * dependency is noise next to the package name.
 */
export function sourceLabel(source) {
  if (!source) return '(unknown)';
  let path = source.replace(/^(\.\.\/)+/, '');
  const pnpm = /node_modules\/\.pnpm\/[^/]+\/node_modules\/(.+)$/.exec(path);
  if (pnpm) path = `node_modules/${pnpm[1]}`;
  return path;
}

/** Which area owns a source: the repo's first two segments, or the npm package. */
export function ownerOf(label) {
  const parts = label.split('/');
  if (parts[0] === 'node_modules') {
    const scoped = parts[1]?.startsWith('@') ? `${parts[1]}/${parts[2]}` : parts[1];
    return `node_modules/${scoped ?? '?'}`;
  }
  return parts.slice(0, Math.min(3, parts.length - 1)).join('/') || label;
}

/** V8's pseudo-frames for work that is not JavaScript: the renderer's own
 * style, layout, paint and parse (`(program)`), the collector, the root. */
const NATIVE_FRAMES = new Set(['(program)', '(garbage collector)', '(root)']);
const NATIVE = '(browser-native)';
const UNMAPPED = '(unmapped JS)';

/**
 * Self time per resolved function, per source file and per owner, over the
 * profile's samples. `(idle)` is not work, so it is left out of the total and
 * reported as `idleMs`. Native work and JS frames that resolve through no map
 * keep their own buckets, so neither share is silently dropped (M11).
 *
 * @param profile a `Profiler.stop` result's `profile`
 * @param scripts from `scriptsFromParsedEvents`
 */
export function attributeProfile(profile, scripts, { top = 15 } = {}) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const selfUs = new Map();
  for (let i = 0; i < profile.samples.length; i += 1) {
    const id = profile.samples[i];
    selfUs.set(id, (selfUs.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0));
  }
  const functions = new Map();
  const files = new Map();
  const owners = new Map();
  let totalUs = 0;
  let idleUs = 0;
  let nativeUs = 0;
  let unmappedUs = 0;
  const add = (map, key, us) => map.set(key, (map.get(key) ?? 0) + us);
  const addAll = (fn, file, owner, us) => {
    add(functions, fn, us);
    add(files, file, us);
    add(owners, owner, us);
  };
  for (const [id, us] of selfUs) {
    const frame = byId.get(id)?.callFrame;
    if (!frame) continue;
    if (frame.functionName === '(idle)') {
      idleUs += us;
      continue;
    }
    totalUs += us;
    if (NATIVE_FRAMES.has(frame.functionName)) {
      nativeUs += us;
      addAll(`${frame.functionName}  ${NATIVE}`, NATIVE, NATIVE, us);
      continue;
    }
    const original = resolveCallFrame(frame, scripts);
    if (!original) {
      unmappedUs += us;
      const url = frame.url ? frame.url.replace(/^.*\//, '') : '';
      const where = url ? `${url}:${frame.lineNumber + 1}` : '(no script)';
      addAll(
        `${frame.functionName || '(anonymous)'}  ${where} ${UNMAPPED}`,
        UNMAPPED,
        UNMAPPED,
        us,
      );
      continue;
    }
    const file = sourceLabel(original.source);
    const name = original.name || frame.functionName || '(anonymous)';
    addAll(`${name}  ${file}:${original.line}`, file, ownerOf(file), us);
  }
  const share = (us) => (totalUs ? us / totalUs : 0);
  const rank = (map) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, top)
      .map(([label, us]) => ({ label, ms: us / 1000, share: share(us) }));
  return {
    totalMs: totalUs / 1000,
    idleMs: idleUs / 1000,
    nativeShare: share(nativeUs),
    unmappedShare: share(unmappedUs),
    functions: rank(functions),
    files: rank(files),
    owners: rank(owners),
  };
}

/** The attribution as the markdown tables the perf docs carry. */
export function formatAttribution(summary, { title = 'CPU profile' } = {}) {
  const row = (r) => `| ${r.ms.toFixed(1)} | ${(r.share * 100).toFixed(0)}% | ${r.label} |`;
  const table = (heading, rows) =>
    [`| self ms | share | ${heading} |`, '|---:|---:|---|', ...rows.map(row)].join('\n');
  return [
    `${title}: ${summary.totalMs.toFixed(0)} ms busy (${summary.idleMs.toFixed(0)} ms idle left out); ` +
      `${(summary.nativeShare * 100).toFixed(0)}% browser-native (style, layout, paint, GC), ` +
      `${(summary.unmappedShare * 100).toFixed(0)}% JS without a source map`,
    '',
    table('owner', summary.owners),
    '',
    table('source file', summary.files),
    '',
    table('function', summary.functions),
  ].join('\n');
}
