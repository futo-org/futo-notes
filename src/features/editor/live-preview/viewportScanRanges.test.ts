// @vitest-environment jsdom
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { EditorState, Text } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, it, vi } from 'vitest';

import { createLiveMarkdownDecorationBuilder } from './buildLiveMarkdownDecorations';
import { getViewportScanRanges } from './viewportScanRanges';
import { collectWikilinkRanges } from './wikilinkDecorations';

describe('live preview viewport scan ranges', () => {
  it('extends visible ranges to line boundaries and merges adjacent lines', () => {
    const doc = Text.of(['zero', 'one', 'two', 'three', 'four']);
    const lineTwo = doc.line(2);
    const lineThree = doc.line(3);

    expect(
      getViewportScanRanges(doc, [
        { from: lineTwo.from + 1, to: lineTwo.to },
        { from: lineThree.from, to: lineThree.to - 1 },
      ]),
    ).toEqual([{ from: lineTwo.from, to: lineThree.to }]);
  });

  it('limits wikilink collection to the expanded viewport lines', () => {
    const doc = Text.of([
      'outside [[before]]',
      'visible start [[one]]',
      'visible end [[two]]',
      'outside [[after]]',
    ]);
    const visibleStart = doc.line(2);
    const visibleEnd = doc.line(3);
    const scanRanges = getViewportScanRanges(doc, [
      { from: visibleStart.from + 4, to: visibleEnd.to - 4 },
    ]);

    expect(collectWikilinkRanges(doc, scanRanges)).toEqual([
      { from: visibleStart.from + 14, to: visibleStart.from + 21 },
      { from: visibleEnd.from + 12, to: visibleEnd.from + 19 },
    ]);
  });

  it('bounds syntax-tree traversal to the viewport line range', () => {
    const state = EditorState.create({
      doc: ['outside before', 'visible content', 'outside after'].join('\n'),
      extensions: [markdown()],
    });
    ensureSyntaxTree(state, state.doc.length, 500);
    const view = new EditorView({ state, parent: document.body });
    const visibleLine = state.doc.line(2);
    Object.defineProperty(view, 'visibleRanges', {
      configurable: true,
      value: [{ from: visibleLine.from + 2, to: visibleLine.to - 2 }],
    });
    const tree = syntaxTree(view.state);
    const iterate = vi.spyOn(tree, 'iterate');
    const sliceString = vi.spyOn(state.doc, 'sliceString');

    createLiveMarkdownDecorationBuilder()(view);

    expect(iterate).toHaveBeenCalledOnce();
    expect(iterate.mock.calls[0][0]).toMatchObject({
      from: visibleLine.from,
      to: visibleLine.to,
    });
    expect(sliceString.mock.calls.some(([from, to]) => from === 0 && to === state.doc.length)).toBe(
      false,
    );
    view.destroy();
  });

  it('bounds decorations for a spanning blockquote to visible lines', () => {
    const state = EditorState.create({
      doc: Array.from({ length: 1000 }, (_, index) => `> quote ${index + 1}`).join('\n'),
      extensions: [markdown()],
    });
    ensureSyntaxTree(state, state.doc.length, 1000);
    const view = new EditorView({ state, parent: document.body });
    const visibleLine = state.doc.line(500);
    Object.defineProperty(view, 'visibleRanges', {
      configurable: true,
      value: [{ from: visibleLine.from, to: visibleLine.to }],
    });

    const decorations = createLiveMarkdownDecorationBuilder()(view);
    const cursor = decorations.iter();
    let decoratedQuoteLines = 0;
    while (cursor.value) {
      if (cursor.value.spec.class?.includes('cm-md-quote ')) decoratedQuoteLines += 1;
      cursor.next();
    }

    expect(decoratedQuoteLines).toBe(1);
    view.destroy();
  });

  it('bounds decorations for a spanning code block to visible lines', () => {
    const state = EditorState.create({
      doc: [
        '```ts',
        ...Array.from({ length: 1000 }, (_, index) => `code ${index + 1}`),
        '```',
      ].join('\n'),
      extensions: [markdown()],
    });
    ensureSyntaxTree(state, state.doc.length, 1000);
    const view = new EditorView({ state, parent: document.body });
    const visibleLine = state.doc.line(500);
    Object.defineProperty(view, 'visibleRanges', {
      configurable: true,
      value: [{ from: visibleLine.from, to: visibleLine.to }],
    });

    const decorations = createLiveMarkdownDecorationBuilder()(view);
    const cursor = decorations.iter();
    let decoratedCodeLines = 0;
    while (cursor.value) {
      if (cursor.value.spec.class?.includes('cm-md-code-block')) decoratedCodeLines += 1;
      cursor.next();
    }

    expect(decoratedCodeLines).toBe(1);
    view.destroy();
  });
});
