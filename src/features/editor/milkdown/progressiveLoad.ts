/**
 * Progressive open — the "mount" half of the large-note story
 * (docs/plan/milkdown-transition.md §5, issue #105).
 *
 * `markdownChunks.ts` decides WHERE a document may be cut; this module decides
 * WHEN each piece reaches the editor. The first chunk is applied synchronously,
 * so the frame the user is waiting for carries a real, editable first viewport;
 * the rest stream in one idle slice at a time, so the ~62 ms/1k-lines remark
 * parse never sits between the user and their note.
 *
 * Two invariants make the streaming invisible:
 *
 *   - **Non-undoable.** Chunk appends carry `addToHistory: false`, so Ctrl-Z
 *     right after an open can never "un-load" part of the note.
 *   - **Not a change.** The same flag makes the change listener skip them
 *     outright, and the caller holds its own `change` notification (and
 *     therefore the host's save) until {@link ProgressiveLoad.loading} goes
 *     false. Serializing a document that is still streaming would write a
 *     TRUNCATED file — the one unacceptable failure of this whole design.
 *
 * The scheduler is deliberately free of ProseMirror and of the DOM: `applyChunk`
 * and `scheduleIdle` are injected, so the ordering, the cancellation and the
 * exactly-once completion are assertable without an editor.
 */

import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';

/**
 * Appends a parsed chunk's top-level content at the end of `view`'s document.
 *
 * An empty paragraph at the end is CONSUMED rather than kept. Milkdown's
 * `trailing` plugin parks one there whenever the document's last node is not a
 * paragraph — a chunk that happens to end on a heading or a list gets one — and
 * remark never produces an empty paragraph from markdown, so one at the end is
 * always the plugin's. Carrying it along would leave the finished document one
 * empty paragraph longer than the same note parsed whole, which serializes as
 * an extra trailing newline: measured on the corpus as 23 of the first 23
 * divergences before this was fixed. Replacing it lets `trailing` make the same
 * decision about the FINISHED document that it would have made about a
 * whole-document parse.
 *
 * The selection is left alone: the user may already be typing in the first
 * chunk while the tail streams in behind them.
 */
export function appendChunkContent(view: ProseView, chunkDoc: ProseNode): void {
  const { content } = chunkDoc;
  if (content.size === 0) return;

  const { doc } = view.state;
  const last = doc.lastChild;
  const placeholder =
    last !== null && last.type.name === 'paragraph' && last.content.size === 0 ? last : null;
  const from = placeholder ? doc.content.size - placeholder.nodeSize : doc.content.size;

  /* `addToHistory: false` is doing two jobs, and both are load-bearing.
   * prosemirror-history keeps the append off the undo stack, so Ctrl-Z right
   * after an open cannot un-load part of the note. And @milkdown/plugin-listener
   * skips such transactions outright (`tr.getMeta("addToHistory") === false`
   * in its `state.apply`), so an append never reaches the change notification —
   * "invisible to the change listener" is that filter, not a flag of our own. */
  view.dispatch(
    view.state.tr.replaceWith(from, doc.content.size, content).setMeta('addToHistory', false),
  );
}

/**
 * Whether `chunkDoc` carries nothing a document would notice — an empty doc, or
 * nothing but empty paragraphs.
 *
 * A chunk of real markdown that parses to this means the plugin chain ATE it,
 * and appending it would silently drop that part of the note. The known case is
 * a lone `<br>` block: the commonmark preset's empty-line plugin removes the
 * `html` node from its parent, and with the chunk boundary having taken away
 * the surrounding context there is nothing left. (Root-causing that plugin is
 * issue #99's job; progressive open's job is to never make loss WORSE than a
 * whole-document parse, so it refuses the chunk and the caller reloads whole.)
 */
export function isEffectivelyEmpty(chunkDoc: ProseNode): boolean {
  if (chunkDoc.content.size === 0) return true;
  let empty = true;
  chunkDoc.forEach((child) => {
    if (child.type.name !== 'paragraph' || child.content.size > 0) empty = false;
  });
  return empty;
}

/** Cancels a scheduled idle slice. */
export type CancelIdle = () => void;

export interface ProgressiveLoadOptions {
  /** In document order; chunk 0 is applied synchronously by this call. */
  chunks: readonly string[];
  /** Parse and mount one chunk. Runs on the caller's editor. */
  applyChunk: (markdown: string) => void;
  /** Schedules `run` for the next idle slice; returns its canceller. */
  scheduleIdle: (run: () => void) => CancelIdle;
  /** Called exactly once, after the LAST chunk has been applied. */
  onComplete: () => void;
}

