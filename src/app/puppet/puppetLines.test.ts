// @vitest-environment jsdom
//
// A note's lines as the screen draws them: a line per line break, a link to a note and an image
// as their chips read, front matter as the value it draws.
import { expect, it, vi } from 'vitest';

vi.mock('$lib/platform', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hasFileSystem: true,
  onFileDrop: () => () => {},
}));

import { _injectTestNote, getWikilinkIndex } from '$features/notes/notes.svelte';

import { layOutLines, mountEditor } from './puppetEditor.fixture';
import { runPuppetCommand } from './puppetInspector';
import { blockLines, lineMarkdown } from './puppetLines';
import { noteLines } from './puppetNoteLines';

const text = () =>
  (runPuppetCommand('doc', {}).body as { lines: Array<{ text: string }> }).lines[0].text;

it('a link reads as the words its chip shows, broken until a note answers it', async () => {
  await mountEditor('See [[work/atlas/roadmap]] and ![](attachments/photo.png)\n');
  expect(text()).toBe('See [[work/atlas/roadmap]]!broken and [image photo.png]');
  _injectTestNote('work/atlas/roadmap', 'roadmap');
  _injectTestNote('work/beacon/roadmap', 'roadmap');
  // The chip shows the shortest name that is unique in the vault.
  expect(text()).toBe('See [[atlas/roadmap]] and [image photo.png]');
  const runs = (
    runPuppetCommand('doc', { line: 1 }).body as { runs: Array<Record<string, unknown>> }
  ).runs;
  expect(runs).toContainEqual(
    expect.objectContaining({ node: 'wikilink', opens: 'work/atlas/roadmap' }),
  );
});

it('every line break ends a line, and only the line asked for is serialized', async () => {
  // Enter in a paragraph types a single newline; a `\` break is the older spelling.
  const { view } = await mountEditor('*one*\ntwo\nthree\\\nfour\n');
  layOutLines(view, { rows: 2 });
  expect(runPuppetCommand('doc', {}).body).toMatchObject({
    onScreen: { first: 1, last: 2 },
    lines: [{ text: 'one', md: '*one*' }, { text: 'two' }],
  });
  const note = noteLines(view.state.doc);
  expect(note.slice(1, 4).map((entry) => entry.text)).toEqual(['one', 'two', 'three', 'four']);
  const serialize = vi.fn((doc: Parameters<typeof lineMarkdown>[1]) => doc.textContent);
  expect(lineMarkdown(note.line(3)!, view.state.doc, serialize)).toBe('three');
  expect(serialize).toHaveBeenCalledTimes(1);
});

it('front matter is one line, as it is one atom: the value it draws', async () => {
  await mountEditor('---\ntitle: secret meta\ntags: [a]\n---\n\nbody line\n');
  const lines = (runPuppetCommand('doc', {}).body as { lines: Array<Record<string, unknown>> })
    .lines;
  expect(lines.map((line) => [line.kind, line.text])).toEqual([
    ['frontmatter', 'title: secret meta\ntags: [a]'],
    ['paragraph', 'body line'],
  ]);
});

it('a block with no chip is read once, whatever the vault does', async () => {
  const { view } = await mountEditor('plain\n\nSee [[elsewhere]]\n');
  const [plain, linked] = [view.state.doc.child(0), view.state.doc.child(1)];
  const before = [blockLines(plain, getWikilinkIndex()), blockLines(linked, getWikilinkIndex())];
  _injectTestNote('elsewhere', 'elsewhere');
  expect(blockLines(plain, getWikilinkIndex())).toBe(before[0]);
  expect(blockLines(linked, getWikilinkIndex())).not.toBe(before[1]);
});
