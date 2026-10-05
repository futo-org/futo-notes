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
 * character BEFORE each mark, and every emphasis in the note is re-spelled
 * with it (`x**y**z` became `xxxyxxz`). So every leading BOM is removed HERE,
 * before the parser sees the string (a doubled BOM, from a concatenated file,
 * strips one in micromark and would put the offsets off again). The first edit
 * therefore writes the note without them (RC-38); the load echo is unaffected,
 * because the host's bytes are kept by the caller and never round-trip through
 * this function.
 *
 * EVERY route from a string to a document must go through this: `parseNote`
 * for loads, and `stripLeadingBoms` for the two Milkdown actions that parse for
 * themselves (`replaceAll` in `applyEdit`, `insert`) and the initial value.
 * `planMarkdownChunks` never starts a chunk at a U+FEFF in the MIDDLE of a
 * note (it stops), so no later chunk can lose one here.
 */
export function stripLeadingBoms(markdown: string): string {
  let start = 0;
  while (markdown.charCodeAt(start) === 0xfeff) start += 1;
  return start === 0 ? markdown : markdown.slice(start);
}

/**
 * Parses `markdown` with the editor's own remark pipeline — the same parser
 * Milkdown's `replaceAll` uses. Throws when remark/micromark cannot read the
 * note (a real class of failure: a table cell that opened a wikilink token it
 * could not close was one), and answers null when the parser produced nothing.
 */
export function parseNote(editor: Editor, markdown: string): ProseNode | null {
  return editor.ctx.get(parserCtx)(stripLeadingBoms(markdown)) ?? null;
}
