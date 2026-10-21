/*
 * A typed URL becomes a link the moment its word ends — Space, Enter, or a
 * hard break. → docs/spec/editor/external-links.md "Typing a bare URL links it"
 *
 * GFM's autolink literals are recognized when a note is PARSED, so a URL
 * already in the file rendered as a link while one just typed stayed plain
 * text until the note was closed and reopened. This closes that gap without a
 * second definition of "URL": the word that just ended is handed to the
 * editor's OWN remark processor, as a file holding it would be read, and the
 * autolink literal that parse finds — its extent, with GFM's
 * trailing-punctuation trim, and its href, `http://` added for `www.` — is the
 * link applied. The save then writes that link bare wherever bare reads back as
 * the same link (docs/spec/editor.md "Markdown house style"), so the file keeps
 * the URL the user typed.
 *
 * Typed link syntax — `[t](https://x.test)`, `<https://x.test>` — parses as a
 * link too, but it is not converted: its text is not a URL, and taking its
 * whole source as the link's text saved a link quoting itself. It stays the
 * text it was typed as; the URL spelled inside it is read again as a word of
 * its own, and the literal found there is the link.
 *
 * Then the check that makes "a link now" and "a link after reopening" agree:
 * the word, with that link on it, is put through the editor's serializer and
 * parser — the next save and open — and must come back with the same text and
 * the same link. When it would not, nothing is linked.
 *
 * Judging the word by its PLAIN save instead (no link yet) does not work: the
 * save escapes `_ ~ * [ ]` in plain text, and GFM reads that backslash into the
 * literal, so a URL like `…/Rust_(programming_language)` linked nothing as it
 * was typed and reopened with a backslash in its href.
 *
 * An `appendTransaction` rather than a Space input rule and an Enter keymap:
 * it sees the result of the edit however it arrived — a key, a phone keyboard's
 * composition, a paste ending in whitespace — so every one of those paths ends
 * the word the same way.
 */
import { parserCtx, remarkCtx, serializerCtx } from '@milkdown/kit/core';
import type { MarkType, Node as ProseNode } from '@milkdown/kit/prose/model';
import {
  Plugin,
  PluginKey,
  Selection,
  type EditorState,
  type Transaction,
} from '@milkdown/kit/prose/state';
import { $prose } from '@milkdown/kit/utils';

import type { MdastNode } from '@futo-notes/editor/milkdown-compat';

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

/** Markdown in, mdast out — the editor's own remark processor's `parse`. */
type ParseToMdast = (markdown: string) => MdastNode;

/** A document through a save and an open: the editor's serializer, then its parser. */
type Reopen = (doc: ProseNode) => ProseNode;

/** A link as offsets into the word, and its href. */
interface WordLink {
  href: string;
  start: number;
  end: number;
}

/** The text an mdast node shows. */
function shownText(node: MdastNode): string {
  if (typeof node.value === 'string') return node.value;
  return (node.children ?? []).map(shownText).join('');
}

/** The first link node in a parsed tree, of any kind. */
function firstLink(node: MdastNode): MdastNode | null {
  if (node.type === 'link') return node;
  for (const child of node.children ?? []) {
    const found = firstLink(child);
    if (found) return found;
  }
  return null;
}

/**
 * The links `word` gets: the first autolink literal its parse holds. Link
 * syntax is left as text, and the URL spelled inside it — the destination of
 * `<u>` and `[t](u)`, and `t` too — is read as a word of its own (once: what
 * is inside is not link syntax again).
 */
function linksInWord(word: string, parse: ParseToMdast, inside = false): WordLink[] {
  const node = firstLink(parse(word));
  if (!node?.url) return [];
  const shown = shownText(node);
  // A literal found by remark-gfm's text transform (after a `[`, say) carries
  // no position; its source is its text, so it stands where that text first does.
  const start = node.position?.start.offset ?? word.indexOf(shown);
  const end = node.position?.end.offset ?? start + shown.length;
  if (start < 0) return [];
  const source = word.slice(start, end);
  if (source === shown) return [{ href: node.url, start, end }];
  if (inside) return [];
  const within = (text: string, at: number): WordLink[] =>
    at < 0
      ? []
      : linksInWord(text, parse, true).map((link) => ({
          href: link.href,
          start: start + at + link.start,
          end: start + at + link.end,
        }));
  const label = source.startsWith(`[${shown}]`) ? within(shown, 1) : [];
  return [...label, ...within(node.url, source.lastIndexOf(node.url))];
}

/** The links in a textblock, as offsets into its text. */
function linksIn(block: ProseNode, link: MarkType): WordLink[] {
  const found: WordLink[] = [];
  block.forEach((child, offset) => {
    const mark = link.isInSet(child.marks);
    if (!mark) return;
    const href = String(mark.attrs.href);
    const last = found[found.length - 1];
    if (last && last.end === offset && last.href === href) last.end = offset + child.nodeSize;
    else found.push({ href, start: offset, end: offset + child.nodeSize });
  });
  return found;
}

/** The transaction linking the URL word that ends at `end`, if it is one. */
export function autolinkTransaction(
  state: EditorState,
  end: number,
  parse: ParseToMdast,
  reopen: Reopen,
): Transaction | null {
  const { link, inlineCode } = state.schema.marks;
  if (!link) return null;
  const $end = state.doc.resolve(end);
  const block = $end.parent;
  if (!block.isTextblock || block.type.spec.code) return null;
  const word = /\S+$/.exec(block.textBetween(0, $end.parentOffset, undefined, leafText))?.[0];
  if (!word || word.includes('\ufffc') || !URL_HINT.test(word)) return null;
  const from = end - word.length;
  if (state.doc.rangeHasMark(from, end, link)) return null;
  if (inlineCode && state.doc.rangeHasMark(from, end, inlineCode)) return null;
  const found = linksInWord(word, parse);
  if (found.length === 0) return null;
  const wordStart = $end.parentOffset - word.length;
  const tr = state.tr;
  for (const { href, start, end: stop } of found) {
    tr.addMark(from + start, from + stop, link.create({ href }));
  }
  const alone = tr.doc.resolve(end).parent.cut(wordStart, $end.parentOffset);
  const reopened = reopen(state.schema.topNodeType.create(null, alone));
  const paragraph = reopened.childCount === 1 ? reopened.firstChild : null;
  if (
    !paragraph?.isTextblock ||
    paragraph.textBetween(0, paragraph.content.size, undefined, leafText) !== word ||
    JSON.stringify(linksIn(paragraph, link)) !== JSON.stringify(linksIn(alone, link))
  ) {
    return null;
  }
  return tr;
}

export const autolink = $prose(
  (ctx) =>
    new Plugin({
      key: autolinkKey,
      appendTransaction(transactions, previous, state) {
        if (!transactions.some((tr) => tr.docChanged)) return null;
        const end = endedWordAt(state, previous);
        if (end === null) return null;
        return autolinkTransaction(
          state,
          end,
          (markdown) => ctx.get(remarkCtx).parse(markdown),
          (doc) => ctx.get(parserCtx)(ctx.get(serializerCtx)(doc)),
        );
      },
    }),
);
