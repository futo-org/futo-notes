/*
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
 * content, and only when the pasted text is not just one paragraph (that pastes
 * inline, into the paragraph, and always did).
 */
import { parserCtx, schemaCtx } from '@milkdown/kit/core';
import { DOMParser, DOMSerializer } from '@milkdown/kit/prose/model';
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';

export const plainTextBlockPaste = $prose((ctx) => {
  const schema = ctx.get(schemaCtx);

  function paste(view: EditorView, event: ClipboardEvent): boolean {
    const data = event.clipboardData;
    if (!view.editable || !data) return false;
    if (data.getData('text/html').length > 0 || data.getData('vscode-editor-data')) return false;
    const text = data.getData('text/plain');
    if (!text) return false;

    const { selection } = view.state;
    if (!(selection instanceof TextSelection) || !selection.empty) return false;
    const { $from } = selection;
    const line = $from.parent;
    if (line.type !== schema.nodes.paragraph || line.content.size !== 0) return false;

    const parsed = ctx.get(parserCtx)(text);
    if (!parsed || typeof parsed === 'string') return false;
    const only = parsed.childCount === 1 ? parsed.firstChild : null;
    if (parsed.childCount === 0 || only?.type === schema.nodes.paragraph) return false;

    const slice = DOMParser.fromSchema(schema).parseSlice(
      DOMSerializer.fromSchema(schema).serializeFragment(parsed.content),
    );
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
    props: { handlePaste: (view, event) => paste(view, event) },
  });
});
