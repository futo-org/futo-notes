// The fast writes: markdown straight into the document, one call, no caret. See the note on
// `fastWriteVerbs` for what they are for and what they must never stand in for.
import { Fragment, Slice, type Node as ProseNode } from '@milkdown/kit/prose/model';
import { Selection, type Transaction } from '@milkdown/kit/prose/state';
import { canJoin } from '@milkdown/kit/prose/transform';
import type { EditorView } from '@milkdown/kit/prose/view';

import type { editorVerb } from './puppetEditorVerbs';
import {
  isPuppetOutcome,
  puppetRefusal as refuse,
  type Args,
  type PuppetEditorProvider,
  type PuppetOutcome,
  type PuppetVerb,
} from './puppetRegistry';
import { type ModelLine } from './puppetLines';
import { linesOnScreen, noteLines } from './puppetNoteLines';
import {
  anchorRange,
  lineOrRefusal,
  rangeFrom,
  rangeRefusal,
  shownTextBetween,
  TEXT_PARAMS,
} from './puppetText';

const LIST_TYPES = new Set(['bullet_list', 'ordered_list']);

/** Where `Insert` writes: a position on screen, or the edge of the text it is anchored to. */
function insertPoint(view: EditorView, args: Args): number | PuppetOutcome {
  const anchors = ['at', 'after', 'before'].filter((key) => args[key] !== undefined);
  if (anchors.length > 1) {
    return refuse(400, `Insert: give one of "at", "after", "before" — got ${anchors.join(', ')}`);
  }
  if (typeof args.after === 'string') {
    const range = anchorRange(view, 'after', args.after);
    return isPuppetOutcome(range) ? range : range.to;
  }
  if (typeof args.before === 'string') {
    const range = anchorRange(view, 'before', args.before);
    return isPuppetOutcome(range) ? range : range.from;
  }
  if (typeof args.at !== 'number') {
    return refuse(
      400,
      'Insert needs {"at":<position>} or {"after":"<exact text>"}/{"before":"<exact text>"}; `doc` prints where each line starts and ends',
    );
  }
  return rangeRefusal(view, args.at, args.at, args) ?? args.at;
}

/** `text` read the way the editor reads a note, as top-level blocks. */
function parsedBlocks(
  view: EditorView,
  editor: PuppetEditorProvider,
  text: string,
): Fragment | PuppetOutcome {
  if (text === '') return Fragment.from(view.state.schema.nodes.paragraph.create());
  const parsed = editor.parseMarkdown(text);
  if (!parsed) return refuse(500, 'the editor could not read the text as markdown');
  return parsed.content;
}

/** Put the caret after what a transaction just inserted, as a paste leaves it. */
function caretAfterInsertion(tr: Transaction): void {
  if (tr.steps.length === 0) return;
  let end: number | null = null;
  tr.mapping.maps[tr.steps.length - 1].forEach((_from, _to, _newFrom, newTo) => {
    end ??= newTo;
  });
  if (end !== null) tr.setSelection(Selection.near(tr.doc.resolve(end), -1));
}

/** Join the list just written with a same-type list it now touches, as markdown would read them. */
function joinNeighbouringLists(tr: Transaction, from: number, to: number): void {
  for (const pos of [to, from]) {
    const at = tr.doc.resolve(Math.min(pos, tr.doc.content.size));
    const before = at.nodeBefore;
    const after = at.nodeAfter;
    if (before && after && LIST_TYPES.has(before.type.name) && before.type === after.type) {
      if (canJoin(tr.doc, pos)) tr.join(pos);
    }
  }
}

function dispatch(view: EditorView, tr: Transaction): void {
  view.dispatch(tr.scrollIntoView());
}

/**
 * `text` as a slice to write into a line. Markdown trims a paragraph's edge spaces, and a
 * write into the middle of a line needs them (`Insert {"after":"coffee","text":" beans"}`),
 * so a single line of text keeps them.
 */
