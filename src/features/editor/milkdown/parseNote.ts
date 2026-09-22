/*
 * The one place the editor parses a note's markdown into a document.
 *
 * Every load — a whole note, the first chunk of a progressive open, each
 * streamed chunk — comes through here, so "what happens when a note cannot be
 * parsed" is one code path with one test seam: MilkdownEditor.test.ts injects
 * the throw here, at the call the component makes, rather than relying on a
 * particular piece of markdown staying unparseable across parser fixes.
 */
import { parserCtx, type Editor } from '@milkdown/kit/core';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';

/**
 * Parses `markdown` with the editor's own remark pipeline — the same parser
 * Milkdown's `replaceAll` uses. Throws when remark/micromark cannot read the
 * note (a real class of failure: a table cell that opened a wikilink token it
 * could not close was one), and answers null when the parser produced nothing.
 */
export function parseNote(editor: Editor, markdown: string): ProseNode | null {
  return editor.ctx.get(parserCtx)(markdown) ?? null;
}
