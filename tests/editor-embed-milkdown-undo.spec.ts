// Part of the futoBridge Milkdown suite: scope and input rules are in
// editor-embed-milkdown.spec.ts.

import { expect } from '@playwright/test';
import {
  flushFrames,
  focusEditor,
  getContent,
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
} from './lib/editorEmbedMilkdown';

// ============================================================
// Undo history — must never cross a note boundary
// ============================================================

test('the note the boot config carries is not something undo can erase', async ({ page }) => {
  await initialize(page, hostConfig({ content: 'the note body' }));
  await focusEditor(page);
  await page.keyboard.press('ControlOrMeta+z');
  await settleChangeDebounce(page);

  expect(await getContent(page)).toBe('the note body');
  expect(await messagesOfType(page, 'change')).toHaveLength(0);
});

test('a host note switch clears undo even when the next note has identical text', async ({
  page,
}) => {
  await hostSetContent(page, 'draft');
  await focusEditor(page);
  await page.keyboard.press('End');
  await page.keyboard.type(' X');
  await waitForMessages(page, 'change');
  // Edited, so getContent now reports the serialization (normalize-once).
  expect(await getContent(page)).toBe('draft X\n');

  await hostSetContent(page, 'draft X');
  await focusEditor(page);
  await page.keyboard.press('ControlOrMeta+z');
  await settleChangeDebounce(page);

  expect(await getContent(page)).toBe('draft X');
});

test('undo inside one note still works', async ({ page }) => {
  await hostSetContent(page, 'keep');
  await focusEditor(page);
  await page.keyboard.press('End');
  await page.keyboard.type(' typed');
  await waitForMessages(page, 'change');

  await page.keyboard.press('ControlOrMeta+z');
  await settleChangeDebounce(page);

  expect(await getContent(page)).toBe('keep\n');
});

/*
 * RC-60 (L3-5): an undo that brings a divider back is not the user creating a
 * divider. `dividerCaret` used to read the restored `hr` as new and append an
 * empty paragraph after it, so undoing "type over a selected divider" left the
 * note one blank line longer than it was opened. Real input only: a mouse click
 * on the rule is how a user selects a divider (a click on a block atom is a
 * NodeSelection; ArrowDown steps natively PAST the rule), then typed letters
 * replace it.
 */
test('undoing a keystroke typed over a selected divider restores the note exactly', async ({
  page,
}) => {
  // The house style's spelling of the rule, so an exact restore is the same bytes.
  const note = 'first\n\n---\n\nlast\n';
  await hostSetContent(page, note);
  await page.locator('.ProseMirror hr').click();
  await page.keyboard.type('hello');
  await waitForMessages(page, 'change');
  expect(await getContent(page)).toContain('hello');
  expect(await getContent(page)).not.toContain('---');

  for (let i = 0; i < 20; i++) await page.keyboard.press('ControlOrMeta+z');
  await settleChangeDebounce(page);

  expect(await getContent(page)).toBe(note);

  // Redo puts the edit back, and undoing it again is exact once more.
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await settleChangeDebounce(page);
  expect(await getContent(page)).toContain('h');
  expect(await getContent(page)).not.toContain('---');
  for (let i = 0; i < 20; i++) await page.keyboard.press('ControlOrMeta+z');
  await settleChangeDebounce(page);
  expect(await getContent(page)).toBe(note);
});

/*
 * RC-54 (L3-6): Ctrl-Z after an adopt threw `RangeError: Position N out of range`.
 * The adopt was incidental. An undo that restores a divider ran `dividerCaret`,
 * whose `appendTransaction` added an empty paragraph to the replay; that
 * paragraph is in no history event, so every OLDER event that sat below it in
 * the document was now two positions off, its inverse steps no longer fitted
 * ("Inconsistent open depths"), and resolving its selection bookmark ran past the
 * end of the document. It needs the divider event to have an earlier event
 * below it, which is why a lone undo (RC-60's case above) never showed it.
 */
test('undoing everything after an adopt, a later edit and a keystroke over a divider is exact', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // The house style's spelling of the rule, so an exact undo is the same bytes.
  await hostSetContent(page, 'first\n\n---\n\nlast\n');
  await page.evaluate(() =>
    (window as unknown as FakeHostWindow).FutoEditor.applyExternalContent(
      'test-note',
      'first peer\n\n---\n\nlast\n',
      (window as unknown as FakeHostWindow).__futoTest.documentRef().generation,
    ),
  );
  await flushFrames(page);
  const adopted = 'first peer\n\n---\n\nlast\n';

  // An edit BELOW the divider, then one over it.
  await page.getByText('last', { exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' one');
  await page.locator('.ProseMirror hr').click();
  await page.keyboard.type('hello');
  await settleChangeDebounce(page);
  expect(await getContent(page)).toContain('hello');

  for (let i = 0; i < 30; i++) await page.keyboard.press('ControlOrMeta+z');
  await settleChangeDebounce(page);

  expect(errors).toEqual([]);
  expect(await getContent(page)).toBe(adopted);
});

