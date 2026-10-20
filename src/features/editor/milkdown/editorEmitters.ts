import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
import type { Selection as ProseSelection } from '@milkdown/kit/prose/state';
import { enclosingListItem } from './caretContext';
import { inIndentableContainer } from './blockCommands';
import { computeActiveFormats, computeDisabledFormats } from './formatState';
import type { DocumentSession } from './documentSession.svelte';

/** Builds the editor's two deduped chrome reports. `props` reads the CURRENT callbacks. */
export function createEditorEmitters(deps: {
  pmView: () => ProseView | null;
  session: DocumentSession;
  props: {
    readonly onformatstate?: (active: string[], disabled: string[]) => void;
    readonly oncursorcontext?: (ctx: { onListLine: boolean; inContainer: boolean }) => void;
  };
}) {
  const { pmView, session, props } = deps;
  let onListLine: boolean | null = null;
  let inContainer: boolean | null = null;

  /* Sorted comma-joined snapshot of the last emitted format-state set, so
   * emitFormatState() below can dedupe without the caller tracking it. */
  let lastFormatStateKey: string | null = null;

  /**
   * Emits deduped `formatState`. `selectionOverride`, when given, is the
   * SELECTION-JUST-APPLIED from Milkdown's `selectionUpdated` listener
   * callback — pass it explicitly rather than reading `pmView()!.state`
   * there: Milkdown's listener plugin runs that callback from inside
   * `EditorState.apply(tr)`, before the default `dispatchTransaction` calls
   * `view.updateState(...)`, so `view.state` (and its `.selection`/
   * `.storedMarks`) is still ONE TRANSACTION BEHIND at that exact call site —
   * `pmView()?.state.selection` there would report where the caret USED TO
   * BE. `mounted`/the debounced change notification/`exec()` all run outside that
   * window, so `view.state` is current for them (no override needed) — and
   * `storedMarks` is intentionally omitted (`null`) for the override case: a
   * plain selection-move transaction always clears storedMarks anyway, so
   * `selection.$from.marks()` alone is correct there, whereas `exec('bold')`
   * on a collapsed selection genuinely relies on the freshly toggled
   * `view.state.storedMarks` to report active immediately.
   *
   * Disabled ids (Undo/Redo) are computed from `view.state` directly — they
   * are not selection-dependent, so `selectionOverride` says nothing about
   * them — which means they can lag by the same one transaction the override
   * exists to correct for `active`. That is fine here: it self-heals at the
   * next debounced change notification (`reportDocumentChange`'s
   * `emitFormatState()` in serializationLoop.ts, called with fresh
   * `view.state`), and the case that
   * actually matters — tapping Undo/Redo itself — runs through `exec()`,
   * which is never inside the stale window.
   */
  function emitFormatState(selectionOverride?: ProseSelection): void {
    if (!props.onformatstate) return;
    /* A streaming progressive open moves the selection with every chunk it
     * appends, and there is no toolbar tap behind any of it — recomputing
     * would be per-chunk work on the load path for a highlight nobody asked
     * for. The completion path emits once, for the finished document. */
    if (session.progressive?.loading) return;
    const view = pmView();
    if (!view) return;
    const selection = selectionOverride ?? view.state.selection;
    const storedMarks = selectionOverride ? null : view.state.storedMarks;
    const active = computeActiveFormats(view, selection, storedMarks);
    const disabled = computeDisabledFormats(view);
    const key = `${[...active].sort().join(',')}|${[...disabled].sort().join(',')}`;
    if (key === lastFormatStateKey) return;
    lastFormatStateKey = key;
    props.onformatstate(active, disabled);
  }

  /**
   * Emits deduped `cursorContext` — Indent/Outdent visibility. Takes the same
   * `selectionOverride` as `emitFormatState`, and for the same reason.
   *
   * `inContainer` is the honest name for the native toolbars' `when:
   * 'inContainer'` visibility rule (list item OR blockquote —
   * `inIndentableContainer`, blockCommands.ts); `onListLine` stays exactly
   * what it was for anything that genuinely needs list-only semantics.
   */
  function emitCursorContext(selectionOverride?: ProseSelection): void {
    const view = pmView();
    if (!view) return;
    const selection = selectionOverride ?? view.state.selection;
    const inList = enclosingListItem(selection) !== null;
    const inAnyContainer = inIndentableContainer(selection.$from);
    if (inList === onListLine && inAnyContainer === inContainer) return;
    onListLine = inList;
    inContainer = inAnyContainer;
    props.oncursorcontext?.({ onListLine: inList, inContainer: inAnyContainer });
  }

  return { emitFormatState, emitCursorContext };
}
