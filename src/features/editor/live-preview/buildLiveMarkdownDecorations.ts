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
import { decorateListItem } from './listDecorations';
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
import { getViewportScanRanges, type DocumentRange } from './viewportScanRanges';

function decorateMarkdownNode(
  nodeName: string,
  from: number,
  to: number,
  view: EditorView,
  decorations: PendingDecoration[],
  quoteLinesProcessed: Set<number>,
  scanRange: DocumentRange,
): void {
  const doc = view.state.doc;
  if (isHeadingNode(nodeName)) {
    decorateHeading(nodeName, from, to, doc.sliceString(from, to), view, decorations);
  } else if (isEmphasisNode(nodeName)) {
    decorateEmphasis(nodeName, from, to, doc.sliceString(from, to), view, decorations);
  } else if (isCodeNode(nodeName)) {
    const text = nodeName === 'InlineCode' ? doc.sliceString(from, to) : '';
    decorateCode(nodeName, from, to, text, view, decorations, scanRange);
  } else if (isStrikethroughNode(nodeName)) decorateStrikethrough(from, to, view, decorations);
  else if (isLinkNode(nodeName)) {
    decorateLink(from, to, doc.sliceString(from, to), view, decorations);
  } else if (isImageNode(nodeName)) {
    decorateImage(from, to, doc.sliceString(from, to), decorations);
  } else if (isBlockQuoteNode(nodeName)) {
    decorateBlockQuote(from, to, view, decorations, quoteLinesProcessed, scanRange);
  } else if (isListItemNode(nodeName)) {
    decorateListItem(from, doc.sliceString(from, doc.lineAt(from).to), view, decorations);
  } else if (isHorizontalRuleNode(nodeName)) decorateHorizontalRule(from, to, decorations);
}

export function createLiveMarkdownDecorationBuilder() {
  const headerTags = createHeaderTagDecorator();

  return function buildLiveMarkdownDecorations(view: EditorView) {
    if (view.composing || view.compositionStarted) return createDecorationSet(view, [], 0);

    const decorations: PendingDecoration[] = [];
    const selectionRanges = view.state.selection.ranges;
    const quoteLinesProcessed = new Set<number>();
    const scanRanges = getViewportScanRanges(view.state.doc, view.visibleRanges);
    const wikilinkRanges = collectWikilinkRanges(view.state.doc, scanRanges);
    const headerEndOffset = headerTags.getHeaderEndOffset(view.state.doc);
    const tree = syntaxTree(view.state);

    for (const range of scanRanges) {
      tree.iterate({
        from: range.from,
        to: range.to,
        enter: (node) => {
          const { name, from, to } = node;
          if (headerEndOffset > 0 && from < headerEndOffset) return;
          if (name !== 'Document' && isInsideWikilink(wikilinkRanges, from, to)) return;

          const blockSyntaxRevealed =
            isBlockRevealSensitive(name) &&
            shouldSkipBlockDecorations(name, from, to, view.hasFocus, selectionRanges);
          if (blockSyntaxRevealed && !isHeadingNode(name)) return;
          if (
            /^(Image|Task)/.test(name) &&
            selectionTouchesRange(view.hasFocus, selectionRanges, from, to)
          ) {
            return;
          }
          decorateMarkdownNode(name, from, to, view, decorations, quoteLinesProcessed, range);
        },
      });
    }

    addWikilinkDecorations(view, decorations, scanRanges);
    headerTags.addInlineTagDecorations(view, decorations, scanRanges);
    return createDecorationSet(view, decorations, headerEndOffset);
  };
}
