/**
 * The in-page measurement the device perf runners evaluate over CDP — ONE copy,
 * so `tests/android-editor-perf.mjs` (the real app, the budget gate) and
 * `tests/android-editor-perf-quick.mjs` (the bundle in the phone's Chrome, the
 * iteration loop) time exactly the same unit. A number from the quick loop is
 * only worth anything if the gate would have measured it the same way.
 *
 * The keystroke loop is byte-for-byte the desktop gauntlet's `measureKeystrokes`
 * (a dispatch, then a rAF), so the numbers mean the same thing on both.
 */

/** Streaming a 50k-line tail on a low-end phone takes a while; bounded, not open. */
export const OPEN_COMPLETE_TIMEOUT_MS = 180_000;

/**
 * setContent, then block until the open has fully landed. `setContent` →
 * `applyExternal` → `markOpenStart` clears the previous open's entries
 * SYNCHRONOUSLY, so any entry visible after it belongs to this open — which is
 * what makes polling the measure safe rather than a race.
 */
export function openSnippet(markdown) {
  return `
    const md = ${JSON.stringify(markdown)};
    if (!window.FutoEditor) throw new Error('no FutoEditor on this page');
    /* Start every fixture from an EMPTY editor. ProseMirror's view matcher
     * reuses a block view whenever the new block is equal to the old one, so
     * when a fixture follows another built by the same generator, thousands of
     * block views come out of the previous document with node objects that are
     * equal but not identical — and the first keystroke re-validates every one
     * of them (5,000 block updates, 332 ms, on the 25k fixture after the 10k
     * one). That is the benchmark's history leaking into the fixture, not the
     * fixture's cost. */
    window.FutoEditor.setContent('');
    await new Promise((r) => requestAnimationFrame(() => r()));
    window.FutoEditor.setContent(md);
    const deadline = performance.now() + ${OPEN_COMPLETE_TIMEOUT_MS};
    while (performance.getEntriesByName('futo:editor-open-complete').length === 0) {
      if (performance.now() > deadline) throw new Error('open never completed (screen off? app backgrounded?)');
      await new Promise((r) => setTimeout(r, 50));
    }
    /* The document on screen must actually BE the fixture. Every guard between
     * here and the editor dedupes against the live document (hostBoot's
     * setContent, MilkdownEditor's own), and a skipped load leaves a STALE
     * open-complete measure behind — so the poll above returns instantly and
     * every number after it would describe the previous document. That is the
     * silent green M11 forbids, and it is not hypothetical: it is what the
     * device runner did on its first --containment-only run. Normalization
     * means the text is not byte-identical, so the check is a loose size floor. */
    const loadedSize = window.__futoProseMirrorView?.()?.state.doc.content.size ?? 0;
    if (loadedSize < md.length / 2) {
      throw new Error(
        'the fixture did not load: asked for ' + md.length + ' chars, document holds ' +
        loadedSize + ' (starts: ' + JSON.stringify(window.FutoEditor.getContent().slice(0, 60)) + ')',
      );
    }
    /* "Complete" means the document is in the DOM, not that it has been on
     * screen: a whole-document open marks it in the same task that inserted
     * 5,000 blocks, before the browser has laid any of them out. Typing in that
     * same task charges the document's FIRST layout to the first keystroke
     * (1.3s on the reference phone, measured 2026-09-04), which is an open
     * cost wearing a keystroke's label — nobody types into a note that has
     * never been painted. At least two frames: the first rAF fires before that
     * frame's layout, the second only after the document has been presented
     * once. Then keep going while frames are still long — content-visibility
     * activates the on-screen blocks in the frames after the first paint (a
     * 200 ms second frame at 10k lines, more in the WebView) — until one takes
     * under 40 ms, bounded at 30 frames so a busy page cannot stall the run. */
    for (let frame = 0, lastFrameMs = Infinity; frame < 30 && (frame < 2 || lastFrameMs > 40); frame += 1) {
      const frameStart = performance.now();
      await new Promise((r) => requestAnimationFrame(() => r()));
      lastFrameMs = performance.now() - frameStart;
    }`;
}

