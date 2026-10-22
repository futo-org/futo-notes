/** Structural formatting shared by the toolbar and slash menu. */
import { lift, setBlockType, wrapIn } from '@milkdown/kit/prose/commands';
import type { Node as ProseNode, ResolvedPos, Schema } from '@milkdown/kit/prose/model';
import { liftListItem, sinkListItem, wrapInList } from '@milkdown/kit/prose/schema-list';
import {
  EditorState,
  type Selection,
  TextSelection,
  type Command,
  type Transaction,
} from '@milkdown/kit/prose/state';
import { Mapping, type Step } from '@milkdown/kit/prose/transform';
import { writtenContentEnd } from '@futo-notes/editor/milkdown-compat';
import { onSelectedLines } from './paragraphLines';

import {
  type BlockFormat,
  isListKind,
  sameFormat,
  ancestorDepth,
  isCodeTextblock,
  blockFormatAtPos,
} from './blockFormat';
import { scratchState, dispatchSteps, runChain, nodeType } from './blockStepChain';

export { blockFormatAtPos, type BlockFormat, type BlockKind } from './blockFormat';

/** The toolbar-manifest ids that map to a block command. */
export type BlockCommandId =
  'bullet' | 'ordered' | 'task' | 'heading-1' | 'heading-2' | 'heading-3' | 'paragraph' | 'quote';

/**
 * Lift repeated until the selection is out of every list it was in — one tap
 * removes the bullet ENTIRELY rather than outdenting one level, which is what
 * makes the toggle honest: `formatState` would otherwise keep reporting the
 * button active after the tap that was meant to clear it.
 *
 * `liftListItem` rather than plain `lift`, because a selection spanning TWO
 * items of one list has a block range whose children are `list_item`s, and
 * lifting those straight into the doc is not a valid move — plain `lift`
 * silently does nothing there (it works only for the single-item case, where
 * the range is the item's paragraph). `liftListItem` knows how to split the
 * list around the items instead.
 *
 * The iteration count is not derivable up front — how far one lift travels
 * depends on the nesting — so the loop asks the document after each step. The
 * bound is a safety net against a schema where lifting reports progress without
 * ever satisfying the predicate.
 */
function liftOutOfLists(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  const listItem = nodeType(state.schema, 'list_item');
  return liftUntilOut(
    (s) => ancestorDepth(s.selection.$from, 'list_item') > 0,
    listItem ? liftListItem(listItem) : lift,
  )(state, dispatch);
}

function liftUntilOut(stillInside: (state: EditorState) => boolean, liftOnce: Command): Command {
  const MAX_LIFTS = 16;
  return (state, dispatch) => {
    const steps: Step[] = [];
    let rolling = scratchState(state);

    for (let i = 0; i < MAX_LIFTS && stillInside(rolling); i += 1) {
      let moved = false;
      liftOnce(rolling, (tr) => {
        steps.push(...tr.steps);
        rolling = rolling.apply(tr);
        moved = true;
      });
      if (!moved) break;
    }

    return dispatchSteps(state, dispatch, steps);
  };
}

/** The position of every LIST (bullet_list/ordered_list) with a textblock in `[from, to]`. */
function listsTouchedByRange(doc: ProseNode, from: number, to: number): Set<number> {
  const listPositions = new Set<number>();

  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true;
    const at = doc.resolve(pos);
    const depth = ancestorDepth(at, 'list_item');
    if (depth > 1) listPositions.add(at.before(depth - 1));
    return false;
  });

  return listPositions;
}

/** The position of every `list_item` directly inside the list at `listPos`. */
function itemsOfList(doc: ProseNode, listPos: number): number[] {
  const list = doc.nodeAt(listPos);
  if (!list) return [];
  const positions: number[] = [];
  let offset = listPos + 1; // just inside the list, before its first child
  list.forEach((item) => {
    positions.push(offset);
    offset += item.nodeSize;
  });
  return positions;
}

