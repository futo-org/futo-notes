/*
 * Input-rule repairs for the pinned Milkdown presets. Keep candidates bounded
 * by ProseMirror's 500-character input window; parsing each match is too slow
 * for the typing path. The unpatched-preset canaries live in
 * tests/editor-embed-milkdown-compat.spec.ts.
 */
import {
  codeBlockSchema,
  emphasisSchema,
  headingSchema,
  inlineCodeSchema,
  strongSchema,
} from '@milkdown/kit/preset/commonmark';
import { strikethroughSchema } from '@milkdown/kit/preset/gfm';
import type { Attrs, Mark, MarkType } from '@milkdown/kit/prose/model';
import { InputRule, textblockTypeInputRule } from '@milkdown/kit/prose/inputrules';
import type { EditorState, Transaction } from '@milkdown/kit/prose/state';
import { $inputRule } from '@milkdown/kit/utils';

/** Retain the leading character and accept only even backslash runs before an opener.
 * Matching context instead of lookbehind supports the legacy WebView floor. */
function lead(allowed: string, never = ''): string {
  return String.raw`(?<lead>(?:^|[${allowed}]|[^\\${never}](?=\\))(?:\\\\)*)`;
}

/** Text that neither starts nor ends with whitespace (or `edge`, the delimiter's own characters). */
function flanked(edge: string, inner: string): string {
  return String.raw`(?<text>[^\s${edge}](?:${inner}*?[^\s${edge}])?)`;
}

const EMPHASIS_STAR = new RegExp(
  lead(String.raw`^*\\`) +
    String.raw`(?<open>\*)` +
    flanked(String.raw`*`, '[^*]') +
    String.raw`\*$`,
);
const EMPHASIS_UNDERSCORE = new RegExp(
  lead(String.raw`^\w\\`) + '(?<open>_)' + flanked('_', '.') + '_$',
);
const STRONG = new RegExp(
  lead(String.raw`^\w:/\\`) +
    String.raw`(?<open>\*\*|__)` +
    flanked(String.raw`*_`, '[^*_]') +
    String.raw`\k<open>$`,
);
const STRIKETHROUGH = new RegExp(
  lead(String.raw`^\w:/~\\`) + '(?<open>~{1,2})' + flanked('~', '.') + String.raw`\k<open>$`,
);
/** A backtick before the opener would make it a longer run, which one backtick cannot close. */
const INLINE_CODE = new RegExp(lead('^\\\\`', '`') + '(?<open>`)(?<text>[^`]+)`$');

