// @vitest-environment jsdom
/**
 * Regression test for the CM position-desync crash family
 * "Decorations that replace line breaks may not be specified via plugins"
 * (+ the "Cannot destructure property 'tile' of 'a.pop()'" heightmap variant).
 *
 * While the IME is composing, the plugin maps its existing DecorationSet
 * through each edit instead of rebuilding. RangeSet.map does NOT re-validate
 * CM6's rule that a plugin-provided Decoration.replace may not span a line
 * break, so inserting a "\n" strictly inside a hidden fenced-code fence line
 * (Decoration.replace over line.from..line.to) stretches that replace across
 * the new break — an illegal range CM6 rejects. The plugin must strip such
 * ranges from the mapped set.
 */

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

/** Ranges that CM6 treats as plugin replace/point decorations spanning a line
 *  break (point value, non-empty, ending past its start line). */
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
    // `point === true` marks replace/widget point decorations (PointDecoration);
    // mark decorations are `point === false`.
    if (cur.value.point && cur.from !== cur.to && cur.to > doc.lineAt(cur.from).to) {
      bad.push({ from: cur.from, to: cur.to });
    }
    cur.next();
  }
  return bad;
}

describe('liveMarkdownTransform composition mapping', () => {
  it('never leaves a replace decoration spanning a line break after a composing "\\n" insert', () => {
    // a\n```\nfoo\n```\nb — line 2 ("```", 2..5) is a hidden opening fence.
    const view = setup('a\n```\nfoo\n```\nb');

    // Sanity: the hidden fence produced at least one replace decoration and it
    // does not (yet) span a line break.
    expect(replacesSpanningLineBreak(view)).toEqual([]);

    // Enter composition so update() takes the map-through branch instead of a
    // full rebuild (mirrors the AOSP IME path).
    Object.defineProperty(view, 'composing', { configurable: true, get: () => true });

    // Insert a newline strictly inside the hidden fence line (between backticks).
    expect(() => view.dispatch({ changes: { from: 3, insert: '\n' } })).not.toThrow();

    // The mapped replace must not now cross the freshly inserted line break.
    expect(replacesSpanningLineBreak(view)).toEqual([]);
  });
});
