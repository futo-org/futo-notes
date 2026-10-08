/*
 * Run a command on the document a transaction leads to, as part of that same
 * transaction.
 *
 * Two callers make a change and then run a command written against the state
 * after it: the `/` menu deletes the typed `/query` before the picked item
 * (commandRunner.ts `combineDeleteAndCommand`), and a block command first cuts
 * the selected lines into paragraphs of their own (paragraphLines.ts
 * `onSelectedLines`). Both need ONE transaction — one paint, one undo step.
 */
import { EditorState, Selection, type Command, type Transaction } from '@milkdown/kit/prose/state';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';

/**
 * Runs `command` against the state `base` leads `state` to, and appends what it
 * did to `base`: its steps, its selection, its stored marks and its scroll.
 * Returns whether `command` ran; `base` is untouched when it declines.
 *
 * The middle state is built with `EditorState.create`, never
 * `state.apply(base)`: `.apply()` runs every plugin's `appendTransaction`, and
 * any fixup a plugin appended there would be missing from `base` (which holds
 * only its OWN steps) — silently mis-mapping the command's positions once
 * appended onto it. `.create()` only re-inits plugin STATE, so the middle
 * document is exactly `base.doc`, and the real dispatch of `base` still runs
 * every plugin's `appendTransaction` against the final document, same as any
 * other transaction.
 */
export function foldCommandInto(
  state: EditorState,
  base: Transaction,
  command: Command,
  view?: ProseView,
): boolean {
  const middle = EditorState.create({
    schema: state.schema,
    doc: base.doc,
    selection: base.selection,
    storedMarks: base.storedMarks,
    plugins: state.plugins,
  });

  // A plain object, not a reassigned `let`: TypeScript does not carry a `let`
  // variable's narrowing past a nested closure that also assigns it (the
  // dispatch callback here), but a property read like `holder.tr` narrows.
  const holder: { tr: Transaction | null } = { tr: null };
  const ran = command(
    middle,
    (tr) => {
      holder.tr = tr;
    },
    view,
  );
  const produced = holder.tr;
  if (!ran || !produced) return ran;

  for (const step of produced.steps) base.step(step);
  // `produced.selection` is bound to `produced.doc` — a DIFFERENT Node object
  // than `base.doc`, even though the two are structurally identical (both
  // applied the same steps to the same starting doc): `Step.apply` builds a
  // fresh Node each time it runs, and ProseMirror's `setSelection` rejects a
  // selection bound to any doc it is not REFERENCE-equal to.
  // `Selection.fromJSON` rebuilds an equivalent selection bound to `base.doc`.
  if (produced.selectionSet) {
    base.setSelection(Selection.fromJSON(base.doc, produced.selection.toJSON()));
  }
  base.setStoredMarks(produced.storedMarks);
  if (produced.scrolledIntoView) base.scrollIntoView();
  return ran;
}
