/*
 * Two plain-text paste repairs, one file because both are about where the
 * clipboard route puts multi-line text. `transformPastedText` at the bottom is
 * the table-cell one (RC-81).
 *
 * Pasting a BLOCK as plain text into an EMPTY paragraph replaces that paragraph
 * (RC-59's leftover: an empty note saved with a leading blank line, and an empty
 * line stayed above the paste wherever the caret was on an empty line).
 *
 * `@milkdown/plugin-clipboard`'s plain-text route parses the text to a document,
 * round-trips it through the DOM and hands the slice to `replaceSelection`. A
 * slice that starts with a block (a table, a heading, a list, a fence) does not
 * fit INSIDE the paragraph the caret is in, so it lands after it and the empty
 * paragraph stays above. That is the wrong reading of what the user did: the
 * caret sat on an empty line and they pasted a block, so the block takes the
 * line.
 *
 * Deliberately narrow, and everything else stays with the clipboard plugin
 * (registered after this one): only a `text/plain`-only paste (a `text/html`
 * paste has its own DOM path), only a collapsed caret in a paragraph with no
 * content, only when the pasted text is not just one paragraph (that pastes
 * inline, into the paragraph, and always did), and only when that paragraph is
 * a direct child of the document or a quote. Not a list item's first paragraph
 * (the fitter keeps the item's empty filler there and nests the pasted blocks
 * under it: `- - x`, where the clipboard route appends a pasted list as
 * siblings) and not a table cell (a lone `# x` fits the cell's content model
 * and split the table around the heading). `canReplace` is asked outright
 * rather than waiting for the fitter to throw, because in both of those places
 * it does not throw.
 */
import { parserCtx, schemaCtx } from '@milkdown/kit/core';
import { DOMParser, DOMSerializer } from '@milkdown/kit/prose/model';
import { Plugin, PluginKey, TextSelection, type Selection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';

import { flattenHtmlBlocks } from './cellHtmlFlatten';

/** The text a table cell can hold: one line. Null when the caret is not in a cell. */
function flattenedForCell(text: string, selection: Selection): string | null {
  if (!(selection instanceof TextSelection)) return null;
  const role = selection.$from.node(selection.$from.depth - 1).type.spec.tableRole;
  if (role !== 'cell' && role !== 'header_cell') return null;
  return text.replace(/^\s+|\s+$/g, '').replace(/\s*(?:\r\n?|\n)+\s*/g, ' ');
}

export const plainTextBlockPaste = $prose((ctx) => {
  const schema = ctx.get(schemaCtx);

  function paste(view: EditorView, event: ClipboardEvent): boolean {
    const data = event.clipboardData;
    if (!view.editable || !data) return false;
    if (data.getData('text/html').length > 0 || data.getData('vscode-editor-data')) return false;
    const text = data.getData('text/plain');
    if (!text) return false;

    const { selection } = view.state;
    // A table cell takes one line (RC-81, `transformPastedText` below): claim
    // the paste, because the clipboard plugin would re-read the raw text.
    const oneLine = flattenedForCell(text, selection);
    if (oneLine !== null) {
      if (oneLine === text) return false;
      view.dispatch(view.state.tr.insertText(oneLine).scrollIntoView());
      return true;
    }

    if (!(selection instanceof TextSelection) || !selection.empty) return false;
    const { $from } = selection;
    const line = $from.parent;
    if (line.type !== schema.nodes.paragraph || line.content.size !== 0) return false;

    const parsed = ctx.get(parserCtx)(text);
    if (!parsed || typeof parsed === 'string') return false;
    const only = parsed.childCount === 1 ? parsed.firstChild : null;
    if (parsed.childCount === 0 || only?.type === schema.nodes.paragraph) return false;

    const containerDepth = $from.depth - 1;
    const container = $from.node(containerDepth);
    if (container.type !== schema.nodes.doc && container.type !== schema.nodes.blockquote) {
      return false;
    }

    const slice = DOMParser.fromSchema(schema).parseSlice(
      DOMSerializer.fromSchema(schema).serializeFragment(parsed.content),
    );
    const at = $from.index(containerDepth);
    if (!container.canReplace(at, at + 1, slice.content)) return false;
    try {
      const from = $from.before();
      const tr = view.state.tr.replaceWith(from, $from.after(), slice.content);
      tr.setSelection(TextSelection.near(tr.doc.resolve(tr.mapping.map($from.after())), -1));
      view.dispatch(tr.scrollIntoView());
      return true;
    } catch {
      // The container will not take this content here (a table cell, say): the
      // clipboard plugin's own route decides what happens instead.
      return false;
    }
  }

  return new Plugin({
    key: new PluginKey('FUTO_PLAIN_TEXT_BLOCK_PASTE'),
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
       * neighbour. */
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
