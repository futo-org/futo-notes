/*
 * The serialization loop: how the live document becomes the markdown the host
 * hears, and when.
 *
 * A transaction changed the document — report it once it settles.
 *
 * Restarted by every further change, so a burst of typing costs exactly one
 * serialization (M5). Driven by documentChanges.ts, which explains why this
 * is the component's own signal rather than `@milkdown/plugin-listener`'s
 * `markdownUpdated`: that callback goes SILENT whenever the settled document
 * matches its own baseline, and a note cleared inside the same window as its
 * load matches the pristine empty document that baseline is still sitting on.
 *
 * Every serialization goes through ONE function, `serialize` below. The
 * per-block cache behind it (blockSerializer.ts) is what the idle priming here
 * warms.
 */
import { schemaCtx, serializerCtx, type Editor } from '@milkdown/kit/core';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
import { toWellFormedText, type DocumentRef } from '@futo-notes/editor';
import { createBlockSerializer, type BlockSerializer } from './blockSerializer';
import { DOCUMENT_CHANGE_DEBOUNCE_MS, DOCUMENT_CHANGE_MAX_WAIT_MS } from './documentChanges';
import type { DocumentSession } from './documentSession.svelte';
import { scheduleIdleSlice } from './progressiveLoad';

/**
 * How long `reportDocumentChange` will serialize SYNCHRONOUSLY before
 * falling back to the idle priming loop. One or a few changed units on any
 * real note fit in this easily; a still-cold multi-thousand-block document
 * does not, and THAT is the case the idle loop below exists for.
 */
const SYNC_PRIME_BUDGET_MS = 8;

/** The component props the loop reports through. A getter: each read is the CURRENT prop. */
export interface SerializationLoopProps {
  readonly onchange?: (content: string, ref: DocumentRef, flushToken?: string) => void;
  readonly onedited?: (ref: DocumentRef) => void;
}

export interface SerializationLoopDeps {
  getEditor: () => Editor | null;
  pmView: () => ProseView | null;
  emitFormatState: () => void;
  props: SerializationLoopProps;
}

export type SerializationLoop = ReturnType<typeof createSerializationLoop>;

