import { commandsCtx, type CmdKey, type Editor } from '@milkdown/kit/core';
import { EditorState, Selection, type Command, type Transaction } from '@milkdown/kit/prose/state';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
import { callCommand } from '@milkdown/kit/utils';

import { editorView } from './caretContext';

/**
 * Deletes `[from, to)` and runs `command` against the state that results —
 * both folded into ONE transaction, dispatched once.
 *
 * Why one transaction rather than two dispatches: a command that
 * RESTRUCTURES the block (a `setBlockType`, a split, a table grid) needs the
 * typed run already gone, or the run survives inside — or next to — the new
 * node (the `/` menu's QA-010/QA-013). But two separate dispatches (delete,
 * then the command) let ProseMirror paint the momentarily-empty block in
 * between; that paint's own DOM mutation (a trailing `<br>`) is picked up by
 * the view's mutation observer as if the user had typed it, producing a
 * stray transaction that can drag the caret out of the block the command
 * just built (measured on `/task`, one run in five by keyboard). Folding
 * both changes into one `Transaction` means the DOM is only ever painted
 * once, with the FINAL document — there is no intermediate empty state to
 * misobserve — and `prosemirror-history` sees a single undo step.
 *
 * `midState` is built with `EditorState.create`, never `view.state.apply
 * (deleteTr)`: `.apply()` runs every plugin's `appendTransaction`, and any
 * fixup a plugin appended there would be invisible to `combined` below
 * (which starts from `deleteTr`'s OWN steps, not those extras) — silently
 * mis-mapping `produced`'s positions once appended onto it. `.create()` only
 * re-inits plugin STATE, so `midState.doc` is exactly `deleteTr.doc`, and the
 * real dispatch below still runs every plugin's `appendTransaction` against
 * the actual final document, same as any other transaction.
 *
 * Returns false — dispatching nothing, including the delete — when `command`
 * declines on the post-delete state.
 */
function combineDeleteAndCommand(
  view: ProseView,
  from: number,
  to: number,
  command: Command,
): boolean {
  const deleteTr = view.state.tr.delete(from, to);
  const midState = EditorState.create({
    schema: view.state.schema,
    doc: deleteTr.doc,
    selection: deleteTr.selection,
    storedMarks: deleteTr.storedMarks,
    plugins: view.state.plugins,
  });

  // A plain object, not a reassigned `let`: TypeScript does not carry a `let`
  // variable's narrowing into the `if` below once it has also been assigned
  // from inside a nested closure (the dispatch callback here), but a property
  // read like `holder.tr` narrows normally.
  const holder: { tr: Transaction | null } = { tr: null };
  const ok = command(
    midState,
    (tr) => {
      holder.tr = tr;
    },
    view,
  );
  if (!ok) return false;

  const combined = deleteTr;
  if (holder.tr) {
    const produced = holder.tr;
    for (const step of produced.steps) combined.step(step);
    // `produced.selection` is bound to `produced.doc` — a DIFFERENT Node
    // object than `combined.doc`, even though the two are structurally
    // identical (both applied the same steps to the same starting doc):
    // `Step.apply` builds a fresh Node each time it runs, and ProseMirror's
    // `setSelection` rejects a selection bound to any doc it is not
    // REFERENCE-equal to. `Selection.fromJSON` rebuilds an equivalent
    // selection bound to `combined.doc` instead of reusing the instance.
    if (produced.selectionSet) {
      combined.setSelection(Selection.fromJSON(combined.doc, produced.selection.toJSON()));
    }
    combined.setStoredMarks(produced.storedMarks);
    if (produced.scrolledIntoView) combined.scrollIntoView();
  }
  view.dispatch(combined);
  view.focus();
  return true;
}

/** Commands from either registry keep the editor focused after execution. */
export function createCommandRunner(getEditor: () => Editor | null) {
  return {
    run<T>(command: { key: CmdKey<T> }, payload?: T): void {
      const editor = getEditor();
      if (!editor) return;
      editor.action(callCommand(command.key, payload));
      editorView(editor)?.focus();
    },
    dispatch(command: Command): void {
      const view = editorView(getEditor());
      if (!view) return;
      command(view.state, view.dispatch.bind(view));
      view.focus();
    },
    /** Deletes `[from, to)` and returns focus, with no command to run. */
    deleteRange(from: number, to: number): void {
      const view = editorView(getEditor());
      if (!view) return;
      view.dispatch(view.state.tr.delete(from, to));
      view.focus();
    },
    /** Like `dispatch`, but see `combineDeleteAndCommand` above. */
    runAfterDelete(from: number, to: number, command: Command): boolean {
      const view = editorView(getEditor());
      if (!view) return false;
      return combineDeleteAndCommand(view, from, to, command);
    },
    /** Like `run`, but see `combineDeleteAndCommand` above. */
    runKeyAfterDelete<T>(
      from: number,
      to: number,
      command: { key: CmdKey<T> },
      payload?: T,
    ): boolean {
      const editor = getEditor();
      const view = editorView(editor);
      if (!editor || !view) return false;
      let result = false;
      editor.action((ctx) => {
        const commandFn = ctx.get(commandsCtx).get(command.key)(payload) as Command;
        result = combineDeleteAndCommand(view, from, to, commandFn);
      });
      return result;
    },
  };
}
