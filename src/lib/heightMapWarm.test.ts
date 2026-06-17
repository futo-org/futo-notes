// @vitest-environment jsdom
/**
 * Unit tests for warmHeightMap. jsdom has no real layout (every line measures
 * 0px), so we can't assert the px growth here — that's verified on-device via
 * the iOS scroll probe (window.__scrollDiag). What we DO guard here is the
 * control flow that a regression would most likely break:
 *   - it terminates (the viewport-tiling loop must always make forward progress);
 *   - it leaves the document and selection untouched (warming must be invisible);
 *   - it restores the scroll position.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { EditorView } from '@codemirror/view';
import { EditorState, EditorSelection } from '@codemirror/state';
import { warmHeightMap } from './heightMapWarm';

// warmHeightMap is fully synchronous. CM6, however, schedules its own measure on
// requestAnimationFrame after each dispatch; in jsdom that deferred measure hits
// the missing Range geometry and throws asynchronously. Neutralize rAF for these
// tests so only our (stubbed) synchronous measure path runs.
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
  // jsdom has no real text geometry (Range#getClientRects is absent), so CM6's
  // synchronous measure() throws. Stub it: the warm loop still drives
  // scrollIntoView + lineBlockAtHeight against the estimate-based height map,
  // which is all these control-flow invariants need.
  vi.spyOn(view as unknown as { measure: () => void }, 'measure').mockImplementation(() => {});
  return view;
}

describe('warmHeightMap', () => {
  it('terminates and returns a sane {grew, steps} on a long doc', () => {
    const view = makeView('paragraph of text\n'.repeat(300));
    const result = warmHeightMap(view);
    expect(result).not.toBeNull();
    expect(result.steps).toBeGreaterThanOrEqual(1);
    // Bounded by the safety cap — i.e. it returns, never hangs. (Real-world fast
    // termination — ~15 steps for a 10k-px doc — is verified on-device via the
    // scroll probe; jsdom's stubbed measure can't advance the viewport, so it
    // legitimately walks to the cap here.)
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
    // scrollIntoView effects must not move the selection.
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
      set: (v: number) => { scrollTopVal = v; },
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
