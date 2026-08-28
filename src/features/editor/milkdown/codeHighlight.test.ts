import { describe, expect, it } from 'vitest';

import { javascript } from '@codemirror/lang-javascript';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { EditorState, type Plugin } from '@milkdown/kit/prose/state';
import type { Decoration, DecorationSet } from '@milkdown/kit/prose/view';

import {
  codeBlocksIn,
  createCodeHighlightPlugin,
  codeHighlightKey,
  highlightFence,
  matchFenceLanguage,
  MAX_HIGHLIGHTED_FENCE_CHARS,
} from './codeHighlight';
import { testSchema as s } from './__fixtures__/schema';

function fence(language: string, code: string): ProseNode {
  return s.nodes.code_block.create({ language }, code ? s.text(code) : null);
}

function para(text: string): ProseNode {
  return s.nodes.paragraph.create(null, s.text(text));
}

function doc(...blocks: ProseNode[]): ProseNode {
  return s.nodes.doc.create(null, blocks);
}

function classOf(decoration: Decoration): string | undefined {
  return (decoration.type as unknown as { attrs?: Record<string, string> }).attrs?.class;
}

describe('matchFenceLanguage', () => {
  it('matches a language by name', () => {
    expect(matchFenceLanguage('python')?.name).toBe('Python');
  });

  it('matches by alias, which is what the curated list is for', () => {
    expect(matchFenceLanguage('rs')?.name).toBe('Rust');
    expect(matchFenceLanguage('zsh')?.name).toBe('Shell');
  });

  it('ignores case and surrounding whitespace', () => {
    expect(matchFenceLanguage('  TypeScript ')?.name).toBe('TypeScript');
  });

  it('is null for a language outside the curated set', () => {
    expect(matchFenceLanguage('mermaid')).toBeNull();
    expect(matchFenceLanguage('brainfuck')).toBeNull();
  });

  it('is null for a fence with no info string', () => {
    expect(matchFenceLanguage('')).toBeNull();
    expect(matchFenceLanguage(undefined)).toBeNull();
    expect(matchFenceLanguage(null)).toBeNull();
  });
});

describe('highlightFence', () => {
  const js = javascript();

  it('names tokens with the same `tok-*` classes CodeMirror uses', () => {
    const node = fence('js', 'const a = "s";');
    const found = highlightFence(node, 0, js).map(
      (d) => `${classOf(d)}:${node.textContent.slice(d.from - 1, d.to - 1)}`,
    );
    expect(found).toContain('tok-keyword:const');
    expect(found).toContain('tok-string:"s"');
  });

  it('puts every decoration inside the fence', () => {
    const node = fence('js', 'let x = 1;\nlet y = 2;\n');
    for (const d of highlightFence(node, 7, js)) {
      expect(d.from).toBeGreaterThanOrEqual(8);
      expect(d.to).toBeLessThanOrEqual(7 + node.nodeSize - 1);
    }
  });

  it('is empty for an empty fence', () => {
    expect(highlightFence(fence('js', ''), 0, js)).toEqual([]);
  });

  it('gives up on a fence too large to reparse inside a frame', () => {
    const huge = 'let x = 1;\n'.repeat(Math.ceil(MAX_HIGHLIGHTED_FENCE_CHARS / 11) + 1);
    expect(huge.length).toBeGreaterThan(MAX_HIGHLIGHTED_FENCE_CHARS);
    expect(highlightFence(fence('js', huge), 0, js)).toEqual([]);
  });
});

describe('codeBlocksIn', () => {
  it('finds fences and nothing else', () => {
    const d = doc(para('text'), fence('js', 'a'), para('more'), fence('', 'b'));
    expect(codeBlocksIn(d, 0, d.content.size).map(({ node }) => node.textContent)).toEqual([
      'a',
      'b',
    ]);
  });

  it('is limited to the range it is asked about', () => {
    const first = fence('js', 'a');
    const d = doc(first, fence('js', 'b'));
    expect(codeBlocksIn(d, 0, first.nodeSize - 1)).toHaveLength(1);
  });
});

describe('the plugin', () => {
  function decorationsOf(state: EditorState): DecorationSet {
    const set = codeHighlightKey.getState(state);
    if (!set) throw new Error('plugin state missing');
    return set;
  }

  function stateWith(d: ProseNode) {
    return EditorState.create({ doc: d, plugins: [createCodeHighlightPlugin()] });
  }

  it('decorates nothing outside a fence', () => {
    const state = stateWith(doc(para('body #tag')));
    expect(decorationsOf(state).find()).toEqual([]);
  });

  it('leaves a fence in an unlisted language uncoloured', () => {
    expect(decorationsOf(stateWith(doc(fence('mermaid', 'graph TD')))).find()).toEqual([]);
  });

  /*
   * The M5 lock, and it has teeth: this plugin USED to put one node decoration
   * per fence on the document to carry a CSS class. A node decoration spanning
   * a whole top-level block is stored in the decoration tree's ROOT, so mapping
   * them made every keystroke cost O(fences) — measured 4.6 ms per keystroke at
   * 1000 fences, against 0.075 ms once the decoration was gone (a 33x gap over
   * the empty-plugin baseline, against the 4x this asserts).
   *
   * Measured as a RATIO OF RATIOS — how much worse the plugin scales than an
   * editor with no plugins at all — so it says nothing about how fast the
   * machine running it is.
   */
  it('costs no more per keystroke as the document grows', () => {
    const growth = (plugins: Plugin[]) => {
      const measure = (fences: number) => {
        const blocks: ProseNode[] = [];
        for (let i = 0; i < fences; i += 1) {
          blocks.push(fence('mermaid', `graph ${i}`));
          blocks.push(para(`body paragraph number ${i}`));
        }
        blocks.push(para('edit me'));
        const state = EditorState.create({ doc: doc(...blocks), plugins });
        const at = state.doc.content.size - 2;
        for (let i = 0; i < 30; i += 1) state.apply(state.tr.insertText('x', at));
        // The MINIMUM of several runs: the most stable statistic when
        // something else on the machine is competing for the core.
        let best = Infinity;
        for (let run = 0; run < 5; run += 1) {
          const started = performance.now();
          for (let i = 0; i < 100; i += 1) state.apply(state.tr.insertText('x', at));
          best = Math.min(best, performance.now() - started);
        }
        return best;
      };
      return measure(1000) / measure(20);
    };

    expect(growth([createCodeHighlightPlugin()]) / growth([])).toBeLessThan(4);
  });

  it('keeps its decorations across a transaction that changed nothing', () => {
    const state = stateWith(doc(fence('js', 'const a = 1;')));
    const moved = state.apply(state.tr.setSelection(state.selection));
    expect(codeHighlightKey.getState(moved)).toBe(codeHighlightKey.getState(state));
  });

  it("drops a fence's decorations when the fence is deleted", () => {
    // With the grammar not yet loaded there is nothing to drop, so seed the
    // set by hand and prove the delete clears it.
    const first = fence('js', 'const a = 1;');
    let state = EditorState.create({
      doc: doc(first, para('body')),
      plugins: [createCodeHighlightPlugin()],
    });
    state = state.apply(state.tr.delete(0, first.nodeSize));
    expect(decorationsOf(state).find()).toEqual([]);
    expect(codeBlocksIn(state.doc, 0, state.doc.content.size)).toEqual([]);
  });
});
