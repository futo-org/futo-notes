import { GFM, parser } from '@lezer/markdown';
import type { SyntaxNode } from '@lezer/common';

import type { GauntletSemanticKind } from './types';

export interface MarkdownBlockRange {
  from: number;
  to: number;
}

export interface SemanticNode {
  from: number;
  to: number;
  paragraph: number;
  text: string;
}

const markdownParser = parser.configure(GFM);

const NODE_NAME: Partial<Record<GauntletSemanticKind, string>> = {
  bold: 'StrongEmphasis',
  italic: 'Emphasis',
  strikethrough: 'Strikethrough',
  'inline-code': 'InlineCode',
  link: 'Link',
};

const MARKER_NAME = new Set(['EmphasisMark', 'StrikethroughMark', 'CodeMark', 'LinkMark', 'URL']);

function paragraphIndex(node: SyntaxNode): number {
  let paragraph = node;
  while (paragraph.parent && paragraph.name !== 'Paragraph') paragraph = paragraph.parent;
  return paragraph.name === 'Paragraph' ? paragraph.from : -1;
}

function sourceTextWithoutMarkers(source: string, node: SyntaxNode): string {
  const markerRanges: Array<{ from: number; to: number }> = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (MARKER_NAME.has(child.name)) markerRanges.push({ from: child.from, to: child.to });
  }
  let text = '';
  let from = node.from;
  for (const marker of markerRanges) {
    text += source.slice(from, marker.from);
    from = marker.to;
  }
  return text + source.slice(from, node.to);
}

function lezerSemanticNodes(source: string, nodeName: string): SemanticNode[] {
  const tree = markdownParser.parse(source);
  const nodes: SemanticNode[] = [];
  const cursor = tree.cursor();
  do {
    if (cursor.name !== nodeName) continue;
    const node = cursor.node;
    nodes.push({
      from: node.from,
      to: node.to,
      paragraph: paragraphIndex(node),
      text: sourceTextWithoutMarkers(source, node),
    });
  } while (cursor.next());
  return nodes;
}

function wikilinkNodes(source: string): SemanticNode[] {
  const tree = markdownParser.parse(source);
  const paragraphs: MarkdownBlockRange[] = [];
  const cursor = tree.cursor();
  do {
    if (cursor.name === 'Paragraph') paragraphs.push({ from: cursor.from, to: cursor.to });
  } while (cursor.next());
  const nodes: SemanticNode[] = [];
  const pattern = /\[\[([^\]\n]+)\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    const paragraph = paragraphs.find(
      (range) => match!.index >= range.from && match!.index + match![0].length <= range.to,
    )?.from;
    nodes.push({
      from: match.index,
      to: match.index + match[0].length,
      paragraph: paragraph ?? -1,
      text: match[1],
    });
  }
  return nodes;
}

export function semanticNodes(source: string, kind: GauntletSemanticKind): SemanticNode[] {
  if (kind === 'wikilink') return wikilinkNodes(source);
  const nodeName = NODE_NAME[kind];
  return nodeName ? lezerSemanticNodes(source, nodeName) : [];
}

export function markdownBlockRanges(source: string): MarkdownBlockRange[] {
  const tree = markdownParser.parse(source);
  const ranges: MarkdownBlockRange[] = [];
  for (let child = tree.topNode.firstChild; child; child = child.nextSibling) {
    ranges.push({ from: child.from, to: child.to });
  }
  return ranges;
}