/** Load a document and report nothing — used to set up the containment probe. */
export function loadExpression(markdown) {
  return `(async () => {${openSnippet(markdown)}
    return true;
  })()`;
}

/**
 * The FIRST focus of the opened document, timed to the third frame after it:
 * the tap that starts typing, which is the one moment a note is guaranteed to
 * be asked for by the user and which a `content-visibility` containment rule
 * used to stall for seconds (docs/spec/editor.md, Performance). Blurred again
 * afterwards, so the keystroke loop keeps the gate's unfocused unit — the same
 * one the desktop gauntlet times.
 */
export function firstFocusSnippet() {
  return `
    const focusView = window.__futoProseMirrorView?.();
    if (!focusView) throw new Error('no ProseMirror view');
    const focusStart = performance.now();
    focusView.focus();
    for (let i = 0; i < 3; i += 1) await new Promise((r) => requestAnimationFrame(() => r()));
    const firstFocusMs = performance.now() - focusStart;
    if (!focusView.hasFocus()) throw new Error('editor did not take focus');
    focusView.dom.blur();
    await new Promise((r) => requestAnimationFrame(() => r()));`;
}

/**
 * The keystroke loop alone, against whatever document is loaded. Split out so a
 * CPU profile can bracket exactly the typing and nothing else.
 */
export function keystrokeSnippet(samples, { focused = false } = {}) {
  return `
    const view = window.__futoProseMirrorView?.();
    if (!view) throw new Error('no ProseMirror view (did the page load the CodeMirror editor?)');
    ${focused ? "view.focus(); if (!view.hasFocus()) throw new Error('editor did not take focus');" : ''}
    const synchronousSamplesMs = [];
    const settledToPaintSamplesMs = [];
    for (let i = 0; i < ${samples}; i += 1) {
      const t0 = performance.now();
      view.dispatch(view.state.tr.insertText('x'));
      synchronousSamplesMs.push(performance.now() - t0);
      await new Promise((r) => requestAnimationFrame(() => r()));
      settledToPaintSamplesMs.push(performance.now() - t0);
    }`;
}

export function keystrokeExpression(samples, options) {
  return `(async () => {${keystrokeSnippet(samples, options)}
    return { synchronousSamplesMs, settledToPaintSamplesMs };
  })()`;
}

export function measureExpression(markdown, samples, options) {
  return `(async () => {${openSnippet(markdown)}
    const duration = (name) => performance.getEntriesByName(name)[0]?.duration ?? null;
    ${firstFocusSnippet()}
    ${keystrokeSnippet(samples, options)}
    return {
      interactiveMs: duration('futo:editor-open-interactive'),
      completeMs: duration('futo:editor-open-complete'),
      firstFocusMs,
      synchronousSamplesMs,
      settledToPaintSamplesMs,
    };
  })()`;
}

/**
 * One CDP session on a page, exposing awaited Runtime.evaluate plus raw `send`
 * for the Profiler domain. `WebSocketImpl` is injected so this module stays
 * free of the `ws` import (the unit tests load it under vitest/jsdom).
 */
