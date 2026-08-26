// @vitest-environment jsdom

import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';

import {
  closeFind,
  findScrollMargin,
  findState,
  openFind,
  scanFindResults,
  setFindOverlayInset,
  setFindQuery,
  stepFind,
} from './findState';

const views: EditorView[] = [];

function setup(doc = 'cat dog CAT', selection = EditorSelection.cursor(0)): EditorView {
  const view = new EditorView({
    state: EditorState.create({ doc, selection, extensions: [findState] }),
  });
  views.push(view);
  return view;
}

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
});

describe('find state commands', () => {
  it('opens with a non-empty selection as its query', () => {
    const view = setup('one CAT two cat', EditorSelection.single(4, 7));

    openFind(view);

    expect(view.state.field(findState)).toMatchObject({
      open: true,
      query: 'CAT',
      currentIndex: 0,
      anchor: 4,
      matches: [
        { from: 4, to: 7 },
        { from: 12, to: 15 },
      ],
    });
  });

  it('retains the previous query across close and clears active results', () => {
    const view = setup();
    openFind(view);
    setFindQuery(view, 'cat');
    scanFindResults(view, true);
    closeFind(view);

    expect(view.state.field(findState)).toEqual({
      open: false,
      query: 'cat',
      matches: [],
      currentIndex: -1,
      anchor: 0,
      returnSelection: null,
      returnScroll: null,
      bottomOverlayPx: 0,
    });

    openFind(view);
    expect(view.state.field(findState).query).toBe('cat');
  });

  it('restores the selection from before native find opened', () => {
    const view = setup('start cat middle CAT end', EditorSelection.cursor(2));
    openFind(view);
    setFindQuery(view, 'cat');
    scanFindResults(view, true);
    stepFind(view, 1);
    expect(view.state.selection.main.from).toBe(17);

    closeFind(view, false, true);

    expect(view.state.selection.main).toEqual(EditorSelection.cursor(2));
  });

  it('steps, wraps, and does nothing while closed or with no matches', () => {
    const view = setup();
    expect(stepFind(view, 1)).toBe(false);

    openFind(view);
    setFindQuery(view, 'cat');
    scanFindResults(view, true);
    expect(view.state.selection.main.from).toBe(0);
    expect(stepFind(view, 1)).toBe(true);
    expect(view.state.selection.main.from).toBe(8);
    expect(stepFind(view, 1)).toBe(true);
    expect(view.state.selection.main.from).toBe(0);
    expect(stepFind(view, -1)).toBe(true);
    expect(view.state.selection.main.from).toBe(8);

    setFindQuery(view, 'missing');
    expect(stepFind(view, 1)).toBe(false);
    expect(view.state.selection.main.from).toBe(8);
  });

  it('steps from a body caret without skipping the nearest match', () => {
    const view = setup('cat dog CAT fox cat', EditorSelection.cursor(5));
    openFind(view);
    setFindQuery(view, 'cat');

    expect(stepFind(view, 1)).toBe(true);
    expect(view.state.selection.main.from).toBe(8);

    view.dispatch({ selection: EditorSelection.cursor(15) });
    expect(stepFind(view, -1)).toBe(true);
    expect(view.state.selection.main.from).toBe(8);
  });

  it('clears computed results until a document edit is rescanned', () => {
    const view = setup();
    openFind(view);
    setFindQuery(view, 'cat');
    scanFindResults(view, true);
    view.dispatch({ changes: { from: 0, to: 3, insert: 'fox' } });

    expect(view.state.field(findState)).toMatchObject({ matches: [], currentIndex: -1 });
    scanFindResults(view, false);
    expect(view.state.field(findState).matches).toEqual([{ from: 8, to: 11 }]);
  });
});

describe('host overlay inset (docs/spec/editor.md — the current match is always visible)', () => {
  it('reports no scroll margin until a host declares an overlay', () => {
    const view = setup();
    expect(findScrollMargin(view)).toBeNull();

    openFind(view);
    expect(findScrollMargin(view)).toBeNull();
  });

  it('keeps the declared overlay out of the reveal area while find is open', () => {
    const view = setup();
    openFind(view);

    expect(setFindOverlayInset(view, 62)).toBe(true);
    expect(findScrollMargin(view)).toEqual({ bottom: 62 });
  });

  it('latches the overlay across close so the next open reveals correctly', () => {
    const view = setup();
    openFind(view);
    setFindOverlayInset(view, 62);
    closeFind(view);

    // Closed: the margin is inert, but the measured height is remembered — the
    // host's bar does not change size between opens, so it never re-reports.
    expect(findScrollMargin(view)).toBeNull();
    expect(view.state.field(findState).bottomOverlayPx).toBe(62);

    openFind(view);
    expect(findScrollMargin(view)).toEqual({ bottom: 62 });
  });

  it('ignores a repeat of the height it already holds', () => {
    const view = setup();
    openFind(view);
    setFindOverlayInset(view, 62);

    expect(setFindOverlayInset(view, 62)).toBe(false);
  });

  // Desktop declares nothing: its bar is the engine's own panel, docked over
  // the pane's scrollport, so the margin comes from measuring that panel.
  // jsdom reports no scrollable ancestor, so the scrollport is the window.
  function panelAt(top: number, height: number): HTMLElement {
    const panel = document.createElement('div');
    panel.getBoundingClientRect = () =>
      ({ top, bottom: top + height, height }) as unknown as DOMRect;
    document.body.append(panel);
    return panel;
  }

  it('measures a local panel that covers the scrollport bottom', () => {
    const view = setup();
    openFind(view);
    const panel = panelAt(window.innerHeight - 44, 44);

    expect(findScrollMargin(view, panel)).toEqual({ bottom: 44 });
    panel.remove();
  });

  it('ignores a local panel laid out below the scrollport', () => {
    const view = setup();
    openFind(view);
    const panel = panelAt(window.innerHeight + 10, 44);

    expect(findScrollMargin(view, panel)).toBeNull();
    panel.remove();
  });

  it('takes the larger of the declared inset and the measured panel', () => {
    const view = setup();
    openFind(view);
    const panel = panelAt(window.innerHeight - 44, 44);

    setFindOverlayInset(view, 62);
    expect(findScrollMargin(view, panel)).toEqual({ bottom: 62 });

    setFindOverlayInset(view, 10);
    expect(findScrollMargin(view, panel)).toEqual({ bottom: 44 });
    panel.remove();
  });
});
