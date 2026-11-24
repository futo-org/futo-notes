// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { pointInLine } from './lineElements';
import { drawnLineDrift } from './lineDrift';
import { pictureOf } from './pictureElements';
import { mountImageNote, type ImageNote } from './__test__/mountImageNote';

let note: ImageNote | null = null;
afterEach(() => {
  note?.close();
  note = null;
});

const imageOf = (line: HTMLElement): HTMLElement => line.querySelector<HTMLElement>('.atom.image')!;

it('draws an image as its spelling, kept as the line text, and a picture of it', async () => {
  note = await mountImageNote('a ![a cat](cats/cat.png "Tom") b');
  const [line] = note.view.lineElements();
  const image = imageOf(line);
  expect(line.textContent).toBe('a ![a cat](cats/cat.png "Tom") b');
  expect(image.firstChild).toBeInstanceOf(Text);
  const picture = pictureOf(image)!;
  expect(picture.alt).toBe('a cat');
  expect(picture.title).toBe('Tom');
  expect(picture.getAttribute('data-source')).toBe('cats/cat.png');
  expect(picture.hasAttribute('src')).toBe(false);
  expect(image.getAttribute('data-label')).toBe('a cat');
});

it('labels an image without alt text by its file name', async () => {
  note = await mountImageNote('![](trip/photo.png)');
  expect(imageOf(note.view.lineElements()[0]).getAttribute('data-label')).toBe('photo.png');
});

it('keeps a line picture, and what it loads, through a keystroke on its line', async () => {
  note = await mountImageNote('a ![](x.png) b');
  const { view, engine } = note;
  const picture = pictureOf(imageOf(view.lineElements()[0]))!;
  picture.setAttribute('src', 'asset://x.png');
  view.selection.selectRange(14, 14);
  view.run((current) => current.replace({ start: 14, end: 14 }, 'c', 'Typing'));
  expect(engine.draftText()).toBe('a ![](x.png) bc');
  expect(pictureOf(imageOf(view.lineElements()[0]))).toBe(picture);
  expect(picture.getAttribute('src')).toBe('asset://x.png');
});

it('puts no DOM point inside an image spelling: beside its element where no text is', async () => {
  note = await mountImageNote('a ![](x.png) b\n![](y.png)');
  const [first, second] = note.view.lineElements();
  // Before: beside the element; after, the text that follows.
  expect(pointInLine(first, 2)).toEqual([first, 1]);
  expect(pointInLine(first, 12)).toEqual([first.lastChild, 0]);
  expect(pointInLine(first, 12, true)).toEqual([first, 2]);
  // Alone on its line: before and after its element.
  expect(pointInLine(second, 0)).toEqual([second, 0]);
  expect(pointInLine(second, 10)).toEqual([second, 1]);
  // A point asked for inside it is its end.
  expect(pointInLine(second, 4)).toEqual([second, 1]);
});

it('stops the caret only before and after an image, its offsets the engine stops', async () => {
  note = await mountImageNote('a ![](x.png) b');
  const { view } = note;
  view.selection.selectRange(2, 2);
  expect(view.selection.ends()).toEqual({ anchor: 2, focus: 2 });
  view.selection.selectRange(12, 12);
  expect(view.selection.ends()).toEqual({ anchor: 12, focus: 12 });
});

it('reads a picture loaded, marked missing or selected as its line drawn (no drift)', async () => {
  note = await mountImageNote('a ![](x.png) b');
  const { view } = note;
  const image = imageOf(view.lineElements()[0]);
  pictureOf(image)!.setAttribute('src', 'asset://x.png');
  image.setAttribute('data-missing', '');
  image.setAttribute('data-selected', '');
  image.style.minHeight = '120px';
  expect(drawnLineDrift(view.lineElements(), view.displayLines())).toBeNull();
});

it('keeps a pasted data image an image, as the stories paste one', async () => {
  note = await mountImageNote('');
  const { view } = note;
  view.selection.selectRange(0, 0);
  view.insert('a ![dot](data:image/png;base64,iVBORw0KGgo=) b');
  const [atom] = view.displayLines()[0].atoms;
  expect(atom.kind).toBe('Image');
  expect(atom.image?.destination).toBe('data:image/png;base64,iVBORw0KGgo=');
  expect(atom.image?.vault).toBe(false);
});
