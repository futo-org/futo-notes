/*
 * The markdown typed as you go, read the way a FILE reads it.
 *
 * The presets' input rules turn typed markdown into formatting
 * (docs/spec/editor/interactive-elements.md "convert as you type"), but some
 * of them disagreed with the parser that reads the note back, so typing what a
 * file holds changed it:
 *
 *  1. The ```lang shortcut took lowercase letters only, so ```c++, ```C#,
 *     ```JavaScript and ```ps1 — names the curated fence set spells
 *     (src/features/editor/codeFenceLanguages.ts) — stayed an escaped paragraph.
 *     It now takes any info word a fence can open with: no space, no backtick.
 *  2. `####### ` made a level-7 heading node, which saved as six `#`. Seven or
 *     more `#` are not a heading; in a paragraph they stay text. (Inside a
 *     heading the preset's level bump, capped at six, is kept.)
 *  3. Emphasis, strong and strikethrough took a run padded with whitespace:
 *     `2 * 3 *` italicised ` 3 ` and saved `2 *&#x20;3&#x20;* 4`; `** not bold **`
 *     saved `**not bold**`. CommonMark's flanking rule: an opener is not followed
 *     by whitespace, a closer not preceded by it.
 *     The punctuation half of that rule too: `a*"b"*` (an opener after a
 *     letter and before punctuation) and `café_b_` (an `_` between letters of
 *     any script) open nothing. `flanking` is micromark's own test.
 *  4. Every mark rule took a backslash-escaped delimiter (`\*not italic*`,
 *     `\**x**`, `\_x_`, `` \`x` ``, `\~x~`, and the closer of `*foo\*`) as a
 *     real one. An odd run of backslashes escapes the delimiter after it; an
 *     even run is escaped backslashes, and the delimiter still counts. Inside a
 *     code span a backslash escapes nothing, so `` `a\` `` is still code.
 *  5. A closer that is not its opener's match closed it: `a **x__` made `x`
 *     bold (and saved `a **x** b`), and ``` ``x` ``` made `x` code. A run of
 *     `**` is closed only by `**`, and one backtick only by one backtick — a
 *     backtick before it makes the opener a longer run.
 *  6. A delimiter typed inside a URL (`https://x.test/*a*`, `www.x.test/_a_`)
 *     opened a mark the URL's literal swallows in a file; the autolink then
 *     saved junk like `[https://x.test/*a*](https://x.test/a)`. It stays a
 *     character of the URL (`INSIDE_URL`).
 *
 * Everything else is the preset's: the same delimiters, the same characters
 * that may not touch an opener (`\w:/` before `**`/`__`, `*` before `*`, a
 * word character before `_`; and before `~`/`~~` also `~`, since a run is one
 * delimiter: `a~~"b"~` struck `"b"` with the run's second tilde), the same
 * code-mark guards as `markRule` in `@milkdown/prose`, the same marks and
 * attributes. No look-behind: the character before an opener is matched as a
 * `lead` group instead, as src/features/editor/milkdown/imageInputRule.ts does
 * for the legacy WebView floor.
 *
 * paragraphLines.ts `lineStartShortcut` mirrors the block rules here (1, 2);
 * paragraphLines.preset.test.ts holds the two together.
 *
 * Canary: `tests/editor-embed-milkdown-compat.spec.ts` types each case into the
 * UNPATCHED presets; when upstream fixes one, its canary fails and the fork
 * here should go.
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

/**
 * What may come before an opener: the start of the text, a character from
 * `allowed` (a regex class body), or any non-backslash character followed by
 * backslashes — and then an EVEN run of backslashes, each pair an escaped
 * backslash. An odd run leaves one `\` straight before the delimiter, which
 * nothing here matches, so an escaped opener never opens.
 */
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

/**
 * micromark's `classifyCharacter`: 1 for whitespace or the edge of the text,
 * 2 for Unicode punctuation (P or S), 0 for anything else. The `\ufffc` an
 * input rule reads for an inline leaf is most often a hard break — a line end.
 */
function classify(char: string | undefined): 0 | 1 | 2 {
  if (char === undefined || char === '\ufffc' || /\s/.test(char)) return 1;
  return /[\p{P}\p{S}]/u.test(char) ? 2 : 0;
}

/** The delimiters micromark lets an attention run open or close against. */
const ATTENTION_MARKERS = '*_~';

/**
 * Whether a delimiter run of `marker` between `before` and `after` can open
 * (and, read the other way round, close) — micromark's attention and GFM
 * strikethrough rules, character for character: left-flanking is "not before
 * whitespace, and not before punctuation unless after whitespace or
 * punctuation"; an `_` also may not be right-flanking unless after
 * punctuation. An input rule fires on the closer's last keystroke, so what
 * follows the closer is the end of the text so far.
 */
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

/**
 * Text that ends inside a GFM autolink literal: a `http(s)://` or `www.` where
 * a literal may start (the text's start, whitespace, or one of `(*_[]~`), with
 * something after it and no whitespace or `<` since. A literal runs on to the
 * next whitespace, so a delimiter typed there is a character of the URL, not
 * an opener: a file reads `https://x.test/*a*` as a link to
 * `https://x.test/*a` (GFM trims the last `*`). An inline leaf (`\ufffc`, most
 * often a hard break) ends it like whitespace.
 */
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

/**
 * `markType` over the `text` group of `match`, its delimiters removed —
 * `markRule`'s effect, with the `lead` group left where it is — or null when
 * that opener and closer cannot pair. `start` is where `match` begins in the
 * document. The closing delimiter's last character is the keystroke itself,
 * which an input rule never inserts.
 */
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

/**
 * A mark rule over `pattern`. The regex finds the LEFTMOST opener the closer
 * could pair with; when that one cannot open (`café_a_ _b_`: the first `_`
 * sits between letters), each later one is tried in turn, as a file's parser
 * would go on to pair the closer with `_b`.
 *
 * `delimited` is false for a code span: its backticks follow no flanking rule
 * and a backslash inside it is text.
 */
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
