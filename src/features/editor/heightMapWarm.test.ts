// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { EditorView } from '@codemirror/view';
import { EditorState, EditorSelection } from '@codemirror/state';
import { warmHeightMap } from './heightMapWarm';

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function makeView(doc: string, selectionHead = 0): EditorView {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.single(selectionHead),
      extensions: [EditorView.lineWrapping],
    }),
    parent: container,
  });
  vi.spyOn(view as unknown as { measure: () => void }, 'measure').mockImplementation(() => {});
  return view;
}

describe('warmHeightMap', () => {
  it('terminates and returns a sane {grew, steps} on a long doc', () => {
    const view = makeView('paragraph of text\n'.repeat(300));
    const result = warmHeightMap(view);
    expect(result).not.toBeNull();
    expect(result.steps).toBeGreaterThanOrEqual(1);
    expect(result.steps).toBeLessThanOrEqual(400);
    expect(Number.isFinite(result.grew)).toBe(true);
    view.destroy();
  });

  it('leaves the document and selection unchanged', () => {
    const doc = 'one\ntwo\nthree\n'.repeat(50);
    const view = makeView(doc, 42);
    const before = view.state.selection.main;
    warmHeightMap(view);
    expect(view.state.doc.toString()).toBe(doc);
    expect(view.state.selection.main.head).toBe(before.head);
    expect(view.state.selection.main.anchor).toBe(before.anchor);
    view.destroy();
  });

  it('restores the original scroll position', () => {
    const view = makeView('line\n'.repeat(200));
    let scrollTopVal = 73;
    Object.defineProperty(view.scrollDOM, 'scrollTop', {
      configurable: true,
      get: () => scrollTopVal,
      set: (v: number) => {
        scrollTopVal = v;
      },
    });
    warmHeightMap(view);
    expect(scrollTopVal).toBe(73);
    view.destroy();
  });

  it('handles an empty document without looping', () => {
    const view = makeView('');
    const result = warmHeightMap(view);
    expect(result.steps).toBeGreaterThanOrEqual(1);
    expect(result.steps).toBeLessThan(400);
    view.destroy();
  });
});
