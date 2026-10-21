/*
 * The plain-text paste route: a paste with `text/plain` and no `text/html` (a
 * terminal, a code editor, a phone's clipboard). The text is read as markdown,
 * but the characters it puts in the line are the ones that were copied.
 *
 * This replaces `@milkdown/plugin-clipboard`'s plain-text branch, which is
 * registered after it and still owns the `text/html` and VS Code routes. That
 * branch parsed the text as a markdown file of its own and round-tripped the
 * result through the DOM with HTML's whitespace rules, so:
 *
 * - the spaces and tabs at either end of the paste were trimmed (a line's ends,
 *   to the parser): `hello` + ` world` saved `helloworld`;
 * - every run of spaces or tabs inside it became one space;
 * - a pasted block (`# Title`, a list, a fence) after text on a line merged its
 *   text into the line, its markup gone: `start` + `# Title` saved
 *   `startTitle`, and on the empty line an Enter makes, `start\nTitle`; the
 *   same in a heading (`## HeadTitle`) or a list item (`- itemTitle`).
 *
 * The ends are put back on the first and last pasted paragraph, the DOM read
 * keeps whitespace, and blocks are placed by `placeListItems` / `placeBlocks`.
 * A paste into a code block is left to ProseMirror, which inserts the text
 * verbatim.
 *
 * Inside a table cell the text is first joined to one line (RC-81,
 * `transformPastedText` below), and a paste that reads as a block goes in as
 * the characters copied, since a cell holds none.
 */
import { parserCtx, schemaCtx } from '@milkdown/kit/core';
import {
  DOMParser,
  DOMSerializer,
  Fragment,
  type Node as ProseNode,
  type Slice,
} from '@milkdown/kit/prose/model';
import {
  Plugin,
  PluginKey,
  TextSelection,
  type Selection,
  type Transaction,
} from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';

import { flattenHtmlBlocks } from './cellHtmlFlatten';
import { isLineBreak } from './paragraphLines';

/**
 * The text a table cell can hold: one line. Null when the caret is not in a cell.
 * Only the line breaks go (with the blank lines at either end): a space or tab
 * at either end of a line that has text is content.
 */
function flattenedForCell(text: string, selection: Selection): string | null {
  if (!(selection instanceof TextSelection)) return null;
  const role = selection.$from.node(selection.$from.depth - 1).type.spec.tableRole;
  if (role !== 'cell' && role !== 'header_cell') return null;
  return text
    .replace(/^(?:[ \t]*(?:\r\n?|\n))+/, '')
    .replace(/(?:(?:\r\n?|\n)[ \t]*)+$/, '')
    .replace(/\s*(?:\r\n?|\n)+\s*/g, ' ');
}

/**
 * Pasted blocks at the caret in a line (a paragraph or a heading) of the
 * document, a quote or a list item, or null anywhere else (a cell cannot hold
 * a block).
 *
 * The pasted text runs on from the text before the caret and on into the text
 * after it, the way typing it would. A block cannot run on: the line is split
 * there, and the block takes a line of its own — the line break beside it
 * goes, so `start`, Enter, `# Title` is `start` and a heading, with no empty
 * line between. An empty paragraph is simply replaced. In a list item the
 * block lands inside the item, under the line.
 */
function placeBlocks(tr: Transaction, blocks: Fragment): Transaction | null {
  const {
    paragraph,
    list_item: listItem,
    bullet_list: bulletList,
    ordered_list: orderedList,
  } = tr.doc.type.schema.nodes;
  const { $from } = tr.selection;
  const line = $from.parent;
  if (!line.isTextblock || line.type.spec.code) return null;
  const containerDepth = $from.depth - 1;
  const container = $from.node(containerDepth);
  if (
    container.type !== tr.doc.type &&
    container.type !== tr.doc.type.schema.nodes.blockquote &&
    container.type !== listItem
  ) {
    return null;
  }

  let before = line.content.cut(0, $from.parentOffset);
  let after = line.content.cut($from.parentOffset);
  const nodes: ProseNode[] = [];
  blocks.forEach((block) => nodes.push(block));
  const first = nodes[0];
  if (first.type === paragraph) {
    // Into a heading, its first pasted line runs on as heading text.
    nodes[0] = line.copy(before.append(first.content));
  } else {
    if (isLineBreak(before.lastChild)) before = before.cut(0, before.size - 1);
    if (before.size > 0) nodes.unshift(line.copy(before));
  }
  // The last pasted block: a lone paragraph never comes here, so it is not
  // the first one that took `before` above.
  const lastIndex = nodes.length - 1;
  const last = nodes[lastIndex];
  let caretBack = 1;
  if (last.type === paragraph) {
    nodes[lastIndex] = last.copy(last.content.append(after));
    caretBack += after.size;
  } else {
    if (isLineBreak(after.firstChild)) after = after.cut(1);
    if (after.size > 0) {
      const rest = line.copy(after);
      nodes.push(rest);
      caretBack += rest.nodeSize;
    }
  }

  const at = $from.index(containerDepth);
  let content = Fragment.fromArray(nodes);
  // A list item starts with a paragraph: a block pasted at the start of its
  // first line comes after an empty one, which the item writes as nothing
  // (the block goes on the marker line). Not a list into an empty item,
  // though: nested under an empty line it reads `- - x`, and the clipboard
  // route makes its items siblings.
  if (!container.canReplace(at, at + 1, content)) {
    const list = content.firstChild?.type;
    if (line.content.size === 0 && (list === bulletList || list === orderedList)) return null;
    content = content.addToStart(paragraph.create());
  }
  if (!container.canReplace(at, at + 1, content)) return null;
  const from = $from.before();
  tr.replaceWith(from, $from.after(), content);
  const end = from + content.size - caretBack;
  return tr.setSelection(TextSelection.near(tr.doc.resolve(end), -1));
}

