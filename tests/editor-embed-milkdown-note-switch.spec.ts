// Part of the futoBridge Milkdown suite: scope and input rules are in
// editor-embed-milkdown.spec.ts.

import { expect, type Page } from '@playwright/test';
import {
  flushFrames,
  focusEditor,
  getContent,
  messages,
  messagesOfType,
  waitForMessages,
  type FakeHostWindow,
} from './lib/editorEmbedHost';
import {
  settleChangeDebounce,
  test,
  hostConfig,
  initialize,
  hostSetContent,
  placeCaretInto,
} from './lib/editorEmbedMilkdown';
import { largeNote } from './lib/editorEmbedMilkdownStream';

// ============================================================
// Note switch — the outgoing note's edit belongs to the outgoing note
// ============================================================
//
// Both shells share ONE WebView between notes, and a `change` carries no note
// identity: whichever note the shell has bound when it ARRIVES is the note it
// is saved into. So the shell reads the outgoing note (`blur(); getContent()`)
// before the next note's push — Android in its exit before it navigates, iOS
// also inside the attach that rebinds its callbacks (EditorWebView.swift
// `attach`, which then holds back any `change` until that read answers).
// Everything below is the bundle's half of that contract: the read is the
// outgoing note's last word — whatever it still had to report goes out inside
// the read, nothing after it — and the switch itself posts nothing.
// `__switch` in the message log marks the point from which the shell is
// listening for the NEXT note.
// → docs/qa/wikilink-pop-large-edited-note.md

const LINKING_NOTE = 'Parent note body\n\n[[Child]]\n';
const LINKED_NOTE = 'Child note body\n';

/** Every `change` posted after the `__switch` marker. */
async function changesAfterSwitch(page: Page): Promise<string[]> {
  const log = await messages(page);
  const at = log.findIndex((m) => m.type === '__switch');
  expect(at, 'the test never marked the switch').toBeGreaterThanOrEqual(0);
  return log
    .slice(at + 1)
    .filter((m) => m.type === 'change')
    .map((m) => m.content as string);
}

/** The shell's exit read of the outgoing note, after which it listens for the next one. */
async function flushOutgoingNote(page: Page): Promise<{ body: string; streaming: boolean }> {
  return page.evaluate(() => {
    const w = window as unknown as FakeHostWindow;
    const streaming = document.querySelector('.milkdown-stream-tail') !== null;
    w.FutoEditor.blur();
    w.FutoEditor.flush('exit');
    const body = String(w.__msgs.filter((m) => m.type === 'change').at(-1)?.content);
    w.__msgs.push({ type: '__switch' });
    return { body, streaming };
  });
}

/**
 * Follow a link from the linking note to `linked` (a host push) and type into
 * it. A large note is typed into at the caret `focus()` leaves, straight away,
 * so the keystrokes land while its tail is still streaming.
 */
async function openLinkedNoteAndType(page: Page, linked: string, typed: string): Promise<void> {
  await initialize(page, hostConfig({ content: LINKING_NOTE }));
  await page.evaluate((md) => {
    const w = window as unknown as FakeHostWindow;
    w.FutoEditor.setContent('test-note', md);
    w.__msgs.length = 0;
    w.FutoEditor.focus();
  }, linked);
  if (linked === LINKED_NOTE) await page.keyboard.press('End');
  await page.keyboard.type(typed);
}

const STILL_STREAMING = 'the linked note must still be streaming for this case to mean anything';

test('switching notes reports the edited streaming document under its outgoing identity', async ({
  page,
}) => {
  // RC-04: the switch's own "is this already on screen?" read used to settle
  // the stream and post the linked note's whole body INSIDE the push of the
  // linking note, which iOS had already rebound its callbacks to — the parent
  // file was overwritten with the child's body.
  await openLinkedNoteAndType(page, largeNote(4000), 'EDITED ');

  const streaming = await page.evaluate((md) => {
    const w = window as unknown as FakeHostWindow;
    const tail = document.querySelector('.milkdown-stream-tail') !== null;
    w.__msgs.push({ type: '__switch' });
    w.FutoEditor.setContent('parent', md);
    return tail;
  }, LINKING_NOTE);
  await settleChangeDebounce(page);

  expect(streaming, STILL_STREAMING).toBe(true);
  expect((await messagesOfType(page, 'change')).at(-1)).toEqual(
    // `EDITED`, not `EDITED `: the caret ends a paragraph, and a save writes no
    // whitespace at a line's end (docs/spec/editor.md "Markdown house style").
    expect.objectContaining({ noteId: 'test-note', content: expect.stringContaining('EDITED') }),
  );
  expect(await getContent(page)).toBe(LINKING_NOTE);
});

test('an exit flush reports the complete edited streaming document', async ({ page }) => {
  await openLinkedNoteAndType(page, largeNote(4000), 'EDITED ');

  const captured = await flushOutgoingNote(page);
  await hostSetContent(page, LINKING_NOTE);

  expect(captured.streaming, STILL_STREAMING).toBe(true);
  // No trailing space: a save writes no whitespace at a line's end.
  expect(captured.body).toContain('EDITED');
  expect(captured.body).toContain('Section 3999');
  // A `change` for the edit now would reach the next note's binding.
  expect(await changesAfterSwitch(page)).toEqual([]);
  expect(await getContent(page)).toBe(LINKING_NOTE);
});