export interface ProgressiveLoad {
  /** True from the first chunk until the last one lands (or a cancel). */
  readonly loading: boolean;
  readonly appliedChunks: number;
  readonly totalChunks: number;
  /**
   * Applies every remaining chunk right now, synchronously, and completes.
   *
   * The escape hatch for anything that needs the WHOLE document before the
   * stream would naturally finish — in practice `getContent()` on a document
   * the user has already edited. Blocking for the remaining parse is the price
   * of never handing out a partial note.
   */
  finishNow: () => void;
  /** Abandons the load without completing (the editor is going away). */
  cancel: () => void;
}

/**
 * Starts streaming `chunks` into the editor. Chunk 0 lands before this returns.
 *
 * A single-chunk document completes synchronously and never schedules anything,
 * so the non-progressive path costs one function call.
 */
export function startProgressiveLoad(options: ProgressiveLoadOptions): ProgressiveLoad {
  const { chunks, applyChunk, scheduleIdle, onComplete } = options;

  let applied = 0;
  let finished = false;
  let cancelled = false;
  let cancelIdle: CancelIdle | null = null;

  function complete(): void {
    if (finished || cancelled) return;
    finished = true;
    onComplete();
  }

  function applyNext(): void {
    applyChunk(chunks[applied]);
    applied += 1;
  }

  function scheduleNext(): void {
    if (cancelled || finished) return;
    if (applied >= chunks.length) {
      complete();
      return;
    }
    cancelIdle = scheduleIdle(() => {
      cancelIdle = null;
      if (cancelled || finished) return;
      applyNext();
      scheduleNext();
    });
  }

  applyNext();
  scheduleNext();

  return {
    get loading(): boolean {
      return !finished && !cancelled;
    },
    get appliedChunks(): number {
      return applied;
    },
    get totalChunks(): number {
      return chunks.length;
    },
    finishNow(): void {
      if (finished || cancelled) return;
      cancelIdle?.();
      cancelIdle = null;
      while (applied < chunks.length) applyNext();
      complete();
    },
    cancel(): void {
      if (finished || cancelled) return;
      cancelled = true;
      cancelIdle?.();
      cancelIdle = null;
    },
  };
}

/**
 * Schedules `run` for the browser's next idle slice, falling back to a timer
 * where `requestIdleCallback` does not exist (Safari/WKWebView — i.e. iOS).
 *
 * The timeout matters: without it a busy main thread can defer an idle callback
 * indefinitely, and the note would stop growing while the user watched. 200 ms
 * is long enough to stay out of the way of a keystroke and short enough that a
 * ~30-chunk note still finishes streaming in a few seconds at worst.
 */
export function scheduleIdleSlice(run: () => void): CancelIdle {
  const idle = (globalThis as { requestIdleCallback?: typeof requestIdleCallback })
    .requestIdleCallback;
  if (typeof idle === 'function') {
    const handle = idle(() => run(), { timeout: 200 });
    return () =>
      (globalThis as { cancelIdleCallback?: typeof cancelIdleCallback }).cancelIdleCallback?.(
        handle,
      );
  }
  const handle = setTimeout(run, 0);
  return () => clearTimeout(handle);
}

/* ---- open timing ----------------------------------------------------------
 *
 * The open budget progressive open is measured against is
 * time-to-interactive-FIRST-VIEWPORT, not time-to-whole-document (plan §5,
 * D7). Both are recorded, as ordinary `performance.measure` entries, so
 * Playwright, DevTools and a CDP session attached to a real phone all read the
 * same number without an app-specific hook.
 */

export const OPEN_START_MARK = 'futo:editor-open-start';
/** First chunk mounted — the note is on screen and editable. */
export const OPEN_INTERACTIVE_MEASURE = 'futo:editor-open-interactive';
/** Last chunk mounted — the save lock is released. */
export const OPEN_COMPLETE_MEASURE = 'futo:editor-open-complete';

/** Starts an open timing, discarding any entries from the previous open. */
export function markOpenStart(): void {
  if (typeof performance?.mark !== 'function') return;
  performance.clearMarks(OPEN_START_MARK);
  performance.clearMeasures(OPEN_INTERACTIVE_MEASURE);
  performance.clearMeasures(OPEN_COMPLETE_MEASURE);
  performance.mark(OPEN_START_MARK);
}

/** Records `name` as the span from the open's start mark to now. */
export function measureOpen(name: string): void {
  if (typeof performance?.measure !== 'function') return;
  try {
    performance.measure(name, OPEN_START_MARK);
  } catch {
    // No start mark (the buffer was cleared under us) — a missing number is
    // strictly better than an exception on the open path.
  }
}
