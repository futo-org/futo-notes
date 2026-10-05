/**
 * Typing an image by hand: the moment the closing `)` of `![alt](src)` lands,
 * the text turns into the image node (docs/spec/editor.md "Formatting is
 * reachable by typing Markdown"; RC-56).
 *
 * `@milkdown/preset-commonmark` defines an `insertImageInputRule` but never
 * puts it in its `commonmark` preset, so nothing did this: the typed text
 * stayed text and the serializer then escaped it (`!\[alt]\(file)`) on disk.
 * The preset's own regex is not usable as-is either — it is unanchored, keeps
 * the `<…>` brackets in the filename, and cannot be told apart from an escaped
 * `\![`.
 *
 * What converts is anything the note itself could hold in that position — a
 * vault filename, an external `https:`/`http:` URL (with a query string), the
 * `<…>` destination CommonMark needs for a space, and an optional `"title"` —
 * because `vaultImageView.ts` already renders every one of those, and the node
 * saves back as the same bytes it was typed as. Whether an external image then
 * LOADS is the shell's content-security policy, not this rule's business.
 */
import { imageSchema } from '@milkdown/kit/preset/commonmark';
import { InputRule } from '@milkdown/kit/prose/inputrules';
import { $inputRule } from '@milkdown/kit/utils';

import { isInCode } from './wikilink/node';

/**
 * `![alt](destination "title")` ending at the caret.
 *
 * Group 1 is the character before the `!` (or empty at the start of the
 * block): a `\` there means `\![` — escaped, so plain text. Checked here
 * rather than with a look-behind, which the legacy Android WebView floor
 * (`editor-embed-webview-floor.spec.ts`) may not have.
 *
 * The destination is `<…>` (spaces allowed), or a run without whitespace and
 * unbalanced parentheses — one level of `(…)` inside is kept, so
 * `https://example.com/a_(b).png` closes on its LAST `)`, not the first.
 */
const IMAGE_INPUT_RE =
  /(^|[^\\])!\[([^\][\n]*)\]\((?:<([^<>\n]*)>|((?:[^\s()<>]|\([^\s()<>]*\))*))(?:\s+(?:"([^"\n]*)"|'([^'\n]*)'))?\)$/;

export const imageInputRule = $inputRule((ctx) => {
  return new InputRule(IMAGE_INPUT_RE, (state, match, start, end) => {
    const [, lead, alt, angle, bare, doubleQuoted, singleQuoted] = match;
    const src = angle ?? bare ?? '';
    // `![](<>)` and `![]()` name no image at all.
    if (!src) return null;
    if (isInCode(state.doc.resolve(start), state.storedMarks)) return null;
    if (isInCode(state.doc.resolve(end), state.storedMarks)) return null;
    // A code span still being typed has no mark yet — its closing backtick has
    // not arrived — so an odd number of backticks earlier in the block means
    // this text is going to be inside one, and is code.
    const imageStart = start + lead.length;
    const $imageStart = state.doc.resolve(imageStart);
    const typedBefore = $imageStart.parent.textBetween(
      0,
      $imageStart.parentOffset,
      undefined,
      '\ufffc',
    );
    if (typedBefore.split('`').length % 2 === 0) return null;
    const image = imageSchema.type(ctx).create({
      src,
      alt: alt ?? '',
      title: doubleQuoted ?? singleQuoted ?? '',
    });
    // `start` is where the match begins, including the one character before the `!`.
    return state.tr.replaceWith(imageStart, end, image);
  });
});
