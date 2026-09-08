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

import { Fragment, type Node as ProseNode } from '@milkdown/kit/prose/model';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';

/** What a chunk append needs to know about the chunk BEFORE it. */
export interface ChunkAppendOptions {
  /**
   * Empty paragraphs to put in front of the chunk's content — the blank-line
   * gap the cut hid. `markdownChunks.ts` leaves a boundary's whole blank run at
   * the END of the previous chunk, where a standalone parse cannot count it
   * (trailing blank lines are never paragraphs), so the loader counts it from
   * the text instead: {@link seamEmptyParagraphs}.
   */
  leadingEmptyParagraphs?: number;
  /**
   * Whether an empty paragraph at the end of the live document is the
   * `trailing` plugin's, and so to be consumed. False when the previous chunk's
   * own content ended in one — a `<br />` placeholder an older build wrote as
   * its last block loads as exactly that — which the plugin would not have
   * added to (it appends after a non-paragraph only).
   */
  consumeTrailingPlaceholder?: boolean;
}

/**
 * Appends a parsed chunk's top-level content at the end of `view`'s document.
 *
 * An empty paragraph at the end is CONSUMED rather than kept, unless the
 * caller says it is content. Milkdown's `trailing` plugin parks one there
 * whenever the document's last node is not a paragraph or heading — a chunk
 * that happens to end on a list gets one. Carrying it along would leave the
 * finished document one empty paragraph longer than the same note parsed whole,
 * which serializes as an extra trailing newline: measured on the corpus as 23
 * of the first 23 divergences before this was fixed. Replacing it lets
 * `trailing` make the same decision about the FINISHED document that it would
 * have made about a whole-document parse.
 *
 * The selection is left alone: the user may already be typing in the first
 * chunk while the tail streams in behind them.
 */
export function appendChunkContent(
  view: ProseView,
  chunkDoc: ProseNode,
  options: ChunkAppendOptions = {},
): void {
  const { leadingEmptyParagraphs = 0, consumeTrailingPlaceholder = true } = options;
  if (chunkDoc.content.size === 0) return;

  const { doc, schema } = view.state;
  const fillers = Array.from({ length: leadingEmptyParagraphs }, () =>
    schema.nodes.paragraph.create(),
  );
  const content = Fragment.from(fillers).append(chunkDoc.content);

  const last = doc.lastChild;
  const placeholder =
    consumeTrailingPlaceholder &&
    last !== null &&
    last.type.name === 'paragraph' &&
    last.content.size === 0
      ? last
      : null;
  const from = placeholder ? doc.content.size - placeholder.nodeSize : doc.content.size;

  /* `addToHistory: false` is doing two jobs, and both are load-bearing.
   * prosemirror-history keeps the append off the undo stack, so Ctrl-Z right
   * after an open cannot un-load part of the note. And documentChanges.ts skips
   * such transactions outright (`isReportableDocumentChange`), so an append
   * never reaches the change notification — "invisible to the change listener"
   * is that filter, not a flag of its own. */
  view.dispatch(
    view.state.tr.replaceWith(from, doc.content.size, content).setMeta('addToHistory', false),
  );
}

/**
 * How many empty paragraphs the seam after `previousChunk` stands for.
 *
 * The whole-document parse turns `N` blank lines between two blocks into
 * `N - 1` empty paragraphs (packages/editor/src/milkdown-compat/emptyLine.ts).
 * A chunk boundary sits after a blank run, with the whole run at the end of the
 * previous chunk and the next chunk starting on content, so the run's length is
 * the number of trailing blank lines here. Whitespace-only lines are blank, as
 * they are to CommonMark.
 */
export function seamEmptyParagraphs(previousChunk: string): number {
  const lines = previousChunk.split('\n');
  // Lines keep their terminators, so a chunk ending in `\n` splits to a final
  // empty string that is not a line.
  if (lines[lines.length - 1] === '') lines.pop();
  let blank = 0;
  for (let i = lines.length - 1; i >= 0 && (lines[i] ?? '').trim() === ''; i -= 1) blank += 1;
  return Math.max(0, blank - 1);
}

/**
 * Whether a chunk's markdown should parse to SOMETHING beyond empty paragraphs.
 *
 * The one legitimate way for real bytes to become nothing but empty paragraphs
 * is the `<br />` empty-paragraph placeholder an older build wrote: a chunk of
 * only those (and whitespace) loads as exactly the empty paragraphs it stood
 * for. Any other markdown that parses to that has been eaten by the plugin
 * chain — see {@link isEffectivelyEmpty}.
 */
export function chunkShouldHaveContent(markdown: string): boolean {
  return markdown.replace(/<br[ \t]*\/?[ \t]*>/giu, '').trim() !== '';
}

/**
 * Whether `chunkDoc` carries nothing a document would notice — an empty doc, or
 * nothing but empty paragraphs.
 *
 * A chunk of real markdown ({@link chunkShouldHaveContent}) that parses to this
 * means the plugin chain ATE it, and appending it would silently drop that part
 * of the note. There is no known case left — the one there was, a lone `<br>`
 * block deleted by the commonmark preset's empty-line plugin, is now read as
 * the empty paragraph it stood for — but progressive open's job is to never
 * make loss WORSE than a whole-document parse, so the guard stays: refuse the
 * chunk and the caller reloads whole.
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
  /**
   * Parse and mount one chunk. Runs on the caller's editor.
   * `leadingEmptyParagraphs` is {@link seamEmptyParagraphs} of the chunk before
   * it, and 0 for chunk 0.
   */
  applyChunk: (markdown: string, leadingEmptyParagraphs: number) => void;
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
    const previous = applied === 0 ? null : chunks[applied - 1];
    applyChunk(chunks[applied], previous === null ? 0 : seamEmptyParagraphs(previous));
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
 *
 * `run` receives the real `IdleDeadline` when `requestIdleCallback` exists, so
 * a caller that wants to keep working within the slice (the block-serializer
 * priming loop) can read `deadline.timeRemaining()`; on the `setTimeout`
 * fallback there is no deadline to report, so `run` gets `undefined` and a
 * caller must supply its own budget for that case. `startProgressiveLoad`'s
 * own `applyChunk` callers take no argument, which stays valid: a JS function
 * may always be called with more arguments than it declares.
 */
export function scheduleIdleSlice(run: (deadline: IdleDeadline | undefined) => void): CancelIdle {
  const idle = (globalThis as { requestIdleCallback?: typeof requestIdleCallback })
    .requestIdleCallback;
  if (typeof idle === 'function') {
    const handle = idle((deadline) => run(deadline), { timeout: 200 });
    return () =>
      (globalThis as { cancelIdleCallback?: typeof cancelIdleCallback }).cancelIdleCallback?.(
        handle,
      );
  }
  const handle = setTimeout(() => run(undefined), 0);
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
