// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { mountImageNote, type ImageNote } from './__test__/mountImageNote';

let note: ImageNote | null = null;
afterEach(() => {
  note?.close();
  note = null;
  vi.unstubAllGlobals();
});

function press(note: ImageNote, key: string, shiftKey = false, altKey = false): boolean {
  const event = new KeyboardEvent('keydown', {
    key,
    shiftKey,
    altKey,
    bubbles: true,
    cancelable: true,
  });
  note.view.dom.dispatchEvent(event);
  return event.defaultPrevented;
}

function input(note: ImageNote, inputType: string): void {
  note.view.dom.dispatchEvent(new InputEvent('beforeinput', { inputType, cancelable: true }));
}

it('selects an image on the first Backspace after it and deletes it on the second', async () => {
  note = await mountImageNote('a ![](x.png) b');
  note.view.selection.selectRange(12, 12);
  expect(press(note, 'Backspace')).toBe(true);
  expect(note.engine.draftText()).toBe('a ![](x.png) b');
  expect(note.view.selection.range()).toEqual({ start: 2, end: 12 });
  expect(press(note, 'Backspace')).toBe(false);
  input(note, 'deleteContentBackward');
  expect(note.engine.draftText()).toBe('a  b');
  input(note, 'historyUndo');
  expect(note.engine.draftText()).toBe('a ![](x.png) b');
});

it('selects an image on the first Delete before it and deletes it on the second', async () => {
  note = await mountImageNote('a ![](x.png) b');
  note.view.selection.selectRange(2, 2);
  expect(press(note, 'Delete')).toBe(true);
  expect(note.engine.draftText()).toBe('a ![](x.png) b');
  expect(note.view.selection.range()).toEqual({ start: 2, end: 12 });
  expect(press(note, 'Delete')).toBe(false);
  input(note, 'deleteContentForward');
  expect(note.engine.draftText()).toBe('a  b');
});

it("a word's Backspace or Delete beside an image selects it first too", async () => {
  vi.stubGlobal('navigator', { platform: 'MacIntel' });
  note = await mountImageNote('a ![](x.png) b');
  note.view.selection.selectRange(12, 12);
  expect(press(note, 'Backspace', false, true)).toBe(true);
  expect(note.view.selection.range()).toEqual({ start: 2, end: 12 });
  note.view.selection.selectRange(2, 2);
  expect(press(note, 'Delete', false, true)).toBe(true);
  expect(note.view.selection.range()).toEqual({ start: 2, end: 12 });
});

it('leaves Backspace and Delete away from an image to the engine', async () => {
  note = await mountImageNote('a ![](x.png) b');
  note.view.selection.selectRange(14, 14);
  expect(press(note, 'Backspace')).toBe(false);
  note.view.selection.selectRange(1, 1);
  expect(press(note, 'Delete')).toBe(false);
});

it('keeps a selected last image on Enter and opens a line after it', async () => {
  note = await mountImageNote('ab![](a.png)');
  note.view.selection.selectRange(2, 12);
  input(note, 'insertParagraph');
  expect(note.engine.draftText()).toBe('ab![](a.png)\n');
  expect(note.view.selection.range()).toEqual({ start: 13, end: 13 });
});

it('copies a selection holding an image as its spelling', async () => {
  note = await mountImageNote('a ![alt](x.png "t") b');
  expect(note.view.copy(note.view.bytes({ start: 0, end: 21 }))).toBe('a ![alt](x.png "t") b');
});

it('steps Left and Right over an image, and Shift takes it whole', async () => {
  note = await mountImageNote('a ![](x.png) b');
  note.view.selection.selectRange(2, 2);
  expect(press(note, 'ArrowRight')).toBe(true);
  expect(note.view.selection.range()).toEqual({ start: 12, end: 12 });
  expect(press(note, 'ArrowLeft')).toBe(true);
  expect(note.view.selection.range()).toEqual({ start: 2, end: 2 });
  expect(press(note, 'ArrowRight', true)).toBe(true);
  expect(note.view.selection.range()).toEqual({ start: 2, end: 12 });
});