/**
 * Convert list items in place between bullet, ordered and task — the ONLY
 * cross-kind path that does not lift and re-wrap, because lifting would flatten
 * a nested item the user never asked to outdent.
 *
 * The list NODE's type is per-list (markdown has no mixed bullet/ordered list),
 * so the whole enclosing list converts, and every ITEM in that list has to
 * convert too — not only the ones the selection/caret touches.
 *
 * QA #002: converting only the touched items' `listType` attr left untouched
 * siblings holding the OLD kind's attrs even though the shared container node
 * now read as the new kind. That went unnoticed for bullet -> ordered, because
 * the preset's `syncListOrderPlugin` (`@milkdown/preset-commonmark`)
 * self-heals it: it forces every `list_item` under an `ordered_list` to
 * `listType: "ordered"`, so the desync got silently patched up for free. But
 * that plugin has no rule the other way — converting ordered -> bullet with
 * the caret on one line only flips that item and the container, and the
 * plugin then finds the CONTAINER's first child still marked
 * `listType: "ordered"` and promotes it straight back to `ordered_list`,
 * silently undoing the toggle the user just pressed. Writing every item's
 * attrs, not only the touched ones, closes both directions.
 */
function retargetList(target: BlockFormat): Command {
  return (state, dispatch) => {
    const { from, to } = state.selection;
    const listPositions = listsTouchedByRange(state.doc, from, to);
    if (listPositions.size === 0) return false;

    const wantOrdered = target.kind === 'ordered';
    const listType = nodeType(state.schema, wantOrdered ? 'ordered_list' : 'bullet_list');
    if (!listType) return false;

    const tr = state.tr;
    // Every edit below is a `setNodeMarkup`, which never changes a node's size,
    // so the positions collected against the starting doc stay valid.
    for (const listPos of listPositions) {
      for (const itemPos of itemsOfList(state.doc, listPos)) {
        const item = state.doc.nodeAt(itemPos);
        if (!item) continue;
        tr.setNodeMarkup(itemPos, undefined, {
          ...item.attrs,
          checked: target.kind === 'task' ? (item.attrs.checked ?? false) : null,
          listType: wantOrdered ? 'ordered' : 'bullet',
          ...(wantOrdered ? {} : { label: '•' }),
        });
      }
    }

    for (const listPos of listPositions) {
      const list = state.doc.nodeAt(listPos);
      if (!list || list.type === listType) continue;
      tr.setNodeMarkup(listPos, listType, {
        ...(wantOrdered ? { order: 1 } : {}),
        spread: list.attrs.spread ?? false,
      });
    }

    if (tr.steps.length === 0) return false;
    dispatch?.(tr.scrollIntoView());
    return true;
  };
}

/** The command that removes `current`'s block prefix, or null when there is none. */
function stripCommand(current: BlockFormat, schema: Schema): Command | null {
  // `code` falls through to null with the other prefix-less kinds.
  if (isListKind(current.kind)) return liftOutOfLists;
  if (current.kind === 'quote') return lift;
  if (current.kind === 'heading') {
    const paragraph = nodeType(schema, 'paragraph');
    return paragraph ? setBlockType(paragraph) : null;
  }
  return null;
}

/**
 * The command that applies `target`'s block prefix, or null when there is no
 * prefix to write — plain text, and code, whose lines can carry none.
 */
function applyCommand(target: BlockFormat, schema: Schema): Command | null {
  switch (target.kind) {
    case 'none':
    case 'code':
      return null;
    case 'bullet':
    case 'task': {
      const list = nodeType(schema, 'bullet_list');
      if (!list) return null;
      const wrap = wrapInList(list);
      if (target.kind === 'bullet') return wrap;
      return (state, dispatch) => runChain(state, dispatch, [wrap, retargetList(target)]);
    }
    case 'ordered': {
      const list = nodeType(schema, 'ordered_list');
      return list ? wrapInList(list) : null;
    }
    case 'quote': {
      const quote = nodeType(schema, 'blockquote');
      return quote ? wrapIn(quote) : null;
    }
    case 'heading': {
      const heading = nodeType(schema, 'heading');
      return heading ? setBlockType(heading, { level: target.level ?? 1 }) : null;
    }
  }
}

