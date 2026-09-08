/** Structural formatting shared by the toolbar and slash menu. */
import { lift, setBlockType, wrapIn } from '@milkdown/kit/prose/commands';
import type { Node as ProseNode, NodeType, ResolvedPos, Schema } from '@milkdown/kit/prose/model';
import { liftListItem, sinkListItem, wrapInList } from '@milkdown/kit/prose/schema-list';
import {
  EditorState,
  TextSelection,
  type Command,
  type Transaction,
} from '@milkdown/kit/prose/state';
import { Mapping, type Step } from '@milkdown/kit/prose/transform';

/**
 * The block kinds a single line can be, plus
 * `code` for the one block whose lines can carry NO markdown prefix at all.
 */
export type BlockKind = 'none' | 'bullet' | 'ordered' | 'task' | 'heading' | 'quote' | 'code';

export interface BlockFormat {
  kind: BlockKind;
  /** Heading level, 1-3. Only meaningful for `kind: 'heading'`. */
  level?: number;
}

/** The toolbar-manifest ids that map to a block command. */
export type BlockCommandId =
  'bullet' | 'ordered' | 'task' | 'heading-1' | 'heading-2' | 'heading-3' | 'paragraph' | 'quote';

const LIST_KINDS: ReadonlySet<BlockKind> = new Set<BlockKind>(['bullet', 'ordered', 'task']);

function isListKind(kind: BlockKind): boolean {
  return LIST_KINDS.has(kind);
}

function sameFormat(a: BlockFormat, b: BlockFormat): boolean {
  return a.kind === b.kind && (a.level ?? 0) === (b.level ?? 0);
}

/** The depth of the innermost ancestor of `at` named `name`, or 0 for none. */
function ancestorDepth(at: ResolvedPos, name: string): number {
  for (let depth = at.depth; depth > 0; depth -= 1) {
    if (at.node(depth).type.name === name) return depth;
  }
  return 0;
}

/**
 * Whether the textblock containing `at` is a code block.
 *
 * `spec.code` rather than the node NAME, because that flag is the schema's own
 * statement that the node's content is literal text — the property this module
 * actually depends on (the commonmark preset sets it on `code_block`, alongside
 * `marks: ''`).
 */
function isCodeTextblock(at: ResolvedPos): boolean {
  for (let depth = at.depth; depth >= 0; depth -= 1) {
    const node = at.node(depth);
    if (node.isTextblock) return node.type.spec.code === true;
  }
  return false;
}

/**
 * The block kind at `at`, innermost structure first.
 *
 * List membership takes precedence over the textblock format when converting lists.
 */
export function blockFormatAtPos(at: ResolvedPos): BlockFormat {
  // A code block is read BEFORE any wrapper, because the caret's own textblock
  // is the innermost structure there is: a fence indented under a list item is
  // code, not the bullet the list item would otherwise report.
  if (isCodeTextblock(at)) return { kind: 'code' };

  const itemDepth = ancestorDepth(at, 'list_item');
  if (itemDepth > 0) {
    const item = at.node(itemDepth);
    if (item.attrs.checked !== null && item.attrs.checked !== undefined) return { kind: 'task' };
    const list = itemDepth > 1 ? at.node(itemDepth - 1) : null;
    return { kind: list?.type.name === 'ordered_list' ? 'ordered' : 'bullet' };
  }

  const block = at.node(at.depth);
  if (block.type.name === 'heading') {
    return { kind: 'heading', level: Number(block.attrs.level ?? 1) };
  }

  return ancestorDepth(at, 'blockquote') > 0 ? { kind: 'quote' } : { kind: 'none' };
}

/** The block kind at the selection head. */
export function blockFormatAt(state: EditorState): BlockFormat {
  return blockFormatAtPos(state.selection.$from);
}

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
function scratchState(state: EditorState): EditorState {
  return EditorState.create({
    schema: state.schema,
    doc: state.doc,
    selection: state.selection,
  });
}

/** Replay collected steps onto one transaction built from `state`. */
function dispatchSteps(
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
function runChain(
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

function nodeType(schema: Schema, name: string): NodeType | null {
  return schema.nodes[name] ?? null;
}

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

/** The innermost `list_item` wrapping each textblock in `[from, to]`. */
function listItemsInRange(
  doc: ProseNode,
  from: number,
  to: number,
): { itemPos: number; listPos: number }[] {
  const seen = new Set<number>();
  const found: { itemPos: number; listPos: number }[] = [];

  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true;
    const at = doc.resolve(pos);
    const depth = ancestorDepth(at, 'list_item');
    if (depth > 1) {
      const itemPos = at.before(depth);
      if (!seen.has(itemPos)) {
        seen.add(itemPos);
        found.push({ itemPos, listPos: at.before(depth - 1) });
      }
    }
    return false;
  });

  return found;
}

/**
 * Convert list items in place between bullet, ordered and task — the ONLY
 * cross-kind path that does not lift and re-wrap, because lifting would flatten
 * a nested item the user never asked to outdent.
 *
 * The list NODE's type is per-list (markdown has no mixed bullet/ordered list),
 * so the whole enclosing list converts; `checked` is per-item, so only the
 * items the selection touches become (or stop being) tasks. `listType` has to
 * move with the node type or the preset's `syncListOrderPlugin` converts it
 * straight back.
 */
function retargetList(target: BlockFormat): Command {
  return (state, dispatch) => {
    const { from, to } = state.selection;
    const items = listItemsInRange(state.doc, from, to);
    if (items.length === 0) return false;

    const wantOrdered = target.kind === 'ordered';
    const listType = nodeType(state.schema, wantOrdered ? 'ordered_list' : 'bullet_list');
    if (!listType) return false;

    const tr = state.tr;
    // Every edit below is a `setNodeMarkup`, which never changes a node's size,
    // so the positions collected against the starting doc stay valid.
    for (const { itemPos } of items) {
      const item = state.doc.nodeAt(itemPos);
      if (!item) continue;
      tr.setNodeMarkup(itemPos, undefined, {
        ...item.attrs,
        checked: target.kind === 'task' ? (item.attrs.checked ?? false) : null,
        listType: wantOrdered ? 'ordered' : 'bullet',
        ...(wantOrdered ? {} : { label: '•' }),
      });
    }

    for (const listPos of new Set(items.map((i) => i.listPos))) {
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

/** Group adjacent formats so a selection creates one list rather than one per paragraph. */
function blockRuns(state: EditorState): BlockRun[] {
  const { from, to } = state.selection;
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

/** List buttons toggle; heading levels, Text and Quote are explicit choices. */
export function blockCommand(command: BlockCommandId): Command {
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

/** Set a format; heading/Text changes leave enclosing quotes in place. */
export function setBlockFormat(target: BlockFormat): Command {
  return transitionRuns((current) => (current.kind === 'code' ? current : target));
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
