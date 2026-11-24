// @vitest-environment jsdom
/* The tag bar's edits through the view (headerTagEdits.ts), on the real engine. */
import { afterEach, expect, it, vi } from 'vitest';
import { Engine } from './engine';
import { createHeaderTagEdits } from './headerTagEdits';
import { mountView } from './__test__/mountView';

afterEach(() => vi.unstubAllGlobals());

it('adds a tag as one edit and one Undo step, the selection kept on its text', async () => {
  const { view, engine } = await mountView('#a\n\nsome body');
  view.selection.selectRange(4, 8);
  let reported = 0;
  const edits = createHeaderTagEdits(view, engine, () => reported++);
  edits.add('Work');
  expect(engine.draftText()).toBe('#a #work\n\nsome body');
  expect(view.selection.range()).toEqual({ start: 10, end: 14 });
  expect(reported).toBe(1);
  view.run((current) => current.undo());
  expect(engine.draftText()).toBe('#a\n\nsome body');
  expect(view.selection.range()).toEqual({ start: 4, end: 8 });
  view.destroy();
  engine.free();
});

it('removing the last tag removes the block and its separator, and draws the change', async () => {
  const { view, engine } = await mountView('#a\n\nsome body');
  createHeaderTagEdits(view, engine, () => {}).remove('#a');
  expect(engine.draftText()).toBe('some body');
  expect(view.lineElements().map((element) => element.textContent)).toEqual(['some body']);
  view.destroy();
  engine.free();
});

it('writes nothing once another note is open', async () => {
  const { view, engine } = await mountView('first note');
  const edits = createHeaderTagEdits(view, engine, () => {});
  const other = await Engine.restore({
    token: 2,
    source: 'second note',
    revision: 0,
    paused: false,
  });
  view.open(other);
  edits.add('late');
  expect(engine.draftText()).toBe('first note');
  expect(other.draftText()).toBe('second note');
  view.destroy();
  engine.free();
  other.free();
});

it('reports nothing when the note already has the tag', async () => {
  const { view, engine } = await mountView('#a\n\nsome body');
  let reported = 0;
  createHeaderTagEdits(view, engine, () => reported++).add('A');
  expect(engine.draftText()).toBe('#a\n\nsome body');
  expect(reported).toBe(0);
  view.destroy();
  engine.free();
});