test('an exit flush reports the pending change once before the switch', async ({ page }) => {
  // RC-09 / L6c-3: typing, then leaving inside the change debounce. The read
  // carries the typed words, and so does a report posted INSIDE it, to the
  // binding that is still the outgoing note's. The debounce armed by the last
  // keystroke must not fire afterwards, however late the next note's push.
  await openLinkedNoteAndType(page, LINKED_NOTE, ' plus typed words');

  const captured = await flushOutgoingNote(page);
  await settleChangeDebounce(page);
  await hostSetContent(page, LINKING_NOTE);

  expect(captured.body).toContain('plus typed words');
  const log = await messages(page);
  const beforeSwitch = log
    .slice(
      0,
      log.findIndex((m) => m.type === '__switch'),
    )
    .filter((m) => m.type === 'change')
    .map((m) => m.content);
  expect(beforeSwitch).toEqual([captured.body, captured.body]);
  expect(await changesAfterSwitch(page)).toEqual([]);
  expect(await getContent(page)).toBe(LINKING_NOTE);
});

test('a switch inside the change debounce shows the next note, even with the same bytes', async ({
  page,
}) => {
  // L6a-1: two new, empty notes. The switch used to be compared against what
  // the host last loaded ('') instead of the live document, so it was
  // swallowed: the first note's text stayed on screen and was then posted as
  // the second note's change.
  await initialize(page, hostConfig({ content: '' }));
  await focusEditor(page);
  await page.keyboard.type('typed into the first note');

  const changesBeforeSwitch = await page.evaluate(() => {
    const w = window as unknown as FakeHostWindow;
    const before = w.__msgs.filter((m) => m.type === 'change').length;
    w.__msgs.push({ type: '__switch' });
    w.FutoEditor.setContent('next-note', '');
    return before;
  });
  expect(changesBeforeSwitch, 'the switch must land inside the debounce').toBe(0);
  await settleChangeDebounce(page);

  expect(await getContent(page)).toBe('');
  expect((await messagesOfType(page, 'change')).at(-1)).toEqual(
    expect.objectContaining({
      noteId: 'test-note',
      content: expect.stringContaining('typed into the first note'),
    }),
  );
});

test('a host re-sending the note on screen leaves the caret where it was', async ({ page }) => {
  await hostSetContent(page, 'abcdef');
  await focusEditor(page);
  await placeCaretInto(page, 3);

  await page.evaluate(() =>
    (window as unknown as FakeHostWindow).FutoEditor.setContent('test-note', 'abcdef'),
  );
  await flushFrames(page);
  await page.keyboard.type('Z');

  await waitForMessages(page, 'change');
  expect(await getContent(page)).toBe('abcZdef\n');
});

test('a switch to an empty note drops the blank paragraphs the last note was left with', async ({
  page,
}) => {
  // RC-22 regression: trailing empty paragraphs are not written, so a note the
  // user pressed Enter in serializes like a note without them, and the switch
  // was skipped as "already on screen" with the blanks still there.
  await initialize(page, hostConfig({ content: '' }));
  await focusEditor(page);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await settleChangeDebounce(page);

  await hostSetContent(page, '');
  await focusEditor(page);
  await page.keyboard.type('shopping');
  await settleChangeDebounce(page);

  expect(await getContent(page)).toBe('shopping\n');
});

test('a switch to the same text drops the blank paragraphs stacked under it', async ({ page }) => {
  await hostSetContent(page, 'hello\n');
  await focusEditor(page);
  await page.keyboard.press('ControlOrMeta+End');
  // The first Enter is a newline; each one after it is a paragraph.
  for (let i = 0; i < 4; i++) await page.keyboard.press('Enter');
  await settleChangeDebounce(page);
  expect(await page.locator('.ProseMirror > p').count()).toBe(4);

  await hostSetContent(page, 'hello\n');

  expect(await page.locator('.ProseMirror > p').count()).toBe(1);
  expect(await getContent(page)).toBe('hello\n');
});

test('a switch to the same text drops an empty line typed at the end of the note', async ({
  page,
}) => {
  // A newline at the very end of a paragraph is not written either, so the
  // document serializes like the note without it.
  await hostSetContent(page, 'hello\n');
  await focusEditor(page);
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await settleChangeDebounce(page);
  expect(await page.locator('.ProseMirror > p').first().innerText()).toBe('hello\n\n');

  await hostSetContent(page, 'hello\n');

  expect(await page.locator('.ProseMirror > p').first().innerText()).toBe('hello');
  expect(await getContent(page)).toBe('hello\n');
});

test('a push equal to an out-of-date serialization still replaces the document', async ({
  page,
}) => {
  // L6a-1, second shape: the last REPORTED text is not the live document once
  // the user has typed past it.
  await hostSetContent(page, 'seed');
  await focusEditor(page);
  await page.keyboard.press('End');
  await page.keyboard.type(' one');
  await waitForMessages(page, 'change');
  await page.keyboard.type(' two');

  await hostSetContent(page, 'seed one\n');

  expect(await getContent(page)).toBe('seed one\n');
});