export async function connectPage(webSocketDebuggerUrl, WebSocketImpl, { onEvent } = {}) {
  const ws = new WebSocketImpl(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  let nextId = 1;
  const pending = new Map();
  let closed = false;
  const rejectPending = (error) => {
    closed = true;
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  };
  ws.on('close', () => rejectPending(new Error('device CDP connection closed')));
  ws.on('error', rejectPending);
  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.method) onEvent?.(msg.method, msg.params);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject, timer } = pending.get(msg.id);
      clearTimeout(timer);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  const send = (method, params, timeoutMs = 30_000) =>
    new Promise((resolve, reject) => {
      if (closed) return reject(new Error('device CDP connection closed'));
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`device CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return {
    send,
    /** Evaluate [expression], awaiting promises; throws on a page exception. */
    async evaluate(expression) {
      const r = await send(
        'Runtime.evaluate',
        {
          expression,
          awaitPromise: true,
          returnByValue: true,
          timeout: OPEN_COMPLETE_TIMEOUT_MS + 60_000,
        },
        OPEN_COMPLETE_TIMEOUT_MS + 65_000,
      );
      if (r.exceptionDetails) {
        throw new Error(
          `in-page: ${r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails)}`,
        );
      }
      return r.result.value;
    },
    close: () => {
      rejectPending(new Error('device CDP connection closed'));
      ws.terminate();
    },
  };
}

/**
 * Collapse a V8 CPU profile (`Profiler.stop` result) into self-time per
 * function, heaviest first. `timeDeltas` are microseconds between consecutive
 * samples; each is charged to the node the sample landed on.
 */
export function summarizeProfile(profile, { top = 30, callers = null } = {}) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const selfUs = new Map();
  for (let i = 0; i < profile.samples.length; i += 1) {
    const id = profile.samples[i];
    selfUs.set(id, (selfUs.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0));
  }
  const byFrame = new Map();
  const byUrl = new Map();
  let totalUs = 0;
  for (const [id, us] of selfUs) {
    const frame = byId.get(id)?.callFrame;
    if (!frame) continue;
    totalUs += us;
    const url = frame.url ? frame.url.replace(/^.*\//, '') : '';
    const label = `${frame.functionName || '(anonymous)'} ${url}:${frame.lineNumber + 1}`;
    byFrame.set(label, (byFrame.get(label) ?? 0) + us);
    byUrl.set(url || '(native/idle)', (byUrl.get(url || '(native/idle)') ?? 0) + us);
  }
  /* Inclusive time: every sample is charged once to each DISTINCT function on
   * its stack, so a library helper's cost shows up under the plugin that called
   * it (recursion is not double-counted). */
  const parentOf = new Map();
  for (const node of profile.nodes)
    for (const child of node.children ?? []) parentOf.set(child, node.id);
  const labelOf = (id) => {
    const frame = byId.get(id)?.callFrame;
    if (!frame) return null;
    const url = frame.url ? frame.url.replace(/^.*\//, '') : '';
    return `${frame.functionName || '(anonymous)'} ${url}:${frame.lineNumber + 1}`;
  };
  const inclusive = new Map();
  for (let i = 0; i < profile.samples.length; i += 1) {
    const us = profile.timeDeltas[i] ?? 0;
    const seen = new Set();
    for (let id = profile.samples[i]; id !== undefined; id = parentOf.get(id)) {
      const label = labelOf(id);
      if (label && !seen.has(label)) {
        seen.add(label);
        inclusive.set(label, (inclusive.get(label) ?? 0) + us);
      }
    }
  }
  const rank = (map) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, top)
      .map(([label, us]) => ({ label, ms: us / 1000, share: totalUs ? us / totalUs : 0 }));
  /* Who calls `callers`: each sample whose stack contains a frame matching the
   * needle is charged to the frame directly ABOVE its topmost match. */
  let callerRows = null;
  if (callers) {
    const byCaller = new Map();
    for (let i = 0; i < profile.samples.length; i += 1) {
      const us = profile.timeDeltas[i] ?? 0;
      let topmost = null;
      for (let id = profile.samples[i]; id !== undefined; id = parentOf.get(id)) {
        if (labelOf(id)?.startsWith(`${callers} `)) topmost = id;
      }
      if (topmost === null) continue;
      const caller = labelOf(parentOf.get(topmost)) ?? '(root)';
      byCaller.set(caller, (byCaller.get(caller) ?? 0) + us);
    }
    callerRows = { needle: callers, rows: rank(byCaller) };
  }
  return {
    totalMs: totalUs / 1000,
    frames: rank(byFrame),
    urls: rank(byUrl),
    inclusive: rank(inclusive),
    callers: callerRows,
  };
}
