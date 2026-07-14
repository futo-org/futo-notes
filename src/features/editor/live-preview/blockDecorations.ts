import type { EditorView } from '@codemirror/view';

import type { PendingDecoration } from './decorationTypes';
import { getHeadingLevel } from './markdownNodes';
import {
  selectionTouchesRange,
  shouldRevealInlineMarkers,
  shouldRevealMarkdownSyntax,
} from './selectionReveal';
import { CodeLanguageLabelWidget, HorizontalRuleWidget, formatCodeLanguage } from './widgets';

export function decorateHeading(
  nodeName: string,
  from: number,
  to: number,
  text: string,
  view: EditorView,
  decorations: PendingDecoration[],
): void {
  const markerMatch = text.match(/^#+/);
  if (!markerMatch) return;

  const level = getHeadingLevel(nodeName);
  const markerLength = markerMatch[0].length;
  const markerEnd = from + markerLength + (text[markerLength] === ' ' ? 1 : 0);
  const revealMarkers = shouldRevealMarkdownSyntax(
    view.hasFocus,
    view.state.selection.ranges,
    from,
    to,
  );

  if (!revealMarkers) {
    decorations.push({ from, to: markerEnd, value: { replace: true } });
  } else {
    decorations.push(
      {
        from,
        to: markerEnd,
        value: { class: `cm-md-inline-marker cm-md-h${level}-marker` },
      },
      { from, to: markerEnd, value: { class: `cm-md-h${level}` } },
    );
  }
  decorations.push(
    {
      from: markerEnd,
      to,
      value: {
        class: `cm-md-h${level}`,
        attributes: { 'data-heading-level': level.toString() },
      },
    },
    {
      from: view.state.doc.lineAt(from).from,
      to: view.state.doc.lineAt(from).from,
      value: { class: `cm-md-h${level}-line`, startSide: 0, endSide: 0 },
    },
  );
}

function decorateInlineCode(
  from: number,
  to: number,
  text: string,
  view: EditorView,
  decorations: PendingDecoration[],
): void {
  const backticks = text.match(/^`+/)?.[0].length ?? 1;
  const revealMarkers = shouldRevealInlineMarkers(view, from, to);
  if (!revealMarkers) {
    decorations.push(
      { from, to: from + backticks, value: { replace: true } },
      { from: to - backticks, to, value: { replace: true } },
    );
  } else {
    decorations.push(
      {
        from,
        to: from + backticks,
        value: { class: 'cm-md-inline-marker cm-md-code-marker' },
      },
      {
        from: to - backticks,
        to,
        value: { class: 'cm-md-inline-marker cm-md-code-marker' },
      },
    );
  }
  decorations.push({
    from: from + backticks,
    to: to - backticks,
    value: { class: 'cm-md-code' },
  });
}

function codeLineClass(params: {
  lineNumber: number;
  contentStartLine: number;
  contentEndLine: number;
  contentLineCount: number;
  isOpening: boolean;
  isClosing: boolean;
  cursorInBlock: boolean;
}): string {
  const {
    lineNumber,
    contentStartLine,
    contentEndLine,
    contentLineCount,
    isOpening,
    isClosing,
    cursorInBlock,
  } = params;
  let cssClass = 'cm-md-code-block';
  if ((isOpening || isClosing) && !cursorInBlock) {
    cssClass += ' cm-md-code-block-fence';
    if (isOpening) cssClass += ' cm-md-code-block-opening-fence';
    if (isClosing) cssClass += ' cm-md-code-block-closing-fence';
  } else if (contentLineCount <= 1) {
    cssClass += ' cm-md-code-block-single';
  } else if (lineNumber === contentStartLine) {
    cssClass += ' cm-md-code-block-first';
  } else if (lineNumber === contentEndLine) {
    cssClass += ' cm-md-code-block-last';
  } else {
    cssClass += ' cm-md-code-block-middle';
  }
  return cssClass;
}

function decorateCodeBlock(
  nodeName: string,
  from: number,
  to: number,
  view: EditorView,
  decorations: PendingDecoration[],
): void {
  const doc = view.state.doc;
  const startLine = doc.lineAt(from);
  const endLine = doc.lineAt(to);
  const hasClosingFence =
    endLine.number !== startLine.number && /^\s*(`{3,}|~{3,})\s*$/.test(endLine.text);
  const contentStartLine = nodeName === 'FencedCode' ? startLine.number + 1 : startLine.number;
  const contentEndLine =
    nodeName === 'FencedCode' && hasClosingFence ? endLine.number - 1 : endLine.number;
  const contentLineCount = Math.max(0, contentEndLine - contentStartLine + 1);
  const cursorInBlock = selectionTouchesRange(view.hasFocus, view.state.selection.ranges, from, to);

  for (let lineNumber = startLine.number; lineNumber <= endLine.number; lineNumber++) {
    const line = doc.line(lineNumber);
    const openingMatch =
      lineNumber === startLine.number
        ? line.text.match(/^\s*(`{3,}|~{3,})\s*([A-Za-z0-9_+-]*)\s*$/)
        : null;
    const isOpening = Boolean(openingMatch);
    const isClosing = lineNumber === endLine.number && hasClosingFence;

    if ((isOpening || isClosing) && !cursorInBlock && line.from < line.to) {
      if (isOpening && openingMatch?.[2]) {
        decorations.push({
          from: line.from,
          to: line.to,
          value: { widget: new CodeLanguageLabelWidget(formatCodeLanguage(openingMatch[2])) },
        });
      } else {
        decorations.push({ from: line.from, to: line.to, value: { replace: true } });
      }
    }

    decorations.push({
      from: line.from,
      to: line.from,
      value: {
        class: codeLineClass({
          lineNumber,
          contentStartLine,
          contentEndLine,
          contentLineCount,
          isOpening,
          isClosing,
          cursorInBlock,
        }),
        startSide: 0,
        endSide: 0,
      },
    });
  }
}

export function decorateCode(
  nodeName: string,
  from: number,
  to: number,
  text: string,
  view: EditorView,
  decorations: PendingDecoration[],
): void {
  if (nodeName === 'InlineCode') {
    decorateInlineCode(from, to, text, view, decorations);
  } else {
    decorateCodeBlock(nodeName, from, to, view, decorations);
  }
}

function quoteSegments(lineText: string, lineFrom: number) {
  const segments: Array<{ from: number; to: number; level: number }> = [];
  let nestLevel = 0;
  let position = 0;
  while (position < lineText.length && lineText[position] === '>') {
    nestLevel++;
    const start = position++;
    if (lineText[position] === ' ') position++;
    segments.push({ from: lineFrom + start, to: lineFrom + position, level: nestLevel });
  }
  return { segments, nestLevel, contentOffset: position };
}

export function decorateBlockQuote(
  from: number,
  to: number,
  view: EditorView,
  decorations: PendingDecoration[],
  processedLines: Set<number>,
): void {
  const doc = view.state.doc;
  const selectionRanges = view.state.selection.ranges;
  const quoteLines: Array<{ lineNumber: number; nestLevel: number }> = [];
  const firstLine = doc.lineAt(from).number;
  const lastLine = doc.lineAt(to).number;

  for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber++) {
    if (processedLines.has(lineNumber)) continue;
    const line = doc.line(lineNumber);
    const { segments, nestLevel, contentOffset } = quoteSegments(line.text, line.from);
    if (nestLevel === 0) continue;

    const revealMarker = shouldRevealMarkdownSyntax(
      view.hasFocus,
      selectionRanges,
      line.from,
      line.to,
    );
    for (const segment of segments) {
      if (segment.from === segment.to) continue;
      decorations.push({
        from: segment.from,
        to: segment.to,
        value: {
          class: revealMarker
            ? `cm-md-quote-marker cm-md-quote-marker-${segment.level}`
            : `cm-md-quote-marker-hidden cm-md-quote-marker-${segment.level}`,
        },
      });
    }
    if (line.from + contentOffset < line.to) {
      decorations.push({
        from: line.from + contentOffset,
        to: line.to,
        value: { class: `cm-md-quote-text cm-md-quote-text-${nestLevel}` },
      });
    }
    quoteLines.push({ lineNumber, nestLevel });
    processedLines.add(lineNumber);
  }

  quoteLines.forEach(({ lineNumber, nestLevel }, index) => {
    let cssClass = `cm-md-quote cm-md-quote-level-${nestLevel}`;
    if (quoteLines.length === 1) cssClass += ' cm-md-quote-single';
    else if (index === 0) cssClass += ' cm-md-quote-first';
    else if (index === quoteLines.length - 1) cssClass += ' cm-md-quote-last';
    else cssClass += ' cm-md-quote-middle';
    const lineFrom = doc.line(lineNumber).from;
    decorations.push({
      from: lineFrom,
      to: lineFrom,
      value: { class: cssClass, startSide: 0, endSide: 0 },
    });
  });
}

export function decorateHorizontalRule(
  from: number,
  to: number,
  decorations: PendingDecoration[],
): void {
  decorations.push({ from, to, value: { widget: new HorizontalRuleWidget() } });
}