/**
 * A paste of nothing but lists, at the caret in a list item's line: its items
 * join the list beside the caret's item, as pressing Enter and typing them
 * would. The item is split at the caret, the text before it keeps the item and
 * the text after it goes on in a new item after the pasted ones; with no text
 * after the caret, whatever the item held under the line (a nested list) goes
 * with the last pasted item. Null for any other paste or place.
 */
function placeListItems(tr: Transaction, blocks: Fragment): Transaction | null {
  const {
    paragraph,
    list_item: listItem,
    bullet_list: bulletList,
    ordered_list: orderedList,
  } = tr.doc.type.schema.nodes;
  const { $from } = tr.selection;
  const line = $from.parent;
  if (line.type !== paragraph) return null;
  const itemDepth = $from.depth - 1;
  const item = $from.node(itemDepth);
  if (item.type !== listItem) return null;
  const list = $from.node(itemDepth - 1);
  const pasted: ProseNode[] = [];
  let onlyLists = true;
  blocks.forEach((block) => {
    if (block.type !== bulletList && block.type !== orderedList) onlyLists = false;
    else block.forEach((child) => pasted.push(child));
  });
  if (!onlyLists || pasted.length === 0 || pasted.some((child) => child.type !== listItem)) {
    return null;
  }
  // An item takes the kind of the list it joins: the preset's list-order sync
  // turns a bullet list ordered when an item in it says it is ordered.
  const ordered = list.type === orderedList;
  const items = pasted.map((child) =>
    child.type.create(
      {
        ...child.attrs,
        listType: ordered ? 'ordered' : 'bullet',
        ...(ordered ? {} : { label: item.attrs.label }),
      },
      child.content,
      child.marks,
    ),
  );

  const lineIndex = $from.index(itemDepth);
  let before = line.content.cut(0, $from.parentOffset);
  let after = line.content.cut($from.parentOffset);
  if (isLineBreak(before.lastChild)) before = before.cut(0, before.size - 1);
  if (isLineBreak(after.firstChild)) after = after.cut(1);
  const above: ProseNode[] = [];
  const below: ProseNode[] = [];
  item.forEach((child, _offset, index) => {
    if (index < lineIndex) above.push(child);
    else if (index > lineIndex) below.push(child);
  });

  const out: ProseNode[] = [];
  if (before.size > 0) above.push(line.copy(before));
  if (above.length > 0) out.push(item.copy(Fragment.fromArray(above)));
  const lastPasted = items[items.length - 1];
  // The caret goes at the end of what was pasted, before anything handed on.
  let caret = $from.before(itemDepth);
  for (const node of out) caret += node.nodeSize;
  for (const node of items.slice(0, -1)) caret += node.nodeSize;
  caret += 1 + lastPasted.content.size;
  if (after.size > 0) {
    below.unshift(line.copy(after));
    items.push(item.copy(Fragment.fromArray(below)));
  } else if (below.length > 0) {
    items[items.length - 1] = lastPasted.copy(lastPasted.content.append(Fragment.fromArray(below)));
  }
  out.push(...items);

  const at = $from.index(itemDepth - 1);
  const content = Fragment.fromArray(out);
  if (!list.canReplace(at, at + 1, content)) return null;
  tr.replaceWith($from.before(itemDepth), $from.after(itemDepth), content);
  return tr.setSelection(TextSelection.near(tr.doc.resolve(caret), -1));
}

