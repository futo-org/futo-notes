// @vitest-environment jsdom
//
// The receipt's `doc` hunk: what an edit did to the lines a person sees.
import { expect, it, vi } from 'vitest';

vi.mock('$lib/platform', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hasFileSystem: true,
  onFileDrop: () => () => {},
}));

import type { EditorView } from '@milkdown/kit/prose/view';

import { layOutLines, mountEditor } from './puppetEditor.fixture';
import { noteLines } from './puppetNoteLines';
import { diffSnapshots, takeSnapshot } from './puppetSnapshots';

/** New paragraphs after line `after`, as InsertLine writes them. */
function insertParagraphs(view: EditorView, after: number, texts: string[]): void {
  const { schema } = view.state;
  const paragraphs = texts.map((text) => schema.nodes.paragraph.create(null, schema.text(text)));
  view.dispatch(view.state.tr.insert(noteLines(view.state.doc).line(after)!.end + 1, paragraphs));
}

it('a paragraph put between two reads as an insert, nothing removed', async () => {
  const { view } = await mountEditor('one\n\ntwo\n\nthree\n');
  const before = takeSnapshot();
  insertParagraphs(view, 1, ['new']);
  expect(diffSnapshots(before, takeSnapshot()).doc).toMatchObject({ line: 2, removed: '' });
});

it('an edit that scrolls the screen compares the same lines of each version', async () => {
  const { view } = await mountEditor('one\n\ntwo\n\nthree\n');
  layOutLines(view, { rows: 3 });
  const before = takeSnapshot();
  insertParagraphs(
    view,
    1,
    Array.from({ length: 30 }, (_, i) => `new ${i + 1}`),
  );
  layOutLines(view, { first: 20, rows: 3 });
  expect(diffSnapshots(before, takeSnapshot()).doc).toEqual({
    line: 20,
    removed: '',
    inserted: 'paragraph│new 19\nparagraph│new 20\nparagraph│new 21',
  });
});
