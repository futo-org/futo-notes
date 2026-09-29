import { describe, expect, it } from 'vitest';

import { EditorState, Plugin } from '@milkdown/kit/prose/state';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';

import { createDocumentChangePlugin, isReportableDocumentChange } from './documentChanges';
import { testSchema as s } from './__fixtures__/schema';

function paragraph(text: string): ProseNode {
  return s.nodes.paragraph.create(null, text ? s.text(text) : null);
}

function stateWith(...children: ProseNode[]): EditorState {
  return EditorState.create({ doc: s.nodes.doc.create(null, children) });
}

describe('isReportableDocumentChange', () => {
  it('reports a transaction that changed the document', () => {
    const state = stateWith(paragraph('a'));

    expect(isReportableDocumentChange(state.tr.insertText('b', 1))).toBe(true);
  });

  it('ignores a transaction that only moved the selection', () => {
    const state = stateWith(paragraph('abc'));

    expect(isReportableDocumentChange(state.tr.scrollIntoView())).toBe(false);
  });

  it('ignores a streamed chunk append', () => {
    // `addToHistory: false` is progressiveLoad.ts's marker for the editor's own
    // housekeeping. Those documents are a PREFIX of the note; reporting one is
    // how a slow open truncates a file.
    const state = stateWith(paragraph('a'));

    expect(
      isReportableDocumentChange(state.tr.insertText('b', 1).setMeta('addToHistory', false)),
    ).toBe(false);
  });
});

describe('createDocumentChangePlugin', () => {
  /** Applies `mutate` through a state carrying the plugin, as a dispatch would. */
  function apply(mutate: (state: EditorState) => EditorState['tr']): number {
    let calls = 0;
    const plugin = createDocumentChangePlugin(() => {
      calls += 1;
    });
    const state = EditorState.create({
      doc: s.nodes.doc.create(null, [paragraph('a')]),
      plugins: [plugin],
    });
    state.apply(mutate(state));
    return calls;
  }

  it('fires once for a document change', () => {
    expect(apply((state) => state.tr.insertText('b', 1))).toBe(1);
  });

  it('stays silent for a selection-only transaction', () => {
    expect(apply((state) => state.tr.scrollIntoView())).toBe(0);
  });

  it('stays silent for a chunk append', () => {
    expect(apply((state) => state.tr.insertText('b', 1).setMeta('addToHistory', false))).toBe(0);
  });

  /* `trailing` answers a load with a transaction of its own that carries no
   * marker. It is still part of the load, and the editor reads this signal as
   * "the user edited" (MilkdownEditor `editedSinceLoadStart`): calling it an
   * edit would rewrite every large note on open. */
  it("counts another plugin's reaction as part of what it reacted to", () => {
    function applyWithReaction(markAsLoad: boolean): number {
      let calls = 0;
      const reacts = new Plugin({
        appendTransaction: (transactions, _old, state) =>
          transactions.some((tr) => tr.getMeta('appendedTransaction') === undefined)
            ? state.tr.insertText('!', state.doc.content.size - 1)
            : null,
      });
      const state = EditorState.create({
        doc: s.nodes.doc.create(null, [paragraph('a')]),
        plugins: [reacts, createDocumentChangePlugin(() => (calls += 1))],
      });
      const tr = state.tr.insertText('b', 1);
      state.applyTransaction(markAsLoad ? tr.setMeta('addToHistory', false) : tr);
      return calls;
    }

    expect(applyWithReaction(true)).toBe(0);
    expect(applyWithReaction(false)).toBe(1);
  });
});
