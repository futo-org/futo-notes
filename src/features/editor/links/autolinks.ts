import { syntaxTree } from '@codemirror/language';
import { Decoration, EditorView, ViewPlugin } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';

const PLAIN_URL = /\b(?:https?:\/\/|www\.)[^\s<>()]+[^\s<>().,!?;:]/g;
const MARKDOWN_LINK =
  /\[([^\]]+)\]\(((?:https?:\/\/|www\.)[^()\s]*(?:\([^)]*\)[^()\s]*)*)(?:\s+"[^"]*")?\)/g;

export const autoLinkHighlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildAutolinkDecorations(view);
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildAutolinkDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

export function findUrlAtPosition(view: EditorView, position: number): string | null {
  const line = view.state.doc.lineAt(position);
  const lineOffset = position - line.from;

  const markdownLinks = new RegExp(MARKDOWN_LINK.source, 'g');
  let markdownMatch: RegExpExecArray | null;
  while ((markdownMatch = markdownLinks.exec(line.text)) !== null) {
    const linkTextStart = markdownMatch.index + 1;
    const linkTextEnd = linkTextStart + markdownMatch[1].length;
    if (lineOffset >= linkTextStart && lineOffset <= linkTextEnd) {
      return normalizeUrl(markdownMatch[2]);
    }
  }

  const plainUrls = new RegExp(PLAIN_URL.source, 'g');
  let plainMatch: RegExpExecArray | null;
  while ((plainMatch = plainUrls.exec(line.text)) !== null) {
    const start = plainMatch.index;
    const end = start + plainMatch[0].length;
    if (lineOffset >= start && lineOffset <= end) return normalizeUrl(plainMatch[0]);
  }
  return null;
}

function buildAutolinkDecorations(view: EditorView): DecorationSet {
  const ranges: Array<{ from: number; to: number }> = [];
  const tree = syntaxTree(view.state);

  for (const visibleRange of view.visibleRanges) {
    const text = view.state.doc.sliceString(visibleRange.from, visibleRange.to);
    const markdownUrlRanges = findMarkdownUrlRanges(text, visibleRange.from);
    const plainUrls = new RegExp(PLAIN_URL.source, 'g');
    let match: RegExpExecArray | null;
    while ((match = plainUrls.exec(text)) !== null) {
      const from = visibleRange.from + match.index;
      const to = from + match[0].length;
      if (markdownUrlRanges.some(([start, end]) => from >= start && from < end)) continue;
      if (isCodePosition(tree, from)) continue;
      ranges.push({ from, to });
    }
  }

  return Decoration.set(
    ranges.map(({ from, to }) =>
      Decoration.mark({ class: 'cm-md-link cm-md-autolink' }).range(from, to),
    ),
    true,
  );
}

function findMarkdownUrlRanges(text: string, offset: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const links = new RegExp(MARKDOWN_LINK.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = links.exec(text)) !== null) {
    const start = match.index + match[0].indexOf('](') + 2;
    ranges.push([offset + start, offset + match.index + match[0].length - 1]);
  }
  return ranges;
}

function isCodePosition(tree: ReturnType<typeof syntaxTree>, position: number): boolean {
  let insideCode = false;
  tree.iterate({
    from: position,
    to: position + 1,
    enter: (node) => {
      if (/^(InlineCode|FencedCode|CodeBlock)$/.test(node.name)) insideCode = true;
    },
  });
  return insideCode;
}

function normalizeUrl(url: string): string {
  return url.startsWith('www.') ? `https://${url}` : url;
}
