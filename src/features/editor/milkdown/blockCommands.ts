/*
 * The toolbar's BLOCK-format commands, as ProseMirror commands.
 *
 * The rule is "one line, one block prefix": a line is plain, a bullet, an
 * ordered item, a task, a heading or a quote, never two at once; a command
 * rewrites that one prefix, and a multi-line selection gets the transition
 * applied per line ([editor.md](../../../../docs/spec/editor.md) → "Markdown
 * toolbar"). The spec is the source of that rule — this used to be one of two
 * engines implementing it, alongside the CodeMirror toolbar's markdown-source
 * model in `toolbar/blockFormatting.ts`, and carried a drift-registry entry to
 * keep the pair honest. That engine was deleted with the Milkdown swap, so
 * there is one implementation now and no registry entry.
 *
 * A CODE BLOCK is the one block that rule cannot touch: its content is literal
 * text, so a `>` or `#` written there is code rather than a prefix. Every
 * command therefore leaves it — and every line of it, fence markers included —
 * exactly as it is, and a selection that spans one formats the prose around it
 * without swallowing the fence.
 *
 * Milkdown's own preset commands are NOT toggles — `wrapInBulletListCommand`
 * is a bare `wrapIn`, so tapping Bullet on a bullet did nothing and tapping
 * Quote on a quote produced `> > text`. Everything here is built from
 * prosemirror-commands / prosemirror-schema-list instead, so the transitions
 * are the standard, well-tested primitives.
 *
 * `tests/editor-embed-milkdown-toolbar.spec.ts` asserts the user-visible
 * outcomes.
 */
import { lift, setBlockType, wrapIn } from '@milkdown/kit/prose/commands';
import type { Node as ProseNode, NodeType, ResolvedPos, Schema } from '@milkdown/kit/prose/model';
import { liftListItem, wrapInList } from '@milkdown/kit/prose/schema-list';
import {
  EditorState,
  TextSelection,
  type Command,
  type Transaction,
} from '@milkdown/kit/prose/state';
import { Mapping, type Step } from '@milkdown/kit/prose/transform';

/**
 * The block kinds a single line can be, mirroring `blockFormatting.ts`, plus
 * `code` for the one block whose lines can carry NO markdown prefix at all.
 */
export type BlockKind = 'none' | 'bullet' | 'ordered' | 'task' | 'heading' | 'quote' | 'code';

export interface BlockFormat {
  kind: BlockKind;
  /** Heading level, 1-3. Only meaningful for `kind: 'heading'`. */
  level?: number;
}

/** The toolbar-manifest ids that map to a block command. */
export type BlockCommandId = 'bullet' | 'ordered' | 'task' | 'heading' | 'quote';

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
 * A list item wins over a heading, which wins over a blockquote — the order the
 * prefixes on one markdown line would be read in, so `- # x` reads as a bullet
 * the same way `blockFormatting.ts`'s `parseLine` reads it.
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
 * What `command` turns `current` into. Same transition table as
 * `blockFormatting.ts`'s `transitionLineKind`: tapping a kind onto itself
 * removes it, tapping a different kind converts, and Heading cycles
 * h1 → h2 → h3 → plain.
 */
export function nextBlockFormat(current: BlockFormat, command: BlockCommandId): BlockFormat {
  // A code block's content is LITERAL TEXT: `>` or `#` written into it is code,
  // not a prefix, so no command has anything to turn it into. Reported unchanged
  // so `applyTransition` finds nothing to strip and nothing to apply, and the
  // tap lands on `blockCommand`'s document-untouched path — the same answer the
  // CodeMirror engine gives by skipping the fence's lines
  // (`toolbar/blockFormatting.ts`, and docs/spec/editor.md -> "Markdown toolbar").
  if (current.kind === 'code') return current;

  switch (command) {
    case 'bullet':
      return { kind: current.kind === 'bullet' ? 'none' : 'bullet' };
    case 'ordered':
      return { kind: current.kind === 'ordered' ? 'none' : 'ordered' };
    case 'task':
      return { kind: current.kind === 'task' ? 'none' : 'task' };
    case 'quote':
      return { kind: current.kind === 'quote' ? 'none' : 'quote' };
    case 'heading':
      if (current.kind !== 'heading') return { kind: 'heading', level: 1 };
      return (current.level ?? 1) < 3
        ? { kind: 'heading', level: (current.level ?? 1) + 1 }
        : { kind: 'none' };
  }
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

function liftOutOfQuotes(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  return liftUntilOut((s) => ancestorDepth(s.selection.$from, 'blockquote') > 0, lift)(
    state,
    dispatch,
  );
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
  if (current.kind === 'quote') return liftOutOfQuotes;
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
    // Plain text writes no prefix — and neither does code, which is only ever
    // its own target (`nextBlockFormat`): with `stripCommand` finding nothing
    // to remove either, the chain comes out empty and the run is left exactly
    // as it was.
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
 * The selection split into runs of same-kind blocks.
 *
 * Runs, not individual blocks, because both granularities are wrong on their
 * own: one command over the whole selection collapses a MIXED selection to a
 * single transition (selecting an h1 and a paragraph and tapping Heading has to
 * give h2 and h1, not h2 and h2), while one command per block would wrap two
 * selected paragraphs into two adjacent one-item lists instead of one list of
 * two. A run gets exactly one transition and one primitive, which is both.
 */
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
 * The ProseMirror command behind one block-format toolbar button.
 *
 * Returns false — leaving the document untouched — when the transition has no
 * representation at the caret, which is what keeps a tap from writing a
 * half-converted block. The user's own selection is never set here: the single
 * dispatched transaction maps it forward, the same as any other edit.
 */
export function blockCommand(command: BlockCommandId): Command {
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

      applyTransition(run.format, nextBlockFormat(run.format, command))(scoped, (tr) => {
        steps.push(...tr.steps);
        mapping.appendMapping(tr.mapping);
        rolling = scoped.apply(tr);
      });
    }

    return dispatchSteps(state, dispatch, steps);
  };
}
