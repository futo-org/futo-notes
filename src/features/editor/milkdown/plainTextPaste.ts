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
 * - every run of spaces or tabs inside it became one space.
 *
 * The ends are put back on the first and last pasted paragraph and the DOM read
 * keeps whitespace. A block pasted onto an empty line takes the line
 * (`replaceEmptyLine`). A paste into a code block is left to ProseMirror, which
 * inserts the text verbatim.
 *
 * Inside a table cell the text is first joined to one line (RC-81,
 * `transformPastedText` below).
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

/**
 * The text a table cell can hold: one line. Null when the caret is not in a cell.
 * Only the line breaks go: a space or tab at either end is content.
 */
function flattenedForCell(text: string, selection: Selection): string | null {
  if (!(selection instanceof TextSelection)) return null;
  const role = selection.$from.node(selection.$from.depth - 1).type.spec.tableRole;
  if (role !== 'cell' && role !== 'header_cell') return null;
  return text
    .replace(/^\s*[\r\n]\s*/, '')
    .replace(/\s*[\r\n]\s*$/, '')
    .replace(/\s*(?:\r\n?|\n)+\s*/g, ' ');
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
    const trail = /\S([ \t]+)$/.exec(text)?.[1];
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

  /**
   * Pasted blocks in place of an empty paragraph of the document or a quote, or
   * null anywhere else (RC-59). The clipboard route left the empty paragraph
   * above a slice that starts with a block. Not a list item's first paragraph
   * (the fitter nests the blocks under the item's filler: `- - x`) and not a
   * table cell (a lone `# x` fits the cell's content model and split the table).
   */
  function replaceEmptyLine(tr: Transaction, blocks: Fragment): Transaction | null {
    const { $from } = tr.selection;
    const line = $from.parent;
    if (line.type !== paragraph || line.content.size !== 0) return null;
    const containerDepth = $from.depth - 1;
    const container = $from.node(containerDepth);
    if (container.type !== schema.nodes.doc && container.type !== schema.nodes.blockquote) {
      return null;
    }
    const at = $from.index(containerDepth);
    if (!container.canReplace(at, at + 1, blocks)) return null;
    const from = $from.before();
    tr.replaceWith(from, $from.after(), blocks);
    return tr.setSelection(TextSelection.near(tr.doc.resolve(from + blocks.size), -1));
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

    const tr = view.state.tr;
    if (!tr.selection.empty) tr.deleteSelection();
    const only = blocks.childCount === 1 ? blocks.firstChild : null;
    const placed = only?.type === paragraph ? null : replaceEmptyLine(tr, blocks);
    if (!placed) {
      // Inline text, or blocks anywhere but an empty line: what the
      // clipboard plugin did, into the open ends of the caret's block.
      const lone = only?.type === paragraph && only.childCount === 1 ? only.firstChild : null;
      if (lone?.isText && lone.marks.length === 0) tr.replaceSelectionWith(lone, true);
      else tr.replaceSelection(slice);
    }
    view.dispatch(tr.scrollIntoView().setMeta('uiEvent', 'paste'));
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
