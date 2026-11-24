// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { markSelectedPictures } from './pictureSelection';
import { mountImageNote, type ImageNote } from './__test__/mountImageNote';

let note: ImageNote | null = null;
afterEach(() => {
  note?.close();
  note = null;
});

it('tints the pictures a selection holds and no others, and untints them after', async () => {
  note = await mountImageNote('![](a.png) x ![](b.png)');
  const { view } = note;
  const model = view.lineModel()!;
  const elements = view.lineElements();
  const [first, second] = view.dom.querySelectorAll('.atom.image');
  let marked = markSelectedPictures(elements, model, { start: 0, end: 12 }, []);
  expect(marked).toEqual([first]);
  expect(first.hasAttribute('data-selected')).toBe(true);
  marked = markSelectedPictures(elements, model, { start: 11, end: 23 }, marked);
  expect(marked).toEqual([second]);
  expect(first.hasAttribute('data-selected')).toBe(false);
  marked = markSelectedPictures(elements, model, { start: 3, end: 3 }, marked);
  expect(marked).toEqual([]);
  expect(second.hasAttribute('data-selected')).toBe(false);
});