export const plainTextPaste = $prose((ctx) => {
  const schema = ctx.get(schemaCtx);
  const { paragraph } = schema.nodes;

  /** `text` read as markdown, with the spaces and tabs the parse trims off its ends put back. */
  function parsePasted(text: string): Slice | null {
    const parsed = ctx.get(parserCtx)(text);
    if (!parsed || typeof parsed === 'string' || parsed.childCount === 0) return null;
    const blocks: ProseNode[] = [];
    parsed.forEach((block) => blocks.push(block));
    // Only on a line that has text: spaces on a blank line are no one's edge.
    const lead = /^([ \t]+)\S/.exec(text)?.[1];
    // A copied line may carry its line ending; the space before it is still the line's.
    const trail = /\S([ \t]+)(?:\r\n?|\n)?$/.exec(text)?.[1];
    const first = blocks[0];
    if (lead && first.type === paragraph) {
      blocks[0] = first.copy(Fragment.from(schema.text(lead)).append(first.content));
    }
    const last = blocks[blocks.length - 1];
    if (trail && last.type === paragraph) {
      blocks[blocks.length - 1] = last.copy(last.content.append(Fragment.from(schema.text(trail))));
    }
    // Through the DOM, as the clipboard plugin did (the schema's own parse rules
    // normalize what the paste may hold), but keeping the whitespace.
    return DOMParser.fromSchema(schema).parseSlice(
      DOMSerializer.fromSchema(schema).serializeFragment(Fragment.fromArray(blocks)),
      { preserveWhitespace: true },
    );
  }

  function paste(view: EditorView, event: ClipboardEvent): boolean {
    const data = event.clipboardData;
    if (!view.editable || !data) return false;
    if (data.getData('text/html').length > 0 || data.getData('vscode-editor-data')) return false;
    let text = data.getData('text/plain');
    if (!text) return false;
    const { selection } = view.state;
    if (selection.$from.parent.type.spec.code) return false;

    // A table cell takes one line (RC-81, `transformPastedText` below). Joined
    // lines are taken as they are: read as markdown, `- a - b` is a list.
    const oneLine = flattenedForCell(text, selection);
    if (oneLine !== null && oneLine !== text) {
      view.dispatch(view.state.tr.insertText(oneLine).scrollIntoView());
      return true;
    }
    if (oneLine !== null) text = oneLine;

    if (!/\S/.test(text)) {
      if (/[\r\n]/.test(text)) return false;
      view.dispatch(view.state.tr.insertText(text).scrollIntoView());
      return true;
    }
    const slice = parsePasted(text);
    const blocks = slice?.content;
    if (!slice || !blocks || blocks.childCount === 0) return false;
    const only = blocks.childCount === 1 ? blocks.firstChild : null;

    // Nor can a cell hold a block: one the line reads as (` # h`, ` - a`) goes
    // in as the characters copied, not as its text with the markup gone.
    if (oneLine !== null && only?.type !== paragraph) {
      view.dispatch(view.state.tr.insertText(text).scrollIntoView());
      return true;
    }

    // A replace the schema cannot fit throws; the paste is then ProseMirror's
    // own, as it was under the clipboard plugin, rather than lost.
    try {
      const tr = view.state.tr;
      if (!tr.selection.empty) tr.deleteSelection();
      const placed =
        only?.type === paragraph ? null : (placeListItems(tr, blocks) ?? placeBlocks(tr, blocks));
      if (!placed) {
        // Inline text, or blocks somewhere neither placement decides: what the
        // clipboard plugin did, into the open ends of the caret's block.
        const lone = only?.type === paragraph && only.childCount === 1 ? only.firstChild : null;
        if (lone?.isText && lone.marks.length === 0) tr.replaceSelectionWith(lone, true);
        else tr.replaceSelection(slice);
      }
      view.dispatch(tr.scrollIntoView().setMeta('uiEvent', 'paste'));
    } catch {
      return false;
    }
    return true;
  }

  return new Plugin({
    key: new PluginKey('FUTO_PLAIN_TEXT_PASTE'),
    props: {
      handlePaste: (view, event) => paste(view, event),
      /* A table cell holds ONE line of inline content (a GFM cell cannot hold a
       * block), and ProseMirror parses plain text into one paragraph per line.
       * More than one paragraph cannot sit in a cell, so the parser wraps each
       * in a NEW CELL and prosemirror-tables pastes that run of cells over the
       * cells that follow the caret: `| | y |` + paste `p<newline><newline>q`
       * (or just `x<newline>`, whose trailing newline is a second, empty
       * paragraph) saved `| p | q |` and lost `y` (RC-81). Joining the lines
       * with a space before it is parsed keeps every word and touches no
       * neighbor. */
      transformPastedText: (text, _plain, view) =>
        flattenedForCell(text, view.state.selection) ?? text,
      /* The HTML twin of the above (RC-83): several pasted `<p>`/`<li>`/`<h1>`
       * blocks become cells the same way, so they are flattened to one inline
       * run first (cellHtmlFlatten.ts). Only for a caret in a cell: a
       * CellSelection pastes into the cells picked, and a pasted `<table>` is
       * left alone. */
      transformPastedHTML: (html, view) =>
        flattenedForCell('', view.state.selection) === null
          ? html
          : (flattenHtmlBlocks(html) ?? html),
    },
  });
});
