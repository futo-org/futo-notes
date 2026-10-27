// @vitest-environment jsdom
//
// The note's line index: numbers, positions and the gaps between blocks, as `doc` reads them,
// and after an edit, lines renumbered from the block that changed.
import { expect, it, vi } from 'vitest';

vi.mock('$lib/platform', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hasFileSystem: true,
  onFileDrop: () => () => {},
}));

import { setFindOverlayInset } from '../../features/editor/milkdown/find/findPlugin';
import { layOutLines, mountEditor } from './puppetEditor.fixture';
import { linesOnScreen, noteLines } from './puppetNoteLines';

it('numbers lines across blocks, finds the line at a position, and the lines a range touches', async () => {
  const { view } = await mountEditor('one\n\n- two\n- three\n\nfour\n');
  const note = noteLines(view.state.doc);
  expect(note.count).toBe(4);
  expect(note.slice(1, 4).map((entry) => [entry.line, entry.kind, entry.text])).toEqual([
    [1, 'paragraph', 'one'],
    [2, 'bullet', 'two'],
    [3, 'bullet', 'three'],
    [4, 'paragraph', 'four'],
  ]);
  const [one, two, , four] = note.slice(1, 4);
  expect(view.state.doc.textBetween(two.at, two.end)).toBe('two');
  // The gap between two blocks belongs to the line after it.
  expect(note.at(one.end + 1)?.line).toBe(2);
  expect(note.at(four.end)?.line).toBe(4);
  expect(note.between(one.at, two.end).map((entry) => entry.line)).toEqual([1, 2]);
  expect(note.line(0)).toBeNull();
  expect(note.line(5)).toBeNull();
});

it('after an edit, the lines past the change are renumbered and moved', async () => {
  const { view } = await mountEditor('one\n\ntwo\n\nthree\n');
  const before = noteLines(view.state.doc);
  const three = before.line(3)!;
  // A new paragraph after line 1: line 2 onward move down one line and along by its size.
  const { schema } = view.state;
  const paragraph = schema.nodes.paragraph.create(null, schema.text('new'));
  view.dispatch(view.state.tr.insert(before.line(1)!.end + 1, paragraph));
  const after = noteLines(view.state.doc);
  expect(after.count).toBe(4);
  expect(after.slice(1, 4).map((entry) => entry.text)).toEqual(['one', 'new', 'two', 'three']);
  expect(after.line(4)!.at).toBe(three.at + 5);
  expect(after.line(1)).toEqual(before.line(1));
});

it('the band a person sees: the root clips nothing, a Find bar covers the bottom', async () => {
  const { view } = await mountEditor('one\n\ntwo\n\nthree\n\nfour\n');
  layOutLines(view, { rows: 3 });
  // The Android WebView: the editor is its own scroller, and <html> has no height and hides
  // its overflow (editor.html pins the body instead), which is the viewport's, not a clip.
  view.dom.style.overflowY = 'auto';
  view.dom.getBoundingClientRect = view.dom.parentElement!.getBoundingClientRect;
  const root = document.documentElement;
  root.style.overflowY = 'hidden';
  root.getBoundingClientRect = () => new DOMRect(0, 0, 800, 0);
  try {
    expect(linesOnScreen(view)).toEqual({ first: 1, last: 3 });
    setFindOverlayInset(view, 1);
    expect(linesOnScreen(view)).toEqual({ first: 1, last: 2 });
  } finally {
    root.style.overflowY = '';
    delete (root as { getBoundingClientRect?: unknown }).getBoundingClientRect;
  }
});