test('undo and redo of a typed `---` leave the divider note byte-stable', async ({ page }) => {
  await hostSetContent(page, 'above\n\n');
  await focusEditor(page);
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('---');
  await settleChangeDebounce(page);
  const made = await getContent(page);
  // A rule, written `---`; typed text that stayed text would be `\---`.
  expect(made).toMatch(/^---$/m);

  await page.keyboard.press('ControlOrMeta+z');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await settleChangeDebounce(page);

  expect(await getContent(page)).toBe(made);
});

/*
 * Data safety: a version that arrives from OUTSIDE the editor is not an edit,
 * so it cannot be undone. `applyExternalContent` is the sync-adopt path, and it
 * deliberately does NOT reset the undo stack (the user's own edits stay
 * undoable), which is exactly what made this a hole: as an ordinary transaction
 * the adopt sat on top of the stack, and one Ctrl-Z revived the superseded
 * version and handed it to autosave. → docs/spec/editor.md "Saving & rename"
 */
test('a version adopted from outside the editor is not something undo can revive', async ({
  page,
}) => {
  await hostSetContent(page, 'mine');
  await focusEditor(page);
  await page.keyboard.press('End');
  await page.keyboard.type(' typed');
  await waitForMessages(page, 'change');

  await page.evaluate(() =>
    (window as unknown as FakeHostWindow).FutoEditor.applyExternalContent(
      'test-note',
      'theirs\n',
      (window as unknown as FakeHostWindow).__futoTest.documentRef().generation,
    ),
  );
  await settleChangeDebounce(page);
  expect(await getContent(page)).toBe('theirs\n');

  await focusEditor(page);
  await page.keyboard.press('ControlOrMeta+z');
  await page.keyboard.press('ControlOrMeta+z');
  await settleChangeDebounce(page);

  expect(await getContent(page)).toBe('theirs\n');
});

/*
 * Redo never undoes. A Ctrl+Shift+Z whose key arrives as lowercase "z" (Caps
 * Lock on, or a host that reports it so) found nothing to redo, and
 * prosemirror-keymap then retried the chord WITHOUT Shift — Ctrl+Z, undo — and
 * took back the user's last edit. Playwright's `ControlOrMeta+Shift+z` sends
 * exactly that event.
 */
test('Ctrl+Shift+z with nothing left to redo leaves the note unchanged', async ({ page }) => {
  await hostSetContent(page, 'base');
  await focusEditor(page);
  await page.keyboard.press('End');
  await page.keyboard.type('a');
  await settleChangeDebounce(page);
  await page.keyboard.press('ControlOrMeta+z');
  await settleChangeDebounce(page);
  expect(await getContent(page)).toBe('base\n');

  await page.keyboard.press('ControlOrMeta+Shift+z');
  await settleChangeDebounce(page);
  expect(await getContent(page)).toBe('basea\n');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await settleChangeDebounce(page);
  expect(await getContent(page)).toBe('basea\n');
});

test('Ctrl+Shift+z after new typing that follows an undo keeps the new text', async ({ page }) => {
  await hostSetContent(page, 'base');
  await focusEditor(page);
  await page.keyboard.press('End');
  await page.keyboard.type('a');
  await settleChangeDebounce(page);
  await page.keyboard.press('ControlOrMeta+z');
  await settleChangeDebounce(page);
  await page.keyboard.type('b');
  await settleChangeDebounce(page);
  expect(await getContent(page)).toBe('baseb\n');

  await page.keyboard.press('ControlOrMeta+Shift+z');
  await settleChangeDebounce(page);
  expect(await getContent(page)).toBe('baseb\n');
});

// The guard that keeps Redo from undoing claims nothing it does not run: an
// uppercase Ctrl+Shift+Z (Caps Lock off) with nothing to redo is left to the
// browser's default action, not swallowed.
test('Ctrl+Shift+Z with nothing to redo leaves the key to the browser', async ({ page }) => {
  await hostSetContent(page, 'base');
  await focusEditor(page);
  await page.evaluate(() => {
    const w = window as unknown as { lastKeyPrevented?: boolean };
    window.addEventListener('keydown', (event) => {
      w.lastKeyPrevented = event.defaultPrevented;
    });
  });
  await page.keyboard.press('ControlOrMeta+Shift+Z');
  await settleChangeDebounce(page);
  expect(await getContent(page)).toBe('base');
  expect(
    await page.evaluate(
      () => (window as unknown as { lastKeyPrevented?: boolean }).lastKeyPrevented,
    ),
  ).toBe(false);
});
