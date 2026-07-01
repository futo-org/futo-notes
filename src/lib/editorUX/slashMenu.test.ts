// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { EditorView } from '@codemirror/view';
import { EditorSelection } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import {
  slashMenu,
  slashMenuField,
  getSlashQuery,
  openSlashMenuEffect,
  closeSlashMenuEffect,
  computeMenuPlacement,
  shouldShowBlockHandle,
  blockHandle,
} from './slashMenu';

describe('computeMenuPlacement', () => {
  const viewport = { width: 1000, height: 800 };
  const menuSize = { width: 240, height: 300 };

  it('places below the anchor when there is room', () => {
    const anchor = { top: 100, bottom: 116, left: 50 };
    const p = computeMenuPlacement(anchor, menuSize, viewport);
    expect(p.top).toBe(120); // bottom + 4
    expect(p.left).toBe(50);
  });

  it('flips above when there is no room below', () => {
    // anchor near bottom: only 100px below, but 700px above → should flip
    const anchor = { top: 700, bottom: 716, left: 50 };
    const p = computeMenuPlacement(anchor, menuSize, viewport);
    expect(p.top).toBe(700 - 300 - 4); // above with gap
  });

  it('does not flip when below space is tight but above space is also tight', () => {
    // Menu is 300px tall, viewport 800 — neither fits cleanly; prefer below
    const anchor = { top: 250, bottom: 266, left: 50 };
    const p = computeMenuPlacement(anchor, menuSize, viewport);
    // spaceBelow=534, enough for 300 — places below
    expect(p.top).toBe(270);
  });

  it('clamps left so the menu never overflows the right edge', () => {
    const anchor = { top: 100, bottom: 116, left: 900 };
    const p = computeMenuPlacement(anchor, menuSize, viewport);
    // maxLeft = 1000 - 240 - 8 = 752
    expect(p.left).toBe(752);
  });

  it('clamps to left margin when anchor is negative', () => {
    const anchor = { top: 100, bottom: 116, left: -50 };
    const p = computeMenuPlacement(anchor, menuSize, viewport);
    expect(p.left).toBe(8);
  });
});

const views: EditorView[] = [];

afterEach(() => {
  for (const v of views) v.destroy();
  views.length = 0;
});

function setup(doc: string, anchor = doc.length): EditorView {
  const view = new EditorView({
    doc,
    selection: { anchor },
    extensions: [markdown(), slashMenu],
    parent: document.body,
  });
  views.push(view);
  return view;
}

function typeChar(view: EditorView, ch: string): void {
  const { from, to } = view.state.selection.main;
  // Go through inputHandler path
  // CM6's EditorView exposes this via `dispatch` with userEvent but the inputHandler
  // runs when invoked via `view.someInput` — simplest path: directly invoke the
  // inputHandler facet. But easier: dispatch with a plain change AND rely on
  // inputHandler by simulating via the state.
  // For unit tests we just call the exposed helper shape: dispatch a change +
  // manually fire the open effect when we want to simulate the trigger.
  view.dispatch({
    changes: { from, to, insert: ch },
    selection: EditorSelection.cursor(from + ch.length),
    userEvent: 'input.type',
  });
}

function isOpen(view: EditorView): boolean {
  return view.state.field(slashMenuField, false)?.open === true;
}

describe('shouldShowBlockHandle', () => {
  it('shows on an empty block with a caret', () => {
    const v = setup('', 0);
    expect(shouldShowBlockHandle(v.state)).toBe(true);
  });
  it('shows on a whitespace-only line', () => {
    const v = setup('   ', 3);
    expect(shouldShowBlockHandle(v.state)).toBe(true);
  });
  it('hides on a non-empty line', () => {
    const v = setup('hello', 5);
    expect(shouldShowBlockHandle(v.state)).toBe(false);
  });
  it('hides when the slash menu is open', () => {
    const v = setup('');
    v.dispatch({
      changes: { from: 0, insert: '/' },
      selection: EditorSelection.cursor(1),
      effects: openSlashMenuEffect.of({ from: 0 }),
    });
    expect(shouldShowBlockHandle(v.state)).toBe(false);
  });
  it('hides on a range (non-empty) selection', () => {
    const v = setup('    ', 0); // whitespace-only line
    v.dispatch({ selection: EditorSelection.range(0, 2) });
    expect(shouldShowBlockHandle(v.state)).toBe(false);
  });
});

// The `+` block handle is a desktop affordance (editor.md). shouldShowBlockHandle
// (above) is the visibility predicate; this exercises the click→trigger DOM path
// that the plugin actually wires up.
function setupWithHandle(doc: string, anchor = doc.length): EditorView {
  const view = new EditorView({
    doc,
    selection: { anchor },
    extensions: [markdown(), slashMenu, blockHandle],
    parent: document.body,
  });
  views.push(view);
  return view;
}

