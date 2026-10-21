// Part of the futoBridge Milkdown suite: scope and input rules are in
// editor-embed-milkdown.spec.ts.

import { expect } from '@playwright/test';
import {
  clearMessages,
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
  hostSetContent,
  placeCaretInto,
  pasteClipboard,
} from './lib/editorEmbedMilkdown';

test('an edit keeps a link definition nothing references', async ({ page }) => {
  // The preset deleted every definition on the first save; one that no link
  // used took its URL and title with it (RC-41).
  const note = 'Some text here.\n\n[docs]: https://example.com/docs "Docs"\n';
  await hostSetContent(page, note);
  await clearMessages(page);

  await page.locator('.ProseMirror p').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type('!');

  const changes = await waitForMessages(page, 'change');
  expect(changes).toHaveLength(1);
  expect(changes[0].content).toBe(note.replace('here.', 'here.!'));
});

test('an edit beside a table with a wide row keeps every value in its column', async ({ page }) => {
  // One trailing `| |` made fixTables pad every row above it at the START, and
  // the edit elsewhere saved `apple` under no header at all (RC-42).
  await hostSetContent(
    page,
    'Prices\n\n| item | price |\n| - | - |\n| apple | 3 |\n| pear | 4 | |\n\nend\n',
  );
  await clearMessages(page);

  await page.locator('.ProseMirror p').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type('!');

  const changes = await waitForMessages(page, 'change');
  expect(changes).toHaveLength(1);
  expect(changes[0].content).toBe(
    'Prices!\n\n| item | price |  |\n| --- | --- | --- |\n| apple | 3 |  |\n| pear | 4 |  |\n\nend\n',
  );
});

test('an edit to a note that ends in a list adds no trailing blank line', async ({ page }) => {
  // The `trailing` plugin parks an empty paragraph below a last list, quote,
  // table, fence or rule, and the first edit used to write it as `\n\n` at the
  // end of the file (RC-22). The spec drops a trailing empty paragraph on save.
  for (const [note, edited] of [
    ['- a\n- b\n', '- aX\n- b\n'],
    ['> a\n', '> aX\n'],
    ['| a | b |\n| --- | --- |\n| 1 | 2 |\n', '| aX | b |\n| --- | --- |\n| 1 | 2 |\n'],
  ] as const) {
    await hostSetContent(page, note);
    await clearMessages(page);
    await page.locator('.ProseMirror :is(li, blockquote, th) p').first().click();
    await page.keyboard.press('End');
    await page.keyboard.type('X');
    const changes = await waitForMessages(page, 'change');
    expect(changes[changes.length - 1].content).toBe(edited);
  }
});

test('a table pasted as plain text is written the way an opened one is', async ({ page }) => {
  // A paste goes through the DOM, where the gfm preset read a cell with no
  // alignment back as `left`: the pasted table saved `| :- |`, the same table
  // opened and edited saved `| -- |` (RC-59). Into an empty note the paste
  // takes the empty line: Milkdown's plain-text route used to keep it, saving a
  // blank line above the table.
  const table = '| a | b |\n| --- | --- |\n| 1 | 2 |\n';
  for (const [note, expected] of [
    ['one\n', `one\n\n${table}`],
    ['', table],
  ] as const) {
    await hostSetContent(page, note);
    await focusEditor(page);
    await page.keyboard.press('Control+End');
    await pasteClipboard(page, { 'text/plain': table });
    await settleChangeDebounce(page);

    expect(await getContent(page)).toBe(expected);
  }
});

test('applyExternalContent adopts differing content without a change echo', async ({ page }) => {
  await hostSetContent(page, 'original');
  await clearMessages(page);

  await page.evaluate(() =>
    (window as unknown as FakeHostWindow).FutoEditor.applyExternalContent(
      'test-note',
      'adopted from a peer',
      (window as unknown as FakeHostWindow).__futoTest.documentRef().generation,
    ),
  );
  await settleChangeDebounce(page);

  expect(await getContent(page)).toBe('adopted from a peer');
  expect(await messagesOfType(page, 'change')).toHaveLength(0);
});

test('applyExternalContent with unchanged content preserves the selection', async ({ page }) => {
  await hostSetContent(page, 'abcdef');
  await focusEditor(page);
  await placeCaretInto(page, 3);
  await clearMessages(page);

  // No-op adopt (content identical): must not reset the caret to 0 or the end.
  await page.evaluate(() =>
    (window as unknown as FakeHostWindow).FutoEditor.applyExternalContent(
      'test-note',
      'abcdef',
      (window as unknown as FakeHostWindow).__futoTest.documentRef().generation,
    ),
  );
  await flushFrames(page);
  await page.keyboard.type('Z');

  await waitForMessages(page, 'change');
  expect(await getContent(page)).toBe('abcZdef\n');
});
