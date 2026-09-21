/**
 * Typing a wikilink by hand: the moment the closing `]]` lands, the text turns
 * into the node. Autocomplete (`autocomplete.ts`) is the fast path; this is the
 * one that catches a target typed out in full, or `]]` closed after the popup
 * was dismissed.
 */
import { $inputRule } from '@milkdown/kit/utils';
import { InputRule } from '@milkdown/kit/prose/inputrules';

import { WIKILINK_RE } from '$shared/note/wikilinks';
import { createWikilink, isInCode } from './node';

/**
 * `WIKILINK_RE`'s body anchored to the caret, so the rule fires on the same
 * text the conformance-locked rule calls a wikilink and never on a prefix of
 * one. Rebuilt from `.source` rather than restated — the `g` flag on the shared
 * constant is not wanted here, and neither is a second copy of the grammar.
 */
export const WIKILINK_INPUT_RE = new RegExp(`${WIKILINK_RE.source}$`);

export const wikilinkInputRule = $inputRule(() => {
  return new InputRule(WIKILINK_INPUT_RE, (state, match, start, end) => {
    const target = match[1];
    if (!target) return null;
    // prosemirror-inputrules skips code BLOCKS on its own but knows nothing of
    // the inline-code MARK, so `[[x]]` typed inside backticks would become a
    // chip inside a code span. → node.ts isInCode
    if (isInCode(state.doc.resolve(start), state.storedMarks)) return null;
    return state.tr.replaceWith(start, end, createWikilink(state.schema, target));
  });
});
