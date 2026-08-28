import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EditorState, type Transaction } from '@milkdown/kit/prose/state';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';

import { appendChunkContent, isEffectivelyEmpty, startProgressiveLoad } from './progressiveLoad';
import { testSchema as s } from './__fixtures__/schema';

function paragraph(text: string): ProseNode {
  return s.nodes.paragraph.create(null, text ? s.text(text) : null);
}

function doc(...children: ProseNode[]): ProseNode {
  return s.nodes.doc.create(null, children);
}

/** A stub view: the append only reads `state` and calls `dispatch`. */
function stubView(document: ProseNode) {
  const dispatched: Transaction[] = [];
  const state = EditorState.create({ doc: document });
  const view = {
    state,
    dispatch: (tr: Transaction) => dispatched.push(tr),
  } as unknown as ProseView;
  return { view, dispatched };
}

function topLevelText(node: ProseNode): string[] {
  const out: string[] = [];
  node.forEach((child) => out.push(child.textContent));
  return out;
}

describe('appendChunkContent', () => {
  it('appends the chunk at the end of the document', () => {
    const { view, dispatched } = stubView(doc(paragraph('a')));

    appendChunkContent(view, doc(paragraph('b'), paragraph('c')));

    expect(dispatched).toHaveLength(1);
    expect(topLevelText(dispatched[0].doc)).toEqual(['a', 'b', 'c']);
  });

  it('consumes the trailing placeholder paragraph instead of carrying it along', () => {
    // `trailing` parks an empty paragraph after a chunk that ends on a
    // non-paragraph node. Keeping it would leave the finished document one
    // empty paragraph longer than the same note parsed whole — an extra
    // trailing newline in the serialization.
    const { view, dispatched } = stubView(doc(paragraph('a'), paragraph('')));

    appendChunkContent(view, doc(paragraph('b')));

    expect(topLevelText(dispatched[0].doc)).toEqual(['a', 'b']);
  });

  it('keeps the append out of history — which also hides it from the listener', () => {
    // @milkdown/plugin-listener skips `addToHistory: false` transactions, so
    // this one flag is both "Ctrl-Z cannot un-load a chunk" and "a chunk append
    // never reaches the change notification".
    const { view, dispatched } = stubView(doc(paragraph('a')));

    appendChunkContent(view, doc(paragraph('b')));

    expect(dispatched[0].getMeta('addToHistory')).toBe(false);
  });

  it('dispatches nothing for an empty chunk', () => {
    const { view, dispatched } = stubView(doc(paragraph('a')));

    appendChunkContent(view, s.nodes.doc.create(null, []));

    expect(dispatched).toHaveLength(0);
  });

  it('leaves the selection where it was', () => {
    const { view, dispatched } = stubView(doc(paragraph('abc')));

    appendChunkContent(view, doc(paragraph('d')));

    expect(dispatched[0].selection.from).toBe(view.state.selection.from);
  });
});

