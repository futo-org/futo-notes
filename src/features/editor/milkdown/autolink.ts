/*
 * A typed URL becomes a link the moment its word ends — Space, Enter, or a
 * hard break. → docs/spec/editor/external-links.md "Typing a bare URL links it"
 *
 * GFM's autolink literals are recognized when a note is PARSED, so a URL
 * already in the file rendered as a link while one just typed stayed plain
 * text until the note was closed and reopened. This closes that gap without a
 * second definition of "URL": the word that just ended is SAVED and REOPENED —
 * written by the editor's own serializer and read back by its own parser,
 * exactly what the next save and open do to it — and whatever link that
 * reopen holds — its extent, with GFM's trailing-punctuation trim, and its
 * href, `http://` added for `www.` — is the link applied. So "a link now" and
 * "a link after reopening" cannot disagree, and the file keeps the bare URL
 * the user typed (docs/spec/editor.md "Markdown house style").
 *
 * The save is part of the question, not a detail: typed link syntax —
 * `[t](https://x.test)`, `<https://x.test>` — is text, which the save escapes
 * (`\[t](https://x.test)`), and the reopen reads the bare URL inside it as a
 * GFM literal. Parsing the raw word instead read an inline link and linked the
 * whole source as its own text, and skipping such words left a link that only
 * appeared on the next open.
 *
 * An `appendTransaction` rather than a Space input rule and an Enter keymap:
 * it sees the result of the edit however it arrived — a key, a phone keyboard's
 * composition, a paste ending in whitespace — so every one of those paths ends
 * the word the same way.
 */
import { parserCtx, serializerCtx } from '@milkdown/kit/core';
import type { Mark, MarkType, Node as ProseNode } from '@milkdown/kit/prose/model';
import {
  Plugin,
  PluginKey,
  Selection,
  type EditorState,
  type Transaction,
} from '@milkdown/kit/prose/state';
import { $prose } from '@milkdown/kit/utils';

import { isLineBreak } from './paragraphLines';

export const autolinkKey = new PluginKey('FUTO_AUTOLINK');

/** Cheap pre-filter: only a word that could be a literal is worth a parse. */
const URL_HINT = /https?:\/\/|www\./i;

/** One character per inline leaf, so string offsets stay document offsets;
 * a hard break reads as the line break it is. */
const leafText = (node: ProseNode): string => (isLineBreak(node) ? '\n' : '\ufffc');

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

/** A document through a save and an open: the editor's serializer, then its parser. */
type Reopen = (doc: ProseNode) => ProseNode;

/**
 * The first link in `paragraph`, as offsets into its text — when its text is
 * exactly `word`. A reopen that changed the word's text (a serializer that
 * could not write it back) is no answer about where its link goes.
 */
function firstLinkIn(
  paragraph: ProseNode,
  word: string,
  link: MarkType,
): { mark: Mark; start: number; end: number } | null {
  if (!paragraph.isTextblock) return null;
  if (paragraph.textBetween(0, paragraph.content.size, undefined, leafText) !== word) return null;
  let start = -1;
  let offset = 0;
  let mark: Mark | undefined;
  for (let index = 0; index < paragraph.childCount; index += 1) {
    const child = paragraph.child(index);
    const here = link.isInSet(child.marks);
    if (mark) {
      if (!here?.eq(mark)) break;
    } else if (here) {
      mark = here;
      start = offset;
    }
    offset += child.nodeSize;
  }
  return mark ? { mark, start, end: offset } : null;
}

/** The transaction linking the URL word that ends at `end`, if it is one. */
export function autolinkTransaction(
  state: EditorState,
  end: number,
  reopen: Reopen,
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
  const wordStart = $end.parentOffset - word.length;
  const alone = state.schema.topNodeType.create(
    null,
    block.type.create(block.attrs, block.content.cut(wordStart, $end.parentOffset)),
  );
  const reopened = reopen(alone);
  const paragraph = reopened.childCount === 1 ? reopened.firstChild : null;
  const found = paragraph ? firstLinkIn(paragraph, word, link) : null;
  if (!found) return null;
  return state.tr.addMark(from + found.start, from + found.end, found.mark);
}

export const autolink = $prose(
  (ctx) =>
    new Plugin({
      key: autolinkKey,
      appendTransaction(transactions, previous, state) {
        if (!transactions.some((tr) => tr.docChanged)) return null;
        const end = endedWordAt(state, previous);
        if (end === null) return null;
        return autolinkTransaction(state, end, (doc) =>
          ctx.get(parserCtx)(ctx.get(serializerCtx)(doc)),
        );
      },
    }),
);
