// @vitest-environment jsdom
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDecorationSet } from './decorationSet';
import type { PendingDecoration } from './decorationTypes';

const views: EditorView[] = [];

afterEach(() => {
  for (const view of views) view.destroy();
  views.length = 0;
  vi.restoreAllMocks();
});

function viewWith(doc: string): EditorView {
  const view = new EditorView({ doc, parent: document.body });
  views.push(view);
  return view;
}

function classesIn(view: EditorView, decorations: PendingDecoration[]): string[] {
  const set = createDecorationSet(view, decorations, 0);
  const classes: string[] = [];
  const cursor = set.iter();
  while (cursor.value) {
    const cls = (cursor.value.spec as { class?: string }).class;
    if (cls) classes.push(cls);
    cursor.next();
  }
  return classes;
}

describe('createDecorationSet', () => {
  // A single malformed pending decoration must not take down the whole build:
  // decorations are applied inside a per-decoration guard that warns and skips.
  // Any position-dependent inspection (line lookups included) has to tolerate an
  // out-of-range position rather than throw out of the shared setup step.
  it('does not abort the whole build on one out-of-range decoration', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const view = viewWith('hello world');

    const classes = classesIn(view, [
      { from: 500, to: 520, value: { replace: true } },
      { from: 0, to: 5, value: { class: 'cm-md-test' } },
    ]);

    expect(classes).toEqual(['cm-md-test']);
  });

  it('drops a replacing decoration that would cover a line break', () => {
    const view = viewWith('one\ntwo');
    const set = createDecorationSet(view, [{ from: 1, to: 6, value: { replace: true } }], 0);

    expect(set.size).toBe(0);
  });
});
