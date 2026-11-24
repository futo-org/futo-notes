// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { EditorView } from '$features/editor/desktop/view';
import { mountView } from '$features/editor/desktop/__test__/mountView';
import { docVersionOfView, textAnchor, textRangeFrom } from './puppetTextAnchors';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

/** jsdom lays nothing out: each line 20 px tall, top to bottom, and a pane `rows` lines high. */
function layOut(view: EditorView, rows: number): void {
  const elements: readonly Element[] = view.lineElements();
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const index = elements.indexOf(this);
    return index < 0 ? new DOMRect(0, 0, 400, rows * 20) : new DOMRect(0, index * 20, 400, 20);
  });
}

it('finds text as doc shows it, a list marker left out of the text and kept in the offsets', async () => {
  const { view } = await mountView('intro\n- milk\n- eggs');
  layOut(view, 10);
  // Line 2 starts at 6 with its marker unit; its text at 7.
  expect(textAnchor(view, 'find', 'milk')).toEqual({ from: 7, to: 11 });
  expect(textAnchor(view, 'find', 'intro\nmilk')).toEqual({ from: 0, to: 11 });
});

it('refuses text that is on screen twice, naming every place', async () => {
  const { view } = await mountView('tea and tea');
  layOut(view, 10);
  expect(textAnchor(view, 'find', 'tea')).toMatchObject({
    status: 409,
    body: { error: expect.stringContaining('2 occurrences of "tea" on screen (at 0, 8)') },
  });
});

it('refuses text off screen with the scroll that brings it there', async () => {
  const { view } = await mountView('one\ntwo\nthree\nfour');
  layOut(view, 2);
  expect(textAnchor(view, 'find', 'four')).toMatchObject({
    status: 409,
    body: { reach: [['ScrollToLine', { line: 4 }]] },
  });
});

it('holds offsets to the text and the version they were read from', async () => {
  const { view } = await mountView('hello world');
  layOut(view, 10);
  const args = { from: 6, to: 11 };
  expect(textRangeFrom(view, { ...args, expect: 'world' }, 'Select')).toEqual(args);
  expect(textRangeFrom(view, { ...args, expect: 'there' }, 'Select')).toMatchObject({
    status: 409,
    body: { error: 'text at 6-11 is "world", expected "there"' },
  });
  expect(
    textRangeFrom(view, { ...args, docVersion: docVersionOfView(view) + 1 }, 'Select'),
  ).toMatchObject({ status: 409 });
  expect(textRangeFrom(view, { from: 6, to: 40 }, 'Select')).toMatchObject({ status: 400 });
});

it('refuses a version read in another note, whose revision may be the same', async () => {
  const { view: first } = await mountView('hello world');
  layOut(first, 10);
  const read = docVersionOfView(first);
  document.body.replaceChildren();
  const { view: second } = await mountView('hello world');
  layOut(second, 10);
  expect(second.revision()).toBe(first.revision());
  expect(textRangeFrom(second, { from: 6, to: 11, docVersion: read }, 'Select')).toMatchObject({
    status: 409,
  });
});

it('takes a range made backwards, as a drag from its end makes it', async () => {
  const { view } = await mountView('hello world');
  layOut(view, 10);
  expect(textRangeFrom(view, { from: 11, to: 6, expect: 'world' }, 'Select')).toEqual({
    from: 11,
    to: 6,
  });
});