export function createSerializationLoop(session: DocumentSession, deps: SerializationLoopDeps) {
  const { getEditor, pmView, emitFormatState, props } = deps;

  /* The per-top-level-block serialization cache (blockSerializer.ts). One
   * instance per editor, built once `serializerCtx`/`schemaCtx` exist. */
  let blockSerializer: BlockSerializer | null = null;
  /* The in-flight idle priming loop over `blockSerializer`, if any — see
   * `startPriming`/`stopPriming`. */
  let primeCancelIdle: (() => void) | null = null;
  /* The pending debounced change notification (documentChanges.ts). */
  let changeTimer: number | null = null;
  /* When the first edit the pending notification holds was made: the anchor
   * for `DOCUMENT_CHANGE_MAX_WAIT_MS`. */
  let changePendingSince: number | null = null;

  /** Builds the editor `created`'s serializer, once its ctx slices exist. */
  function attach(created: Editor): void {
    const schema = created.ctx.get(schemaCtx);
    const serializeDoc = created.ctx.get(serializerCtx);
    blockSerializer = createBlockSerializer({
      serializeDoc: (doc) => serializeDoc(doc),
      createDoc: (nodes) => schema.topNodeType.create(null, nodes),
    });
  }

  /** Drops the serializer of an editor that is being destroyed. */
  function detach(): void {
    blockSerializer = null;
  }

  /**
   * THE serialize seam: a ProseMirror document in, its markdown out. Every
   * serialization this editor reports passes through here (`readSerialized`).
   * Today it is the per-top-level-block cache (blockSerializer.ts) over
   * Milkdown's own `serializerCtx`, built by `attach`. The owned serializer
   * (#266) replaces what is behind this function.
   *
   * Reached only through `readSerialized`, which returns before calling it
   * when there is no serializer.
   */
  function serialize(doc: ProseNode): string {
    return blockSerializer!.serialize(doc);
  }

  /**
   * Runs `blockSerializer.prime()` in idle slices until `view.state.doc` is
   * fully cached, then calls `onDone` (if the editor and document are still
   * around — `pmView()`/`blockSerializer` can go null on a race with destroy
   * or a fresh load elsewhere in this file, and there is nothing to prime
   * against then).
   *
   * Safe to call while a priming loop is already running: it cancels that
   * loop's SCHEDULING first, but the cache itself (a `WeakMap` inside
   * `blockSerializer`) is untouched, so nothing already primed is redone —
   * only the "who to call when done" is replaced. That is also what makes it
   * safe to call from `reportDocumentChange` with no separate queue: the next
   * idle slice always primes whatever `view.state.doc` is AT THAT MOMENT, so
   * a doc that kept changing simply keeps the loop going instead of losing
   * work.
   */
  function startPriming(onDone?: () => void): void {
    stopPriming();
    const step = (deadline: IdleDeadline | undefined): void => {
      primeCancelIdle = null;
      const view = pmView();
      if (!view || !blockSerializer) return;
      // A real deadline reports its own remaining time; the setTimeout
      // fallback (no requestIdleCallback — Safari/WKWebView) gets a fixed
      // ~6 ms slice budget instead, tracked from when this slice started.
      const timeRemainingMs = deadline
        ? (): number => deadline.timeRemaining()
        : ((): (() => number) => {
            const sliceStart = performance.now();
            return (): number => 6 - (performance.now() - sliceStart);
          })();
      const done = blockSerializer.prime(view.state.doc, timeRemainingMs);
      if (done) {
        onDone?.();
        return;
      }
      primeCancelIdle = scheduleIdleSlice(step);
    };
    primeCancelIdle = scheduleIdleSlice(step);
  }

  /** Cancels the in-flight priming loop, if any. Does not touch the cache. */
  function stopPriming(): void {
    primeCancelIdle?.();
    primeCancelIdle = null;
  }

  /** A user edit (documentChanges.ts): remember it, and report it once the document settles. */
  function documentEdited(): void {
    session.documentGeneration += 1;
    if (!session.unreported) {
      session.unreported = true;
      props.onedited?.(session.documentRef());
    }
    scheduleChangeNotification();
  }

  /* A trailing debounce, capped: an edit is reported once the document has sat
   * still for DOCUMENT_CHANGE_DEBOUNCE_MS, or DOCUMENT_CHANGE_MAX_WAIT_MS after
   * it was made, whichever is first (RC-26 — typing that never paused was never
   * reported, so never saved). The same one timer either way. */
  function scheduleChangeNotification(): void {
    if (changeTimer !== null) window.clearTimeout(changeTimer);
    const now = performance.now();
    changePendingSince ??= now;
    const delay = Math.min(
      DOCUMENT_CHANGE_DEBOUNCE_MS,
      Math.max(0, changePendingSince + DOCUMENT_CHANGE_MAX_WAIT_MS - now),
    );
    changeTimer = window.setTimeout(() => {
      changeTimer = null;
      changePendingSince = null;
      reportDocumentChange();
    }, delay);
  }

  function cancelChangeNotification(): void {
    if (changeTimer !== null) window.clearTimeout(changeTimer);
    changeTimer = null;
    changePendingSince = null;
  }

  /** Hands the settled document to the host, unless it is not the host's to hear. */
  function reportDocumentChange(): void {
    emitFormatState();
    /* SAVE LOCK (CRITICAL — progressiveLoad.ts): while the tail is streaming
     * the document is a PREFIX of the note. Reporting it as a change is how a
     * slow open truncates a file, and `liveMarkdown` must not take a prefix
     * either — `setContent` dedupes against it. An edit made in this window is
     * not lost: finishProgressiveLoad() releases it against the complete
     * document. */
    if (session.progressive?.loading) return;
    /* A document we failed to load is not a source of user edits: the editable
     * is off, and anything the engine still reports for it describes an empty
     * document, not the note. */
    if (session.loadFailed) return;

    if (!session.unreported) return;
    if (unchangedSinceLoad()) {
      const loaded = session.hostMarkdown ?? readSerialized();
      if (loaded !== null) postChange(loaded);
      return;
    }

    // Most notes are already fully primed here (noteLoaded/finishProgressiveLoad
    // warm the cache in the background), so this budget almost never does real
    // work — it exists for the note that JUST loaded or streamed in and whose
    // background priming hasn't caught up yet. A SMALL synchronous budget
    // keeps that ordinary case on the same cadence as before this cache
    // existed: one or a few changed units serialize well inside it. Only a
    // document that is still cold at multi-thousand-block scale exceeds it,
    // which is exactly the case the whole-document `getMarkdown()` cost this
    // module replaces was unacceptable for
    // (docs/plan/milkdown-transition.md "Gate run, real app, 2026-09-06").
    const primingView = pmView();
    if (primingView && blockSerializer && !blockSerializer.isPrimed(primingView.state.doc)) {
      const budgetStart = performance.now();
      const primed = blockSerializer.prime(
        primingView.state.doc,
        () => SYNC_PRIME_BUDGET_MS - (performance.now() - budgetStart),
      );
      if (!primed) {
        // Still cold past the budget: finish priming in idle slices and let
        // the NORMAL debounce fire again once the document settles, rather
        // than reporting the moment priming happens to land (which could be
        // mid-typing-burst). Any keystrokes that arrive meanwhile are one or
        // two more cache misses, absorbed by the sync budget on that next
        // pass.
        startPriming(() => {
          scheduleChangeNotification();
        });
        return;
      }
    }

    // The LIVE document, never a snapshot of an earlier transaction: this is
    // the answer the host would get from `getContent()` at this instant.
    const markdown = readSerialized();
    if (markdown === null) return;
    // A genuine user edit: the host's copy is no longer authoritative.
    session.loadedDoc = null;
    session.hostMarkdown = null;
    postChange(markdown);
  }

  /**
   * Milkdown's serialization of the live document, cached against that
   * document. Goes through `serialize`, the per-block cache, rather than
   * `getMarkdown()`: byte-identical output, but proportional to what changed
   * since the last serialization instead of to the whole document.
   */
  function readSerialized(): string | null {
    const view = pmView();
    if (!getEditor() || !view || !blockSerializer) return null;
    const doc = view.state.doc;
    if (session.liveDoc === doc && session.liveMarkdown !== null) return session.liveMarkdown;
    try {
      /* The one place the live document becomes text (`getContent`, the
       * `change` report): a lone surrogate — a Backspace that split an emoji, a
       * paste that carried half of one — is written as U+FFFD (RC-48, decision
       * 16A). Unfixed it reached the Tauri IPC as a `\ud800` JSON escape and the
       * save never settled. */
      const markdown = toWellFormedText(serialize(doc));
      session.liveDoc = doc;
      session.liveMarkdown = markdown;
      return markdown;
    } catch {
      return null;
    }
  }

  /**
   * Is the document still exactly what the host loaded? Identity first, so an
   * untouched note answers in O(1); `Node.eq` covers a document rebuilt to the
   * same content (an edit and its undo), and it compares unchanged children by
   * identity too, so it stays cheap at any note size.
   */
  function unchangedSinceLoad(): boolean {
    const view = pmView();
    if (!view || session.loadedDoc === null) return false;
    return view.state.doc === session.loadedDoc || view.state.doc.eq(session.loadedDoc);
  }

  function postChange(text: string, token?: string): void {
    session.unreported = false;
    props.onchange?.(toWellFormedText(text), session.documentRef(), token);
  }

  return {
    attach,
    detach,
    startPriming,
    stopPriming,
    documentEdited,
    cancelChangeNotification,
    readSerialized,
    unchangedSinceLoad,
    postChange,
  };
}
