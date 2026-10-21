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
 *
 * paragraphLines.ts `lineStartShortcut` mirrors the block rules here (1);
 * paragraphLines.preset.test.ts holds the two together.
 *
 * Canary: `tests/editor-embed-milkdown-compat.spec.ts` types each case into the
 * UNPATCHED presets; when upstream fixes one, its canary fails and the fork
 * here should go.
 */
import { codeBlockSchema } from '@milkdown/kit/preset/commonmark';
import { textblockTypeInputRule } from '@milkdown/kit/prose/inputrules';
import { $inputRule } from '@milkdown/kit/utils';

/** The ```lang shortcut: any info word a backtick fence can open with. */
const CODE_FENCE = /^```(?<language>[^\s`]*)[\s\n]$/;

export const createCodeBlockInputRule = $inputRule((ctx) =>
  textblockTypeInputRule(CODE_FENCE, codeBlockSchema.type(ctx), (match) => ({
    language: match.groups?.language ?? '',
  })),
);