function markdownSlice(
  view: EditorView,
  editor: PuppetEditorProvider,
  text: string,
): Slice | PuppetOutcome {
  if (text === '') return Slice.empty;
  const { schema } = view.state;
  const inLine = (inline: Fragment) =>
    new Slice(Fragment.from(schema.nodes.paragraph.create(null, inline)), 1, 1);
  if (text.trim() === '' && !text.includes('\n')) return inLine(Fragment.from(schema.text(text)));
  const blocks = parsedBlocks(view, editor, text);
  if (isPuppetOutcome(blocks)) return blocks;
  const only = blocks.childCount === 1 ? blocks.firstChild : null;
  if (!text.includes('\n') && only?.type.name === 'paragraph') {
    const lead = /^\s*/.exec(text)?.[0] ?? '';
    const trail = /\s*$/.exec(text)?.[0] ?? '';
    return inLine(
      Fragment.from(lead ? schema.text(lead) : [])
        .append(only.content)
        .append(Fragment.from(trail ? schema.text(trail) : [])),
    );
  }
  return Slice.maxOpen(blocks);
}

/** Markdown over a range, fitted the way a paste fits it: inline text joins the line it lands in. */
function writeMarkdown(
  view: EditorView,
  editor: PuppetEditorProvider,
  from: number,
  to: number,
  text: string,
): PuppetOutcome | null {
  const slice = markdownSlice(view, editor, text);
  if (isPuppetOutcome(slice)) return slice;
  const tr = view.state.tr;
  tr.replaceRange(from, to, slice);
  caretAfterInsertion(tr);
  dispatch(view, tr);
  return null;
}

/**
 * The list items `blocks` become inside a list: a list's own items, anything else wrapped in
 * one. Null when a block cannot start an item (a divider, a table): it goes after the list.
 */
function asListItems(blocks: Fragment, list: ProseNode): Fragment | null {
  const item = list.type.schema.nodes.list_item;
  const items: ProseNode[] = [];
  let fits = true;
  blocks.forEach((block) => {
    if (LIST_TYPES.has(block.type.name)) block.forEach((child) => items.push(child));
    else if (item.validContent(Fragment.from(block))) items.push(item.create(null, block));
    else fits = false;
  });
  return fits ? Fragment.from(items) : null;
}

/**
 * New blocks right after the block holding `entry`, at that block's level: a sibling item
 * inside a list, a sibling block anywhere else. A line followed by a line break in the same
 * paragraph gets a new line there, after a break of the same kind.
 */
