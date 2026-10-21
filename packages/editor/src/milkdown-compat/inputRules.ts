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
 *  4. Every mark rule took a backslash-escaped opener (`\*not italic*`,
 *     `\**x**`, `\_x_`, `` \`x` ``, `\~x~`) as a real one. An odd run of
 *     backslashes escapes the delimiter after it; an even run is escaped
 *     backslashes, and the delimiter still opens.
 *
 * Everything else is the preset's: the same delimiters, the same characters
 * that may not touch an opener (`\w:/` before `**`/`__`/`~~`, `*` before `*`,
 * a word character before `_`), the same code-mark guards as `markRule` in
 * `@milkdown/prose`, the same marks and attributes. No look-behind: the
 * character before an opener is matched as a `lead` group instead, as
 * src/features/editor/milkdown/imageInputRule.ts does for the legacy WebView floor.
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
import type { EditorState } from '@milkdown/kit/prose/state';
import { $inputRule } from '@milkdown/kit/utils';

/**
 * What may come before an opener: the start of the text, a character from
 * `allowed` (a regex class body), or any non-backslash character followed by
 * backslashes — and then an EVEN run of backslashes, each pair an escaped
 * backslash. An odd run leaves one `\` straight before the delimiter, which
 * nothing here matches, so an escaped opener never opens.
 */
function lead(allowed: string): string {
  return String.raw`(?<lead>(?:^|[${allowed}]|[^\\](?=\\))(?:\\\\)*)`;
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
    String.raw`(?:\*\*|__)$`,
);
const STRIKETHROUGH = new RegExp(
  lead(String.raw`^\w:/\\`) + '(?<open>~{1,2})' + flanked('~', '.') + String.raw`\k<open>$`,
);
const INLINE_CODE = new RegExp(lead(String.raw`^\\`) + '(?<open>`)(?<text>[^`]+)`$');

/** The ```lang shortcut: any info word a backtick fence can open with. */
const CODE_FENCE = /^```(?<language>[^\s`]*)[\s\n]$/;
const HEADING = /^(?<hashes>#+)\s$/;
/** CommonMark's ATX heading: one to six `#`. */
const MAX_HEADING_LEVEL = 6;

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
 * `markType` over the `text` group, its delimiters removed — `markRule`'s
 * effect, with the `lead` group left where it is. The closing delimiter's last
 * character is the keystroke itself, which an input rule never inserts.
 */
function delimitedMarkRule(
  pattern: RegExp,
  markType: MarkType,
  attrs: (open: string) => Attrs | null = () => null,
): InputRule {
  return new InputRule(pattern, (state, match, start, end) => {
    const { lead: before = '', open = '', text = '' } = match.groups ?? {};
    if (text.trim() === '') return null;
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
    tr.addMark(from, from + text.length, markType.create(attrs(open)));
    tr.setStoredMarks(storedMarks);
    return tr;
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
  delimitedMarkRule(INLINE_CODE, inlineCodeSchema.type(ctx)),
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
