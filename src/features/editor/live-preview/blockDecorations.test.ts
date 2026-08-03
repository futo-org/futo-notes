// @vitest-environment jsdom
import { EditorView } from '@codemirror/view';
import { describe, expect, it, vi } from 'vitest';

import { decorateBlockQuote } from './blockDecorations';
import type { PendingDecoration } from './decorationTypes';

function decorateQuote(
  content: string,
  scanLineNumber?: number,
): {
  classes: string[];
  view: EditorView;
} {
  const view = new EditorView({ doc: content, parent: document.body });
  const decorations: PendingDecoration[] = [];
  const scanLine = view.state.doc.line(scanLineNumber ?? 1);
  const scanRange =
    scanLineNumber === undefined
      ? { from: 0, to: view.state.doc.length }
      : { from: scanLine.from, to: scanLine.to };

  decorateBlockQuote(0, view.state.doc.length, view, decorations, new Set<number>(), scanRange);

  return {
    classes: decorations
      .map((decoration) => decoration.value.class)
      .filter((cssClass): cssClass is string => cssClass?.startsWith('cm-md-quote ') === true),
    view,
  };
}

describe('blockquote endpoint decorations', () => {
  it('classifies the final marker line as last before a lazy continuation', () => {
    const { classes, view } = decorateQuote('> a\n> b\ncontinuation');

    expect(classes).toEqual([
      'cm-md-quote cm-md-quote-level-1 cm-md-quote-first',
      'cm-md-quote cm-md-quote-level-1 cm-md-quote-last',
    ]);
    view.destroy();
  });

  it('classifies one marker line plus a lazy continuation as single', () => {
    const { classes, view } = decorateQuote('> a\ncontinuation');

    expect(classes).toEqual(['cm-md-quote cm-md-quote-level-1 cm-md-quote-single']);
    view.destroy();
  });

  it('bounds endpoint classification with thousands of lazy continuation lines', () => {
    const lazyContinuationLineCount = 5000;
    const content = [
      '> first',
      ...Array.from(
        { length: lazyContinuationLineCount },
        (_, index) => `continuation ${index + 1}`,
      ),
    ].join('\n');
    const view = new EditorView({ doc: content, parent: document.body });
    const decorations: PendingDecoration[] = [];
    const visibleLine = view.state.doc.line(1);
    const line = vi.spyOn(view.state.doc, 'line');

    decorateBlockQuote(0, view.state.doc.length, view, decorations, new Set<number>(), {
      from: visibleLine.from,
      to: visibleLine.to,
    });

    expect(
      decorations
        .map((decoration) => decoration.value.class)
        .filter((cssClass): cssClass is string => cssClass?.startsWith('cm-md-quote ') === true),
    ).toEqual(['cm-md-quote cm-md-quote-level-1 cm-md-quote-single']);
    expect(line).toHaveBeenCalledTimes(4);
    view.destroy();
  });
});