/** Turn the block(s) the command is acting on from `current` into `target`. */
function applyTransition(current: BlockFormat, target: BlockFormat): Command {
  return (state, dispatch) => {
    if (current.kind === 'code' || sameFormat(current, target)) return false;
    if (target.kind === 'quote' && ancestorDepth(state.selection.$from, 'blockquote') > 0)
      return false;
    if ((target.kind === 'heading' || target.kind === 'none') && !isListKind(current.kind)) {
      const type = nodeType(state.schema, target.kind === 'heading' ? 'heading' : 'paragraph');
      return type
        ? setBlockType(type, target.kind === 'heading' ? { level: target.level ?? 1 } : undefined)(
            state,
            dispatch,
          )
        : false;
    }
    // Bullet ⇄ ordered ⇄ task: retarget in place so nesting survives.
    if (isListKind(current.kind) && isListKind(target.kind)) {
      return retargetList(target)(state, dispatch);
    }
    const chain = [stripCommand(current, state.schema), applyCommand(target, state.schema)].filter(
      (c): c is Command => c !== null,
    );
    if (chain.length === 0) return false;
    return runChain(state, dispatch, chain);
  };
}

/** A maximal stretch of adjacent textblocks in the selection sharing one kind. */
interface BlockRun {
  from: number;
  to: number;
  format: BlockFormat;
}

/**
 * Group adjacent formats so a selection creates one list rather than one per paragraph.
 *
 * A selection that reaches past the note's written content (select-all, or a
 * drag to the very end) stops where that content ends: the empty paragraph
 * `@milkdown/plugin-trailing` parks after a final list or quote is never
 * saved, so formatting it would write a bare `-`, `1.` or `#` the user never
 * typed — and, as its own `none` run, it would toggle ON while the list beside
 * it toggles off. A selection that is only that line (the caret on it) still
 * formats it.
 */
function blockRuns(state: EditorState): BlockRun[] {
  const scope = selectionWithinWrittenContent(state);
  if (!scope) return [];
  const { from, to } = scope;
  const runs: BlockRun[] = [];

  state.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true;
    // Inner positions: they stay inside the block when a wrapper is added
    // around it, so they still map correctly after an earlier run has run.
    const start = pos + 1;
    const end = start + node.content.size;
    const format = blockFormatAtPos(state.doc.resolve(start));
    const last = runs.length > 0 ? runs[runs.length - 1] : undefined;
    if (last && sameFormat(last.format, format)) last.to = end;
    else runs.push({ from: start, to: end, format });
    return false;
  });

  return runs;
}

/**
 * The selection a block format should act on: the user's own, unless it
 * reaches past the note's written content (the reason `blockRuns` gives) —
 * then a text selection over the written textblocks it covers, or null when it
 * covers none. A selection that is only the unwritten tail is left alone.
 */
export function selectionWithinWrittenContent(state: EditorState): Selection | null {
  const { from, to } = state.selection;
  const writtenEnd = writtenContentEnd(state.doc);
  if (from >= writtenEnd || to <= writtenEnd) return state.selection;

  let first = -1;
  let last = -1;
  state.doc.nodesBetween(from, writtenEnd, (node, pos) => {
    if (!node.isTextblock) return true;
    if (first === -1) first = Math.max(from, pos + 1);
    last = pos + 1 + node.content.size;
    return false;
  });
  return first === -1 ? null : TextSelection.create(state.doc, first, last);
}

/**
 * `command`, run on `selectionWithinWrittenContent`, for a command that reads
 * the selection itself — the preset's Code block is a bare `setBlockType` that
 * would turn the parked trailing paragraph into an empty fence. The user's own
 * selection is mapped forward, not replaced.
 */
export function withinWrittenContent(command: Command): Command {
  return (state, dispatch) => {
    const scope = selectionWithinWrittenContent(state);
    if (scope === state.selection) return command(state, dispatch);
    if (!scope) return false;

    const scratch = scratchState(state);
    const scoped = scratch.apply(scratch.tr.setSelection(scope));
    const steps: Step[] = [];
    if (!command(scoped, (tr) => steps.push(...tr.steps))) return false;
    return dispatchSteps(state, dispatch, steps);
  };
}

/**
 * Turn every run in the selection into whatever `target` says it becomes, as
 * ONE transaction.
 *
 * Runs, not the whole selection, for the reason `blockRuns` documents; the
 * target is a function of the run's CURRENT format, so a mixed selection gets
 * the per-run answer rather than one collapsed answer.
 *
 * Returns false — leaving the document untouched — when no run has a
 * representable transition, which is what keeps a command from writing a
 * half-converted block. The user's own selection is never set here: the single
 * dispatched transaction maps it forward, the same as any other edit.
 */