function insertAfterLine(
  view: EditorView,
  editor: PuppetEditorProvider,
  entry: ModelLine,
  text: string,
): PuppetOutcome | null {
  const { doc, schema } = view.state;
  const blocks = parsedBlocks(view, editor, text);
  if (isPuppetOutcome(blocks)) return blocks;
  const tr = view.state.tr;
  const at = doc.resolve(entry.at);
  const block = entry.textblock;
  // A code line's next line is more of the same code.
  if (block?.type.spec.code) {
    tr.insertText(`\n${text}`, entry.end);
    dispatch(view, tr);
    return null;
  }
  if (block && entry.end < at.end()) {
    const first = blocks.firstChild;
    if (blocks.childCount !== 1 || first?.type.name !== 'paragraph') {
      return refuse(
        409,
        `line ${entry.line} ends in a line break inside its paragraph, so the line after it is part of that paragraph: InsertLine there takes plain inline text, not a new block`,
      );
    }
    const lineBreak = schema.nodes.hardbreak.create(doc.nodeAt(entry.end)?.attrs);
    tr.insert(entry.end, Fragment.from(lineBreak).append(first.content));
    caretAfterInsertion(tr);
    dispatch(view, tr);
    return null;
  }
  // The item, when the line is its first block; otherwise the block itself.
  const itemDepth =
    block &&
    at.depth >= 2 &&
    at.node(at.depth - 1).type.name === 'list_item' &&
    at.index(at.depth - 1) === 0
      ? at.depth - 1
      : null;
  try {
    if (itemDepth !== null) {
      const items = asListItems(blocks, at.node(itemDepth - 1));
      tr.insert(items ? at.after(itemDepth) : at.after(itemDepth - 1), items ?? blocks);
      caretAfterInsertion(tr);
    } else {
      const pos = block ? at.after() : entry.end;
      tr.insert(pos, blocks);
      caretAfterInsertion(tr);
      if (at.depth <= 1) joinNeighbouringLists(tr, pos, pos + blocks.size);
    }
  } catch (error) {
    return refuse(
      409,
      `the text does not fit after line ${entry.line} (${entry.kind}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  dispatch(view, tr);
  return null;
}

/**
 * A write no person can make: markdown lands in the document directly, past the keymap, the
 * input rules and every input handler, read the way the editor reads a note. Much faster for
 * an agent — one call, no caret — and the right tool for arranging a document. Never the tool
 * for checking what TYPING does; `Type`/`Press` are. `actions` lists these with
 * `convenience: true` so the menu says which is which.
 */
export function fastWriteVerbs(verb: typeof editorVerb): PuppetVerb[] {
  const convenience = { convenience: true } as const;
  return [
    verb(
      'Insert',
      {
        at: 'integer?',
        after: 'string?',
        before: 'string?',
        text: 'string',
        docVersion: 'integer?',
      },
      (view, editor, args) => {
        const at = insertPoint(view, args);
        if (isPuppetOutcome(at)) return at;
        const text = args.text as string;
        const failed = writeMarkdown(view, editor, at, at, text);
        if (failed) return failed;
        // The receipt says what this verb wrote and where. `diff.doc` is a minimal hunk
        // between two snapshots, so it can start mid-word and read as a different string.
        return { wrote: { from: at, to: at, removed: '', inserted: text } };
      },
      convenience,
    ),
    verb(
      'Replace',
      {
        from: 'integer?',
        to: 'integer?',
        find: 'string?',
        text: 'string',
        expect: 'string?',
        docVersion: 'integer?',
      },
      (view, editor, args) => {
        const range = rangeFrom(view, args, 'Replace');
        if (isPuppetOutcome(range)) return range;
        const text = args.text as string;
        const note = noteLines(view.state.doc);
        const removed = shownTextBetween(note, linesOnScreen(view, note), range.from, range.to);
        const failed = writeMarkdown(view, editor, range.from, range.to, text);
        if (failed) return failed;
        return { wrote: { ...range, removed, inserted: text } };
      },
      convenience,
    ),
    // Line-addressed edits: the line is the verb's business, so a driver that picks among
    // whole lines never works out positions itself. Each is one transaction, one undo step.
    verb(
      'ReplaceLine',
      { line: 'integer', text: 'string' },
      (view, editor, args) => {
        const entry = lineOrRefusal(view, args.line as number);
        if (isPuppetOutcome(entry)) return entry;
        return writeMarkdown(view, editor, entry.at, entry.end, args.text as string) ?? undefined;
      },
      convenience,
    ),
    verb(
      'InsertLine',
      { afterLine: 'integer', text: 'string' },
      (view, editor, args) => {
        const afterLine = args.afterLine as number;
        const text = args.text as string;
        if (afterLine === 0) {
          // The note's top: written where line 1 is, so it shows as line 1 does.
          const top = lineOrRefusal(view, 1);
          if (isPuppetOutcome(top)) return top;
          const blocks = parsedBlocks(view, editor, text);
          if (isPuppetOutcome(blocks)) return blocks;
          const tr = view.state.tr.insert(0, blocks);
          caretAfterInsertion(tr);
          joinNeighbouringLists(tr, 0, blocks.size);
          dispatch(view, tr);
          return undefined;
        }
        const entry = lineOrRefusal(view, afterLine);
        if (isPuppetOutcome(entry)) return entry;
        return insertAfterLine(view, editor, entry, text) ?? undefined;
      },
      convenience,
    ),
    verb(
      'AppendLine',
      TEXT_PARAMS,
      (view, editor, args) => {
        // A new last line. The document's open last line — the empty paragraph the editor keeps
        // after a list or a heading — is filled rather than written after; empty text leaves a
        // blank line AND a fresh open line, so the next call cannot consume the blank. Any run of
        // AppendLine therefore reads back as exactly the lines it was given, blanks included.
        const text = args.text as string;
        // The note's end: written where its last line is, so it shows as that line does.
        const lastLine = lineOrRefusal(view, noteLines(view.state.doc).count);
        if (isPuppetOutcome(lastLine)) return lastLine;
        const { doc, schema } = view.state;
        const last = doc.lastChild;
        const openLast = last?.type.name === 'paragraph' && last.content.size === 0;
        const empty = () => schema.nodes.paragraph.create();
        const blocks =
          text === ''
            ? Fragment.from(openLast ? [empty()] : [empty(), empty()])
            : parsedBlocks(view, editor, text);
        if (isPuppetOutcome(blocks)) return blocks;
        const end = doc.content.size;
        const from = openLast && text !== '' ? end - last.nodeSize : end;
        const tr = view.state.tr.replaceWith(from, end, blocks);
        caretAfterInsertion(tr);
        joinNeighbouringLists(tr, from, from + blocks.size);
        dispatch(view, tr);
        return undefined;
      },
      convenience,
    ),
  ];
}