describe('startProgressiveLoad', () => {
  let idleQueue: Array<() => void>;

  function scheduleIdle(run: () => void): () => void {
    idleQueue.push(run);
    return () => {
      idleQueue = idleQueue.filter((entry) => entry !== run);
    };
  }

  function drainIdle(): void {
    while (idleQueue.length > 0) idleQueue.shift()!();
  }

  beforeEach(() => {
    idleQueue = [];
  });

  it('applies the first chunk synchronously and defers the rest', () => {
    const applied: string[] = [];

    const load = startProgressiveLoad({
      chunks: ['one', 'two', 'three'],
      applyChunk: (md) => applied.push(md),
      scheduleIdle,
      onComplete: () => {},
    });

    expect(applied).toEqual(['one']);
    expect(load.loading).toBe(true);
  });

  it('streams the tail one chunk per idle slice and completes once', () => {
    const applied: string[] = [];
    const onComplete = vi.fn();

    const load = startProgressiveLoad({
      chunks: ['one', 'two', 'three'],
      applyChunk: (md) => applied.push(md),
      scheduleIdle,
      onComplete,
    });

    idleQueue.shift()!();
    expect(applied).toEqual(['one', 'two']);
    expect(onComplete).not.toHaveBeenCalled();

    drainIdle();
    expect(applied).toEqual(['one', 'two', 'three']);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(load.loading).toBe(false);
  });

  it('completes immediately for a single-chunk document', () => {
    const onComplete = vi.fn();

    const load = startProgressiveLoad({
      chunks: ['everything'],
      applyChunk: () => {},
      scheduleIdle,
      onComplete,
    });

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(load.loading).toBe(false);
    expect(idleQueue).toHaveLength(0);
  });

  it('finishNow applies every remaining chunk synchronously', () => {
    const applied: string[] = [];
    const onComplete = vi.fn();

    const load = startProgressiveLoad({
      chunks: ['one', 'two', 'three'],
      applyChunk: (md) => applied.push(md),
      scheduleIdle,
      onComplete,
    });

    load.finishNow();

    expect(applied).toEqual(['one', 'two', 'three']);
    expect(load.loading).toBe(false);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('finishNow cancels the pending idle slice so no chunk lands twice', () => {
    const applied: string[] = [];

    const load = startProgressiveLoad({
      chunks: ['one', 'two', 'three'],
      applyChunk: (md) => applied.push(md),
      scheduleIdle,
      onComplete: () => {},
    });

    load.finishNow();
    drainIdle();

    expect(applied).toEqual(['one', 'two', 'three']);
  });

  it('finishNow on an already-finished load is a no-op', () => {
    const onComplete = vi.fn();
    const load = startProgressiveLoad({
      chunks: ['one', 'two'],
      applyChunk: () => {},
      scheduleIdle,
      onComplete,
    });

    load.finishNow();
    load.finishNow();

    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('cancel stops the stream without completing', () => {
    const applied: string[] = [];
    const onComplete = vi.fn();

    const load = startProgressiveLoad({
      chunks: ['one', 'two', 'three'],
      applyChunk: (md) => applied.push(md),
      scheduleIdle,
      onComplete,
    });

    load.cancel();
    drainIdle();

    expect(applied).toEqual(['one']);
    expect(onComplete).not.toHaveBeenCalled();
    expect(load.loading).toBe(false);
  });

  it('finishNow after cancel does nothing — a cancelled load is abandoned, not resumed', () => {
    const applied: string[] = [];
    const onComplete = vi.fn();

    const load = startProgressiveLoad({
      chunks: ['one', 'two', 'three'],
      applyChunk: (md) => applied.push(md),
      scheduleIdle,
      onComplete,
    });

    load.cancel();
    load.finishNow();

    expect(applied).toEqual(['one']);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('reports progress so a caller can drive a loading affordance', () => {
    const load = startProgressiveLoad({
      chunks: ['one', 'two', 'three'],
      applyChunk: () => {},
      scheduleIdle,
      onComplete: () => {},
    });

    expect(load.appliedChunks).toBe(1);
    expect(load.totalChunks).toBe(3);

    idleQueue.shift()!();
    expect(load.appliedChunks).toBe(2);
  });
});

describe('isEffectivelyEmpty', () => {
  it('is true for a document with no content', () => {
    expect(isEffectivelyEmpty(s.nodes.doc.create(null, []))).toBe(true);
  });

  it('is true for a document of nothing but empty paragraphs', () => {
    expect(isEffectivelyEmpty(doc(paragraph(''), paragraph('')))).toBe(true);
  });

  it('is false as soon as anything carries content', () => {
    expect(isEffectivelyEmpty(doc(paragraph(''), paragraph('x')))).toBe(false);
  });

  it('is false for a non-paragraph block, even an empty one', () => {
    expect(isEffectivelyEmpty(s.nodes.doc.create(null, [s.nodes.horizontal_rule.create()]))).toBe(
      false,
    );
  });
});
