// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { liveMarkdownTransform } from './liveMarkdownTransform';

const views: EditorView[] = [];

afterEach(() => {
  for (const v of views) v.destroy();
  views.length = 0;
});

function setup(doc: string): EditorView {
  const view = new EditorView({
    doc,
    extensions: [markdown(), liveMarkdownTransform],
    parent: document.body,
  });
  views.push(view);
  return view;
}

function replacesSpanningLineBreak(view: EditorView): Array<{ from: number; to: number }> {
  const plugin = view.plugin(liveMarkdownTransform) as unknown as {
    decorations: {
      iter: () => { value: { point: boolean } | null; from: number; to: number; next: () => void };
    };
  };
  if (!plugin) throw new Error('liveMarkdownTransform plugin not found');
  const doc = view.state.doc;
  const bad: Array<{ from: number; to: number }> = [];
  const cur = plugin.decorations.iter();
  while (cur.value) {
    if (cur.value.point && cur.from !== cur.to && cur.to > doc.lineAt(cur.from).to) {
      bad.push({ from: cur.from, to: cur.to });
    }
    cur.next();
  }
  return bad;
}

describe('liveMarkdownTransform composition mapping', () => {
  it('never leaves a replace decoration spanning a line break after a composing "\\n" insert', () => {
    const view = setup('a\n```\nfoo\n```\nb');

    expect(replacesSpanningLineBreak(view)).toEqual([]);

    Object.defineProperty(view, 'composing', { configurable: true, get: () => true });

    expect(() => view.dispatch({ changes: { from: 3, insert: '\n' } })).not.toThrow();

    expect(replacesSpanningLineBreak(view)).toEqual([]);
  });
});
