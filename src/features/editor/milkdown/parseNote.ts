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
 * micromark drops a leading U+FEFF before tokenizing, so every node position
 * is one code unit short of `file.value` — and Milkdown's `remarkMarker`
 * reads `file.value.charAt(node.position.start.offset)` to learn whether a
 * mark was `*` or `_`. With the BOM still on the string that reads the
 * character BEFORE the mark, and every emphasis in the note is re-spelled with
 * it (`x**y**z` became `xxxyxxz`). So the BOM is removed HERE, once, before
 * the parser sees the string. The first edit therefore writes the note
 * without it, which is what the editor did to a BOM note before (RC-38).
 *
 * Only ever one: `planMarkdownChunks` never starts a chunk at a U+FEFF in the
 * MIDDLE of a note (it declines), so no later chunk can lose one here.
 */
function withoutLeadingBom(markdown: string): string {
  return markdown.charCodeAt(0) === 0xfeff ? markdown.slice(1) : markdown;
}

/**
 * Parses `markdown` with the editor's own remark pipeline — the same parser
 * Milkdown's `replaceAll` uses. Throws when remark/micromark cannot read the
 * note (a real class of failure: a table cell that opened a wikilink token it
 * could not close was one), and answers null when the parser produced nothing.
 */
export function parseNote(editor: Editor, markdown: string): ProseNode | null {
  return editor.ctx.get(parserCtx)(withoutLeadingBom(markdown)) ?? null;
}