function transitionRuns(target: (current: BlockFormat) => BlockFormat): Command {
  return (state, dispatch) => {
    const runs = blockRuns(state);
    if (runs.length === 0) return false;

    const steps: Step[] = [];
    const mapping = new Mapping();
    let rolling = scratchState(state);

    for (const run of runs) {
      const from = mapping.map(run.from);
      const to = mapping.map(run.to);
      if (from > rolling.doc.content.size || to > rolling.doc.content.size) continue;

      // Scope the command to this run by selecting it. Selection-only
      // transactions carry no steps, so they never reach the outer transaction.
      const scoped = rolling.apply(
        rolling.tr.setSelection(TextSelection.create(rolling.doc, from, to)),
      );
      rolling = scoped;

      applyTransition(run.format, target(run.format))(scoped, (tr) => {
        steps.push(...tr.steps);
        mapping.appendMapping(tr.mapping);
        rolling = scoped.apply(tr);
      });
    }

    return dispatchSteps(state, dispatch, steps);
  };
}

/**
 * List buttons toggle; heading levels, Text and Quote are explicit choices.
 * Each lands on the typed LINES the selection touches, not on every line of a
 * multi-line paragraph (paragraphLines.ts `onSelectedLines`).
 */
export function blockCommand(command: BlockCommandId): Command {
  return onSelectedLines(unscopedBlockCommand(command));
}

function unscopedBlockCommand(command: BlockCommandId): Command {
  switch (command) {
    case 'heading-1':
      return setBlockFormat({ kind: 'heading', level: 1 });
    case 'heading-2':
      return setBlockFormat({ kind: 'heading', level: 2 });
    case 'heading-3':
      return setBlockFormat({ kind: 'heading', level: 3 });
    case 'paragraph':
      return setBlockFormat({ kind: 'none' });
    case 'quote':
      return setBlockFormat({ kind: 'quote' });
    default:
      return transitionRuns((current) =>
        current.kind === 'code'
          ? current
          : {
              kind: current.kind === command ? 'none' : command,
            },
      );
  }
}

/**
 * Set a format; heading/Text changes leave enclosing quotes in place. Not
 * line-scoped here: its one caller, the `/` menu, runs every pick through
 * commandRunner.ts `runAfterDelete`, which scopes it to the selected lines.
 */
export function setBlockFormat(target: BlockFormat): Command {
  return transitionRuns((current) => (current.kind === 'code' ? current : target));
}

/**
 * Whether `at` sits inside a list item or a blockquote — the two containers
 * `changeBlockIndent` acts on. Used to decide Indent/Outdent visibility for a
 * bare caret (the desktop selection toolbar, the `cursorContext` bridge
 * message): `blockFormatAtPos` cannot serve this, because it reports only the
 * INNERMOST block's own kind — a heading nested inside a quote reports
 * `heading`, not `quote`, which would hide the buttons exactly where they
 * should show.
 */
export function inIndentableContainer(at: ResolvedPos): boolean {
  if (isCodeTextblock(at)) return false;
  return ancestorDepth(at, 'list_item') > 0 || ancestorDepth(at, 'blockquote') > 0;
}

/**
 * Whether any textblock the selection touches is a code block — the guard the
 * presets' own block-type key chords need (keyboardParity.ts
 * `handleBlockTypeChord`): unlike the commands above they are bare
 * `setBlockType`/`wrapIn`s that would rewrite the fence.
 */
export function selectionTouchesCode(state: EditorState): boolean {
  const { from, to } = state.selection;
  let code = false;
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (code) return false;
    if (!node.isTextblock) return true;
    code = isCodeTextblock(state.doc.resolve(pos + 1));
    return false;
  });
  return code;
}

/** Change the nearest list or quote container by exactly one level. */
export function changeBlockIndent(direction: 1 | -1): Command {
  return (state, dispatch) => {
    const at = state.selection.$from;
    if (isCodeTextblock(at)) return false;
    for (let depth = at.depth; depth > 0; depth--) {
      const node = at.node(depth);
      if (node.type.name === 'list_item') {
        const command = direction === 1 ? sinkListItem(node.type) : liftListItem(node.type);
        return command(state, dispatch);
      }
      if (node.type.name === 'blockquote') {
        return (direction === 1 ? wrapIn(node.type) : lift)(state, dispatch);
      }
    }
    return false;
  };
}