describe('blockHandle click (editor.md)', () => {
  it('inserts `/` and opens the slash menu when clicked on an empty block', () => {
    const v = setupWithHandle('');
    const btn = v.dom.querySelector('.sf-block-handle') as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    btn!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(v.state.doc.toString()).toBe('/');
    expect(v.state.selection.main.head).toBe(1);
    expect(isOpen(v)).toBe(true);
  });

  it('does nothing when clicked on a non-empty block', () => {
    const v = setupWithHandle('hello', 5);
    const btn = v.dom.querySelector('.sf-block-handle') as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    btn!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(v.state.doc.toString()).toBe('hello');
    expect(isOpen(v)).toBe(false);
  });

  it('is a no-op when the slash menu is already open', () => {
    const v = setupWithHandle('');
    v.dispatch({
      changes: { from: 0, insert: '/' },
      selection: EditorSelection.cursor(1),
      effects: openSlashMenuEffect.of({ from: 0 }),
    });
    const btn = v.dom.querySelector('.sf-block-handle') as HTMLButtonElement | null;
    btn!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    // Still exactly one `/` — the handle didn't insert a second.
    expect(v.state.doc.toString()).toBe('/');
  });
});

describe('slashMenuField', () => {
  it('opens when effect is dispatched', () => {
    const v = setup('');
    expect(isOpen(v)).toBe(false);
    v.dispatch({
      changes: { from: 0, insert: '/' },
      selection: EditorSelection.cursor(1),
      effects: openSlashMenuEffect.of({ from: 0 }),
    });
    expect(isOpen(v)).toBe(true);
    expect(getSlashQuery(v.state)).toBe('');
  });

  it('tracks query as user types after slash', () => {
    const v = setup('');
    v.dispatch({
      changes: { from: 0, insert: '/' },
      selection: EditorSelection.cursor(1),
      effects: openSlashMenuEffect.of({ from: 0 }),
    });
    typeChar(v, 'h');
    typeChar(v, 'e');
    typeChar(v, 'a');
    expect(getSlashQuery(v.state)).toBe('hea');
    expect(isOpen(v)).toBe(true);
  });

  it('closes when cursor moves before the slash', () => {
    const v = setup('');
    v.dispatch({
      changes: { from: 0, insert: '/a' },
      selection: EditorSelection.cursor(2),
      effects: openSlashMenuEffect.of({ from: 0 }),
    });
    expect(isOpen(v)).toBe(true);
    v.dispatch({ selection: EditorSelection.cursor(0) });
    expect(isOpen(v)).toBe(false);
  });

  it('closes when the slash character is deleted', () => {
    const v = setup('');
    v.dispatch({
      changes: { from: 0, insert: '/' },
      selection: EditorSelection.cursor(1),
      effects: openSlashMenuEffect.of({ from: 0 }),
    });
    v.dispatch({
      changes: { from: 0, to: 1, insert: '' },
      selection: EditorSelection.cursor(0),
    });
    expect(isOpen(v)).toBe(false);
  });

  it('closes via explicit effect', () => {
    const v = setup('');
    v.dispatch({
      changes: { from: 0, insert: '/' },
      selection: EditorSelection.cursor(1),
      effects: openSlashMenuEffect.of({ from: 0 }),
    });
    v.dispatch({ effects: closeSlashMenuEffect.of() });
    expect(isOpen(v)).toBe(false);
  });
});

describe('inputHandler trigger', () => {
  it('opens when `/` is typed on an empty line', () => {
    const v = setup('');
    // Call the inputHandler facet directly
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const facet = (v.state as any).facet(EditorView.inputHandler);
    const handlers = facet as Array<(v: EditorView, from: number, to: number, text: string) => boolean>;
    const handled = handlers.some((h) => h(v, 0, 0, '/'));
    expect(handled).toBe(true);
    expect(isOpen(v)).toBe(true);
    expect(v.state.doc.toString()).toBe('/');
  });

  it('does not open mid-line', () => {
    const v = setup('hello', 5);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const facet = (v.state as any).facet(EditorView.inputHandler);
    const handlers = facet as Array<(v: EditorView, from: number, to: number, text: string) => boolean>;
    const handled = handlers.some((h) => h(v, 5, 5, '/'));
    expect(handled).toBe(false);
    expect(isOpen(v)).toBe(false);
  });

  it('opens after leading whitespace', () => {
    const v = setup('  ', 2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const facet = (v.state as any).facet(EditorView.inputHandler);
    const handlers = facet as Array<(v: EditorView, from: number, to: number, text: string) => boolean>;
    const handled = handlers.some((h) => h(v, 2, 2, '/'));
    expect(handled).toBe(true);
    expect(isOpen(v)).toBe(true);
  });
});
