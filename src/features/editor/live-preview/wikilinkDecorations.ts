import { syntaxTree } from '@codemirror/language';
import type { Text } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

import { getAllNotes } from '$features/notes/notes.svelte';

import { resolveWikilink, shortestUniqueSuffix, WIKILINK_RE } from '$shared/note/wikilinks';
import type { PendingDecoration } from './decorationTypes';
import { isCodeNode } from './markdownNodes';
import { selectionTouchesRange } from './selectionReveal';
import { WikilinkDisplayWidget } from './widgets';

export interface MarkdownRange {
  from: number;
  to: number;
}

export function collectWikilinkRanges(doc: Text): MarkdownRange[] {
  const ranges: MarkdownRange[] = [];
  const regex = new RegExp(WIKILINK_RE.source, 'g');
  for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber += 1) {
    const line = doc.line(lineNumber);
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(line.text)) !== null) {
      ranges.push({ from: line.from + match.index, to: line.from + match.index + match[0].length });
    }
  }
  return ranges;
}

export function isInsideWikilink(ranges: MarkdownRange[], from: number, to: number): boolean {
  return ranges.some((range) => range.from <= from && to <= range.to);
}

export function addWikilinkDecorations(view: EditorView, decorations: PendingDecoration[]): void {
  const doc = view.state.doc;
  const tree = syntaxTree(view.state);
  const regex = new RegExp(WIKILINK_RE.source, 'g');
  const allNoteIds = getAllNotes().map((note) => note.id);

  for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber += 1) {
    const line = doc.line(lineNumber);
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(line.text)) !== null) {
      const from = line.from + match.index;
      const to = from + match[0].length;
      const title = match[1];
      const reveal = selectionTouchesRange(view.hasFocus, view.state.selection.ranges, from, to);

      let isInCode = false;
      tree.iterate({
        from,
        to: from + 1,
        enter: (node) => {
          if (isCodeNode(node.name)) isInCode = true;
        },
      });
      if (isInCode) continue;

      const resolvedId = resolveWikilink(title, allNoteIds);
      const displayText = resolvedId ? shortestUniqueSuffix(resolvedId, allNoteIds) : title;
      const isBroken = resolvedId === null;
      if (!reveal) {
        decorations.push({ from, to: from + 2, value: { replace: true } });
        decorations.push({ from: to - 2, to, value: { replace: true } });
        if (displayText !== title) {
          decorations.push({
            from: from + 2,
            to: to - 2,
            value: { widget: new WikilinkDisplayWidget(displayText, title, isBroken) },
          });
          continue;
        }
      }

      decorations.push({
        from: from + 2,
        to: to - 2,
        value: {
          class: isBroken
            ? 'cm-md-link cm-md-wikilink cm-md-wikilink-broken'
            : 'cm-md-link cm-md-wikilink',
          attributes: { 'data-wikilink': title },
        },
      });
    }
  }
}