/** The ```lang shortcut: any info word a backtick fence can open with. */
const CODE_FENCE = /^```(?<language>[^\s`]*)[\s\n]$/;
const HEADING = /^(?<hashes>#+)\s$/;
/** CommonMark's ATX heading: one to six `#`. */
const MAX_HEADING_LEVEL = 6;

/** Micromark's character classes. Inline leaves (usually line breaks) count as whitespace. */
function classify(char: string | undefined): 0 | 1 | 2 {
  if (char === undefined || char === '\ufffc' || /\s/.test(char)) return 1;
  return /[\p{P}\p{S}]/u.test(char) ? 2 : 0;
}

/** The delimiters micromark lets an attention run open or close against. */
const ATTENTION_MARKERS = '*_~';

/** Micromark's left/right flanking, including underscore's intraword restriction. */
function flanking(marker: string, before: string | undefined, after: string | undefined) {
  const b = classify(before);
  const a = classify(after);
  const attention = marker !== '~';
  const open =
    a === 0 || (a === 2 && b !== 0) || (attention && ATTENTION_MARKERS.includes(after ?? ' '));
  const close =
    b === 0 || (b === 2 && a !== 0) || (attention && ATTENTION_MARKERS.includes(before ?? ' '));
  if (marker !== '_') return { open, close };
  return { open: open && (b !== 0 || !close), close: close && (a !== 0 || !open) };
}

/** An opener inside a GFM URL literal belongs to the URL, including its delimiters. */
const INSIDE_URL = /(?:^|[\s\ufffc(*_[\]~])(?:https?:\/\/|www\.)[^\s\ufffc<]+$/i;

/** No `String.prototype.at`: the legacy Android WebView floor (Chromium 83) lacks it. */
function lastChar(text: string): string | undefined {
  return text.length > 0 ? text.charAt(text.length - 1) : undefined;
}

/** Whether `text` ends in an odd run of backslashes — so the delimiter after it is escaped. */
function endsEscaped(text: string): boolean {
  return /(?:^|[^\\])\\(?:\\\\)*$/.test(text);
}

function hasCodeMark(marks: readonly Mark[]): boolean {
  return marks.some((mark) => mark.type.spec.code);
}

function rangeHasCodeMark(state: EditorState, from: number, to: number): boolean {
  let found = false;
  if (from < to) {
    state.doc.nodesBetween(from, to, (node) => {
      if (node.isInline && hasCodeMark(node.marks)) found = true;
      return !found;
    });
  }
  return found;
}

/** Remove paired delimiters, retaining the leading context and existing inline marks.
 * The closer’s last character is the pending keystroke, absent from the document. */
function applyMark(
  state: EditorState,
  match: RegExpMatchArray,
  start: number,
  end: number,
  mark: (open: string) => Mark,
  delimited: boolean,
): Transaction | null {
  const { lead: before = '', open = '', text = '' } = match.groups ?? {};
  if (text.trim() === '') return null;
  const textBefore = (match.input ?? '').slice(0, (match.index ?? 0) + before.length);
  if (INSIDE_URL.test(textBefore)) return null;
  if (delimited) {
    if (endsEscaped(text)) return null;
    const marker = open.charAt(0);
    if (!flanking(marker, lastChar(before), text.charAt(0)).open) return null;
    if (!flanking(marker, lastChar(text), undefined).close) return null;
  }
  const from = start + before.length;
  const textStart = from + open.length;
  const textEnd = textStart + text.length;
  if (
    rangeHasCodeMark(state, from, textStart) ||
    rangeHasCodeMark(state, textEnd, end) ||
    hasCodeMark(state.storedMarks ?? state.doc.resolve(end).marks())
  ) {
    return null;
  }
  const tr = state.tr;
  const storedMarks = tr.storedMarks ?? [];
  if (textEnd < end) tr.delete(textEnd, end);
  tr.delete(from, textStart);
  tr.addMark(from, from + text.length, mark(open));
  tr.setStoredMarks(storedMarks);
  return tr;
}

/** Retry later openers when an earlier one cannot pair. Code spans ignore flanking
 * and treat backslashes inside the span as literal text. */
function delimitedMarkRule(
  pattern: RegExp,
  markType: MarkType,
  attrs: (open: string) => Attrs | null = () => null,
  delimited = true,
): InputRule {
  const everyOpener = new RegExp(pattern.source, 'g');
  const mark = (open: string) => markType.create(attrs(open));
  return new InputRule(pattern, (state, first, start, end) => {
    const input = first.input ?? '';
    const firstIndex = first.index ?? 0;
    let match: RegExpMatchArray | null = first;
    while (match) {
      const index = match.index ?? firstIndex;
      const tr = applyMark(state, match, start + (index - firstIndex), end, mark, delimited);
      if (tr) return tr;
      everyOpener.lastIndex = index + 1;
      match = everyOpener.exec(input);
    }
    return null;
  });
}

export const emphasisStarInputRule = $inputRule((ctx) =>
  delimitedMarkRule(EMPHASIS_STAR, emphasisSchema.type(ctx), () => ({ marker: '*' })),
);

export const emphasisUnderscoreInputRule = $inputRule((ctx) =>
  delimitedMarkRule(EMPHASIS_UNDERSCORE, emphasisSchema.type(ctx), () => ({ marker: '_' })),
);

export const strongInputRule = $inputRule((ctx) =>
  delimitedMarkRule(STRONG, strongSchema.type(ctx), (open) => ({
    marker: open.startsWith('*') ? '*' : '_',
  })),
);

export const inlineCodeInputRule = $inputRule((ctx) =>
  delimitedMarkRule(INLINE_CODE, inlineCodeSchema.type(ctx), () => null, false),
);

export const strikethroughInputRule = $inputRule((ctx) =>
  delimitedMarkRule(STRIKETHROUGH, strikethroughSchema.type(ctx)),
);

export const createCodeBlockInputRule = $inputRule((ctx) =>
  textblockTypeInputRule(CODE_FENCE, codeBlockSchema.type(ctx), (match) => ({
    language: match.groups?.language ?? '',
  })),
);

export const wrapInHeadingInputRule = $inputRule((ctx) => {
  const heading = headingSchema.type(ctx);
  return new InputRule(HEADING, (state, match, start, end) => {
    const typed = match.groups?.hashes?.length ?? 0;
    const $start = state.doc.resolve(start);
    const block = $start.parent;
    const inHeading = block.type === heading;
    if (!inHeading && typed > MAX_HEADING_LEVEL) return null;
    const level = inHeading
      ? Math.min(MAX_HEADING_LEVEL, Number(block.attrs.level) + typed)
      : typed;
    if (!$start.node(-1).canReplaceWith($start.index(-1), $start.indexAfter(-1), heading)) {
      return null;
    }
    return state.tr.delete(start, end).setBlockType(start, start, heading, { level });
  });
});
