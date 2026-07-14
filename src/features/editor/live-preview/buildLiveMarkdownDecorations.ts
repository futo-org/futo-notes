import { syntaxTree } from '@codemirror/language';
import type { EditorView } from '@codemirror/view';

import {
  decorateBlockQuote,
  decorateCode,
  decorateHeading,
  decorateHorizontalRule,
} from './blockDecorations';
import { createDecorationSet } from './decorationSet';
import type { PendingDecoration } from './decorationTypes';
import { createHeaderTagDecorator } from './headerTagDecorations';
import {
  decorateEmphasis,
  decorateImage,
  decorateLink,
  decorateStrikethrough,
} from './inlineDecorations';
import { decorateListItem, decorateListItemIndentOnly } from './listDecorations';
import {
  isBlockQuoteNode,
  isCodeNode,
  isEmphasisNode,
  isHeadingNode,
  isHorizontalRuleNode,
  isImageNode,
  isLinkNode,
  isListItemNode,
  isStrikethroughNode,
} from './markdownNodes';
import {
  isBlockRevealSensitive,
  selectionTouchesRange,
  shouldSkipBlockDecorations,
} from './selectionReveal';
import {
  addWikilinkDecorations,
  collectWikilinkRanges,
  isInsideWikilink,
} from './wikilinkDecorations';

function decorateMarkdownNode(
  nodeName: string,
  from: number,
  to: number,
  view: EditorView,
  decorations: PendingDecoration[],
  quoteLinesProcessed: Set<number>,
): void {
  const text = view.state.doc.sliceString(from, to);
  if (isHeadingNode(nodeName)) decorateHeading(nodeName, from, to, text, view, decorations);
  else if (isEmphasisNode(nodeName)) decorateEmphasis(nodeName, from, to, text, view, decorations);
  else if (isCodeNode(nodeName)) decorateCode(nodeName, from, to, text, view, decorations);
  else if (isStrikethroughNode(nodeName)) decorateStrikethrough(from, to, view, decorations);
  else if (isLinkNode(nodeName)) decorateLink(from, to, text, view, decorations);
  else if (isImageNode(nodeName)) decorateImage(from, to, text, decorations);
  else if (isBlockQuoteNode(nodeName)) {
    decorateBlockQuote(from, to, view, decorations, quoteLinesProcessed);
  } else if (isListItemNode(nodeName)) decorateListItem(from, text, view, decorations);
  else if (isHorizontalRuleNode(nodeName)) decorateHorizontalRule(from, to, decorations);
}

export function createLiveMarkdownDecorationBuilder() {
  const headerTags = createHeaderTagDecorator();

  return function buildLiveMarkdownDecorations(view: EditorView) {
    if (view.composing || view.compositionStarted) return createDecorationSet(view, [], 0);

    const decorations: PendingDecoration[] = [];
    const selectionRanges = view.state.selection.ranges;
    const quoteLinesProcessed = new Set<number>();
    const wikilinkRanges = collectWikilinkRanges(view.state.doc);
    const headerEndOffset = headerTags.getHeaderEndOffset(view.state.doc);

    syntaxTree(view.state).iterate({
      enter: (node) => {
        const { name, from, to } = node;
        if (headerEndOffset > 0 && from < headerEndOffset) return;
        if (name !== 'Document' && isInsideWikilink(wikilinkRanges, from, to)) return;

        const blockSyntaxRevealed =
          isBlockRevealSensitive(name) &&
          shouldSkipBlockDecorations(name, from, to, view.hasFocus, selectionRanges);
        if (blockSyntaxRevealed && !isHeadingNode(name)) {
          if (name === 'ListItem') decorateListItemIndentOnly(from, view, decorations);
          return;
        }
        if (
          /^(Image|Task)/.test(name) &&
          selectionTouchesRange(view.hasFocus, selectionRanges, from, to)
        ) {
          return;
        }
        decorateMarkdownNode(name, from, to, view, decorations, quoteLinesProcessed);
      },
    });

    addWikilinkDecorations(view, decorations);
    headerTags.addInlineTagDecorations(view, decorations);
    return createDecorationSet(view, decorations, headerEndOffset);
  };
}
