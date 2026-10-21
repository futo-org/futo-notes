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
 *
 * paragraphLines.ts `lineStartShortcut` mirrors the block rules here (1, 2);
 * paragraphLines.preset.test.ts holds the two together.
 *
 * Canary: `tests/editor-embed-milkdown-compat.spec.ts` types each case into the
 * UNPATCHED presets; when upstream fixes one, its canary fails and the fork
 * here should go.
 */
import { codeBlockSchema, headingSchema } from '@milkdown/kit/preset/commonmark';
import { InputRule, textblockTypeInputRule } from '@milkdown/kit/prose/inputrules';
import { $inputRule } from '@milkdown/kit/utils';

/** The ```lang shortcut: any info word a backtick fence can open with. */
const CODE_FENCE = /^```(?<language>[^\s`]*)[\s\n]$/;
const HEADING = /^(?<hashes>#+)\s$/;
/** CommonMark's ATX heading: one to six `#`. */
const MAX_HEADING_LEVEL = 6;

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
