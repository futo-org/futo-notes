import type { NodeType, Schema } from '@milkdown/kit/prose/model';
import { EditorState, type Command, type Transaction } from '@milkdown/kit/prose/state';
import { type Step } from '@milkdown/kit/prose/transform';

/**
 * A plugin-free copy of `state`, which is what every intermediate step below
 * runs against.
 *
 * `EditorState.apply` runs the editor's plugin `appendTransaction` hooks, and
 * the commonmark preset has one (`syncListOrderPlugin`) that rewrites list item
 * labels. Rolling the real state forward would therefore fold those appended
 * changes into the rolling document but NOT into the step list being collected,
 * so the next step would be computed against a document the final transaction
 * never has — which lands as `Cannot read properties of undefined (reading
 * 'nodeSize')` when the steps are replayed. A scratch state has no plugins, so
 * rolling doc and replayed doc stay identical; the real plugins then see the
 * one transaction that is finally dispatched and append to it as usual.
 */
export function scratchState(state: EditorState): EditorState {
  return EditorState.create({
    schema: state.schema,
    doc: state.doc,
    selection: state.selection,
  });
}

/** Replay collected steps onto one transaction built from `state`. */
export function dispatchSteps(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  steps: Step[],
): boolean {
  if (steps.length === 0) return false;
  if (dispatch) {
    const tr = state.tr;
    for (const step of steps) tr.step(step);
    dispatch(tr.scrollIntoView());
  }
  return true;
}

/**
 * Run `commands` in sequence and dispatch their combined steps as ONE
 * transaction, so a conversion that is two primitives underneath (lift out of
 * a list, then wrap in a blockquote) is one undo step and one `change`.
 *
 * Each command sees the document the previous one left behind, which is why
 * the steps can be replayed onto a single transaction: the replayed `tr` and
 * `rolling` advance in lockstep from the same starting doc.
 */
export function runChain(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  commands: Command[],
): boolean {
  const steps: Step[] = [];
  let rolling = scratchState(state);

  for (const command of commands) {
    command(rolling, (tr) => {
      steps.push(...tr.steps);
      rolling = rolling.apply(tr);
    });
  }

  return dispatchSteps(state, dispatch, steps);
}

export function nodeType(schema: Schema, name: string): NodeType | null {
  return schema.nodes[name] ?? null;
}
