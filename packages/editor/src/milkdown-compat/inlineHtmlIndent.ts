import type { RemarkPluginRaw } from '@milkdown/kit/transformer';
import { $remark } from '@milkdown/kit/utils';

import type { MdastNode } from './mdast';

/**
 * Give a multi-line inline HTML tag back the indent its continuation lines had.
 *
 * micromark reads each line after the first of an inline (text) HTML node
 * through a line prefix of up to three spaces — `micromark-core-commonmark`'s
 * `htmlText`, `lineEndingAfter` — and leaves that prefix out of the node's
 * value. The serializer writes the value back verbatim, so every save took
 * three more columns off every continuation line until it reached column 0:
 * `<span\n       a='1'>` went 7 → 4 → 1 → 0 over three saves, and inside a
 * quoted attribute value that is a change to the value (six census notes,
 * `unstable_persistent`).
 *
 * The prefix is taken greedily, so a value line that still starts with a space
 * lost exactly three; those get them back here, which makes the value what the
 * author wrote and the round trip a fixed point. A line that starts at column 0
 * in the value had three or fewer, which cannot be told apart, and is left at 0
 * — one re-spelling on the first real edit, then stable (ADR-0002).
 *
 * Only INLINE HTML, which is why this hooks the `htmlText` token rather than
 * walking the tree: a block of HTML keeps its lines verbatim on parse (adding
 * anything there would grow it every save), and by the time a tree transformer
 * runs, the preset's `remarkHtmlTransformer` has wrapped every block of HTML in
 * a paragraph, where it looks exactly like an inline tag that fills its
 * paragraph. The handler below is `mdast-util-from-markdown`'s own
 * `closer(onexithtmltext)` with the indent put back; an extension's handler
 * replaces the default one wholesale, so it closes the node itself.
 *
 * Same carve-out as the rest of this directory: an adapter for one parser's
 * behavior, not a note rule (packages/editor/AGENTS.md).
 */
function restoreContinuationIndent(value: string): string {
  return value.replace(/(\r\n|\r|\n)(?= )/g, '$1   ');
}

/** The slice of `mdast-util-from-markdown`'s compile context used here. */
interface FromMarkdownContext {
  resume(): string;
  exit(token: unknown): void;
  stack: MdastNode[];
}

const inlineHtmlIndentFromMarkdown = {
  exit: {
    htmlText(this: FromMarkdownContext, token: unknown): void {
      const value = this.resume();
      const node = this.stack[this.stack.length - 1];
      if (node) node.value = restoreContinuationIndent(value);
      this.exit(token);
    },
  },
};

const remarkInlineHtmlIndent: RemarkPluginRaw<undefined> = function remarkInlineHtmlIndent() {
  const data = this.data() as Record<string, unknown[]>;
  (data.fromMarkdownExtensions ??= []).push(inlineHtmlIndentFromMarkdown);
};

export const remarkInlineHtmlIndentPlugin = $remark(
  'futo-inline-html-indent',
  () => remarkInlineHtmlIndent,
);
