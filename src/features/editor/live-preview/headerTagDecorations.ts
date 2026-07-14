import { syntaxTree } from '@codemirror/language';
import type { Text } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

import { scanTags } from '$lib/rules';

import type { PendingDecoration } from './decorationTypes';
import { isCodeNode } from './markdownNodes';

const TAG_LINE_RE = /^\s*#[a-zA-Z][a-zA-Z0-9_-]{0,49}(\s+#[a-zA-Z][a-zA-Z0-9_-]{0,49})*\s*$/;

export function createHeaderTagDecorator() {
  let cachedDocument: Text | null = null;
  let cachedEndOffset = 0;

  function getHeaderEndOffset(doc: Text): number {
    if (doc === cachedDocument) return cachedEndOffset;

    let endLineNumber = 0;
    for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber += 1) {
      if (TAG_LINE_RE.test(doc.line(lineNumber).text)) endLineNumber = lineNumber;
      else break;
    }

    let offset = 0;
    if (endLineNumber > 0) {
      offset = doc.line(endLineNumber).to + 1;
      if (endLineNumber < doc.lines && doc.line(endLineNumber + 1).text.trim() === '') {
        offset = doc.line(endLineNumber + 1).to + 1;
      }
      offset = Math.min(offset, doc.length);
    }
    cachedDocument = doc;
    cachedEndOffset = offset;
    return offset;
  }

  function addInlineTagDecorations(view: EditorView, decorations: PendingDecoration[]): void {
    const doc = view.state.doc;
    const tree = syntaxTree(view.state);
    for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber += 1) {
      const line = doc.line(lineNumber);
      if (!line.text.includes('#')) continue;

      for (const match of scanTags(line.text)) {
        const from = line.from + match.start;
        const to = line.from + match.end;
        let isInCode = false;
        tree.iterate({
          from,
          to: from + 1,
          enter: (node) => {
            if (isCodeNode(node.name)) isInCode = true;
          },
        });
        if (isInCode) continue;

        decorations.push({
          from,
          to: from + 1,
          value: { class: 'cm-md-tag cm-md-tag-marker' },
        });
        if (to > from + 1) {
          decorations.push({
            from: from + 1,
            to,
            value: { class: 'cm-md-tag cm-md-tag-text' },
          });
        }
      }
    }
  }

  return { getHeaderEndOffset, addInlineTagDecorations };
}
