import { commandsCtx, type CmdKey, type Editor } from '@milkdown/kit/core';
import type { Command } from '@milkdown/kit/prose/state';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
import { callCommand } from '@milkdown/kit/utils';

import { editorView } from './caretContext';
import { foldCommandInto } from './foldCommand';
import { onSelectedLines } from './paragraphLines';

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
 * The fold itself — running `command` against the post-delete document and
 * appending what it did to the delete — is `foldCommand.ts`'s.
 *
 * A `command` that DECLINES on the post-delete state (Text on a paragraph,
 * Bullet inside a bullet, Code block in a list item) still gets the delete
 * dispatched, as its own single undo step: the spec is that picking any `/`
 * item removes the typed `/query`, whether or not the item then has anything
 * to do (docs/spec/editor.md, RC-57). Returns whether `command` itself ran.
 */
function combineDeleteAndCommand(
  view: ProseView,
  from: number,
  to: number,
  command: Command,
): boolean {
  const combined = view.state.tr.delete(from, to);
  // A `/` typed at the start of a line acts on that line, not on every line of
  // its paragraph (paragraphLines.ts).
  const ok = foldCommandInto(view.state, combined, onSelectedLines(command), view);
  view.dispatch(combined);
  view.focus();
  return ok;
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
    /** Like `run`, landing on the selected lines only (paragraphLines.ts `onSelectedLines`). */
    runOnLines<T>(command: { key: CmdKey<T> }, payload?: T): void {
      const editor = getEditor();
      const view = editorView(editor);
      if (!editor || !view) return;
      editor.action((ctx) => {
        const commandFn = ctx.get(commandsCtx).get(command.key)(payload) as Command;
        onSelectedLines(commandFn)(view.state, view.dispatch.bind(view), view);
      });
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
