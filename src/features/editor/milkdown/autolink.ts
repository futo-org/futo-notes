/*
 * A typed URL becomes a link the moment its word ends — Space, Enter, or a
 * hard break. → docs/spec/editor.md "Typing a bare URL links it"
 *
 * GFM's autolink literals are recognised when a note is PARSED, so a URL
 * already in the file rendered as a link while one just typed stayed plain
 * text until the note was closed and reopened. This closes that gap without a
 * second definition of "URL": the word that just ended is handed to the
 * editor's OWN remark processor, exactly as the next open would read it, and
 * whatever link that parse finds — its extent, with GFM's trailing-punctuation
 * trim, and its href, `http://` added for `www.` — is the link applied. So
 * "a link now" and "a link after reopening" cannot disagree, and the file keeps
 * the bare URL the user typed (packages/editor/src/milkdown-compat/bareUrl.ts).
 *
 * An `appendTransaction` rather than a Space input rule and an Enter keymap:
 * it sees the result of the edit however it arrived — a key, a phone keyboard's
 * composition, a paste ending in whitespace — so every one of those paths ends
 * the word the same way.
 */
import { remarkCtx } from '@milkdown/kit/core';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import {
  Plugin,
  PluginKey,
  Selection,
  type EditorState,
  type Transaction,
} from '@milkdown/kit/prose/state';
import { $prose } from '@milkdown/kit/utils';

import type { ParsedNode, ParseMarkdown } from '@futo-notes/editor';

export const autolinkKey = new PluginKey('FUTO_AUTOLINK');

/** Cheap pre-filter: only a word that could be a literal is worth a parse. */
const URL_HINT = /https?:\/\/|www\./i;

/** One character per inline leaf, so string offsets stay document offsets;
 * a hard break reads as the line break it is. */
const leafText = (node: ProseNode): string => (node.type.name === 'hardbreak' ? '\n' : '￼');

/**
 * Where the word that this edit ended stops, or null if it ended none: the
 * caret sits just past whitespace (a space, a hard break), or at the start of
 * a line that Enter has just split off.
 */
function endedWordAt(state: EditorState, previous: EditorState): number | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const $caret = selection.$from;
  if (!$caret.parent.isTextblock) return null;
  if ($caret.parentOffset > 0) {
    const last = $caret.parent.textBetween(
      $caret.parentOffset - 1,
      $caret.parentOffset,
      undefined,
      leafText,
    );
    return /\s/.test(last) ? $caret.pos - 1 : null;
  }
  const was = previous.selection;
  if (!was.empty || was.$from.parentOffset === 0) return null;
  const lineEnd = Selection.near(state.doc.resolve($caret.before()), -1);
  return lineEnd.empty && lineEnd.from < $caret.pos ? lineEnd.from : null;
}

/** The first link in a parsed tree, with its source offsets. */
function firstLink(node: ParsedNode): { url: string; start: number; end: number } | null {
  if (node.type === 'link') {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    return node.url && start !== undefined && end !== undefined
      ? { url: node.url, start, end }
      : null;
  }
  for (const child of node.children ?? []) {
    const found = firstLink(child);
    if (found) return found;
  }
  return null;
}

/** The transaction linking the URL word that ends at `end`, if it is one. */
export function autolinkTransaction(
  state: EditorState,
  end: number,
  parse: ParseMarkdown,
): Transaction | null {
  const { link, inlineCode } = state.schema.marks;
  if (!link) return null;
  const $end = state.doc.resolve(end);
  const block = $end.parent;
  if (!block.isTextblock || block.type.spec.code) return null;
  const word = /\S+$/.exec(block.textBetween(0, $end.parentOffset, undefined, leafText))?.[0];
  if (!word || word.includes('￼') || !URL_HINT.test(word)) return null;
  const from = end - word.length;
  if (state.doc.rangeHasMark(from, end, link)) return null;
  if (inlineCode && state.doc.rangeHasMark(from, end, inlineCode)) return null;
  const found = firstLink(parse(word));
  if (!found) return null;
  return state.tr.addMark(from + found.start, from + found.end, link.create({ href: found.url }));
}

export const autolink = $prose(
  (ctx) =>
    new Plugin({
      key: autolinkKey,
      appendTransaction(transactions, previous, state) {
        if (!transactions.some((tr) => tr.docChanged)) return null;
        const end = endedWordAt(state, previous);
        if (end === null) return null;
        return autolinkTransaction(state, end, (markdown) => ctx.get(remarkCtx).parse(markdown));
      },
    }),
);
