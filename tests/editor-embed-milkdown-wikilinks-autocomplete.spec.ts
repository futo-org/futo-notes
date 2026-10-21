// Part of the Milkdown wikilinks suite: what it covers and why is described in
// editor-embed-milkdown-wikilinks.spec.ts.

import { expect, type Locator, type Page } from '@playwright/test';
import {
  flushFrames,
  focusEditor,
  getContent,
  messagesOfType,
  waitForMessages,
  withCaretObserved,
  type FakeHostWindow,
} from './lib/editorEmbedHost';
import {
  VAULT,
  test,
  settleChangeDebounce,
  moveCaret,
  goToEnd,
  open,
  chip,
} from './lib/editorEmbedMilkdownWikilinks';

// ============================================================
// `[[` autocomplete
// ============================================================

/**
 * Wait until the markdown the editor last REPORTED is `expected`. The
 * listener's 200 ms trailing debounce posts the half-typed `[[road` on its own
 * whenever the waits between keystrokes outlast it, as they do on a busy CI
 * runner, so the first `change` message is not necessarily the final one.
 */
async function expectReported(page: Page, expected: string): Promise<void> {
  await expect
    .poll(async () => (await messagesOfType(page, 'change')).at(-1)?.content)
    .toBe(expected);
}

const popup = (page: Page) => page.locator('.futo-wikilink-suggest');
const rows = (page: Page) => popup(page).locator('li');

test('typing `[[` opens the whole note list', async ({ page }) => {
  await open(page, '');
  await focusEditor(page);
  await page.keyboard.type('[[');
  await expect(rows(page)).toHaveCount(VAULT.length);
});

test('typing filters the list case-insensitively', async ({ page }) => {
  await open(page, '');
  await focusEditor(page);
  await page.keyboard.type('[[road');
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).first()).toContainText('Projects/Roadmap');
});

// toLowerCase folds a capital sigma to ς at a word end and σ before a letter,
// so `[[ΟΔΟΣ` must still offer the note `ΟΔΟΣΑ`.
test('an upper-case Greek query ending in sigma offers the longer title', async ({ page }) => {
  await open(page, '', [{ id: 'ΟΔΟΣΑ', title: 'ΟΔΟΣΑ', modifiedMs: 0 }]);
  await focusEditor(page);
  await page.keyboard.type('[[ΟΔΟΣ');
  await expect(popup(page)).toBeVisible();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText('ΟΔΟΣΑ');
});

test('Enter inserts the FULL path and leaves the caret AFTER the link', async ({ page }) => {
  await open(page, '');
  await focusEditor(page);
  await page.keyboard.type('[[ideas');
  await expect(rows(page)).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(popup(page)).toBeHidden();

  // Typing continues past the link, not inside it — the spec's caret rule.
  await page.keyboard.type(' next');
  await expectReported(page, '[[work/notes/ideas]] next\n');
  // What the reader sees is still the short form.
  await expect(chip(page)).toHaveText('ideas');
});

/** Puts the caret at the end of `target`'s text with a real click just right of it. */
async function clickLineEnd(page: Page, target: Locator): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error('clickLineEnd: target is not visible');
  await page.mouse.click(box.x + box.width - 2, box.y + box.height / 2);
}

test('Enter accepts the suggestion inside a CHECKED task item instead of splitting it', async ({
  page,
}) => {
  // The direct `handleKeyDown` of keyboardParity.ts claims Enter in a checked
  // task ("split, new item unchecked"); it runs before the popup's own keymap,
  // so the suggestion used to be left as literal `\[\[ideas` and an empty item
  // was added underneath (RC-20).
  await open(page, '- [x] done\n');
  await clickLineEnd(page, page.locator('.ProseMirror li p'));
  await page.keyboard.type('[[ideas');
  await expect(rows(page)).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(popup(page)).toBeHidden();
  // The trailing blank line after a list is a separate known serializer quirk
  // (RC-22), so pin the item line itself: accepted in place, no second item.
  await expect
    .poll(async () => (await messagesOfType(page, 'change')).at(-1)?.content?.trimEnd())
    .toBe('- [x] done[[work/notes/ideas]]');
});

test('Enter accepts the suggestion inside a table cell instead of moving the caret', async ({
  page,
}) => {
  // Same Enter-claim family as above: the table's Enter (move down / append a
  // row) used to win over the popup.
  await open(page, '| a | b |\n| - | - |\n| c | d |\n');
  await clickLineEnd(page, page.locator('.ProseMirror tr:last-child td:last-child p'));
  await page.keyboard.type('[[ideas');
  await expect(rows(page)).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(popup(page)).toBeHidden();
  // The table serializer pads columns to the widest cell; pin the cell.
  await expect
    .poll(async () => (await messagesOfType(page, 'change')).at(-1)?.content)
    .toContain('| c | d[[work/notes/ideas]] |\n');
});

test('arrow keys move the highlighted row and Enter takes it', async ({ page }) => {
  await open(page, '');
  await focusEditor(page);
  await page.keyboard.type('[[road');
  await expect(rows(page).nth(0)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(rows(page).nth(1)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expectReported(page, '[[Archive/2024/Roadmap]]\n');
});

test('tapping a row inserts that note', async ({ page }) => {
  await open(page, '');
  await focusEditor(page);
  await page.keyboard.type('[[groc');
  await rows(page).first().tap();

  // Typing `[[groc` is itself a debounced edit, and the tap right behind it
  // is a second, independent one — on a slower/contended CI runner the gap
  // between them can exceed the debounce window, so the TYPING's own change
  // can post (with the pre-tap `[[groc` text) before the tap's insertion
  // does. Grabbing "the first 'change' message" then reads the wrong one, no
  // matter how long the wait. Wait for the specific content the tap
  // produces instead — the condition this test actually cares about.
  await page.waitForFunction(() => {
    const w = window as unknown as FakeHostWindow & {
      __msgs: { type: string; content?: string }[];
    };
    return w.__msgs.some((m) => m.type === 'change' && m.content === '[[grocery list]]\n');
  });
  const changes = await messagesOfType(page, 'change');
  expect(changes.at(-1)?.content).toBe('[[grocery list]]\n');
});

test('Escape closes the popup and keeps it closed while the run is typed', async ({ page }) => {
  await open(page, '');
  await focusEditor(page);
  await page.keyboard.type('[[road');
  await expect(popup(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popup(page)).toBeHidden();
  await page.keyboard.type('m');
  await expect(popup(page)).toBeHidden();
});

test('`[[` inside inline code never opens the popup', async ({ page }) => {
  // docs/spec/editor.md: wikilinks inside inline code are not decorated and not
  // extracted — so autocomplete must not offer to write one there either.
  await open(page, 'text `code` tail\n');
  await focusEditor(page);
  await goToEnd(page);
  /* Land BETWEEN two characters of the span, not on its edge: code marks are
   * non-inclusive, so a caret at the closing edge is genuinely outside the
   * span and typing there is not code. " tail" is 5, plus 2 into "code". */
  await moveCaret(page, 'ArrowLeft', 7);
  await page.keyboard.type('[[');
  await expect(popup(page)).toBeHidden();
  /* `toBeHidden` alone passes before a popup could ever appear, and would pass
   * just as well if the caret had missed the span. Prove the premise: the
   * brackets went INTO the code span. */
  await settleChangeDebounce(page);
  expect(await getContent(page)).toBe('text `co[[de` tail\n');
  await expect(popup(page)).toBeHidden();
});

test('typing a full wikilink inside inline code leaves it as text', async ({ page }) => {
  await open(page, '`abc`\n');
  await focusEditor(page);
  await goToEnd(page);
  await moveCaret(page, 'ArrowLeft', 2);
  await page.keyboard.type('[[grocery list]]');
  const [change] = await waitForMessages(page, 'change');
  expect(await chip(page).count()).toBe(0);
  expect(change.content).toContain('[[grocery list]]');
});

test('Escape is remembered across a query that matches nothing', async ({ page }) => {
  await open(page, '');
  await focusEditor(page);
  await page.keyboard.type('[[road');
  await page.keyboard.press('Escape');
  await expect(popup(page)).toBeHidden();
  // A no-match query used to forget the dismissal, so backspacing reopened it.
  await page.keyboard.type('zzz');
  await expect(popup(page)).toBeHidden();
  for (let i = 0; i < 3; i += 1) await page.keyboard.press('Backspace');
  await expect(popup(page)).toBeHidden();
});

test('a query that matches nothing shows no popup', async ({ page }) => {
  await open(page, '');
  await focusEditor(page);
  await page.keyboard.type('[[zzzz');
  await expect(popup(page)).toBeHidden();
});

test('typing a wikilink out in full turns into a link on the closing brackets', async ({
  page,
}) => {
  await open(page, '');
  await focusEditor(page);
  await page.keyboard.type('[[grocery list');
  await page.keyboard.press('Escape');
  await page.keyboard.type(']]');
  await expect(chip(page)).toHaveText('grocery list');
  await expectReported(page, '[[grocery list]]\n');
});

test('a wikilink typed with a `|` in a table cell keeps its row and its link', async ({ page }) => {
  // A GFM row is split on every unescaped `|` before inline parsing, so the
  // handler has to write `[[note\\|alias]]` in a cell. Written raw, the next
  // open split the cell, and the next edit widened the table and escaped the
  // link into `\\[\\[note` text (hardening L6e-15).
  await open(page, '| a | b |\n| - | - |\n| c | d |\n');
  await withCaretObserved(page, () => page.getByText('c', { exact: true }).click());
  await goToEnd(page); // the click may already have left the caret at the end
  await page.keyboard.type(' [[note|alias');
  await page.keyboard.press('Escape');
  await page.keyboard.type(']]');
  await expect(chip(page)).toHaveCount(1);
  await settleChangeDebounce(page);
  const saved = await getContent(page);
  expect(saved).toContain('| c [[note\\|alias]] | d |');

  await page.evaluate(() =>
    (window as unknown as FakeHostWindow).FutoEditor.setContent('test-note', '-'),
  );
  await page.evaluate(
    (m) => (window as unknown as FakeHostWindow).FutoEditor.setContent('test-note', m),
    saved,
  );
  await flushFrames(page);
  const cells = page.locator('.ProseMirror tr').nth(1).locator('td, th');
  await expect(cells, saved).toHaveCount(2);
  await expect(chip(page)).toHaveCount(1);
});

// ============================================================
// A `!` that starts no embed (issue #112)
// ============================================================

/**
 * The `![[embed]]` lookahead used to open its `wikilink` token before it knew a
 * `[[` followed, and consuming the end of the input stranded that token open —
 * so the enclosing paragraph or table cell could never close, the parse threw,
 * and the note opened BLANK on every shell. The reference note that could not
 * be opened at all was a table with `no!!` in a header cell.
 *
 * The unit differential (`wikilink/syntax.test.ts`) locks the grammar; this
 * asks the only question the user has — does the note open, and is it still the
 * same note afterwards.
 */
const BANG_TABLE = '| a | no!! |\n| - | ---- |\n| x | y    |\n';

test('a table whose header cell ends in `!` opens instead of throwing', async ({ page }) => {
  const crashes: string[] = [];
  page.on('pageerror', (error) => crashes.push(error.message));

  await open(page, BANG_TABLE);

  // The note RENDERED: a real table, not the blank editor a thrown parse leaves.
  await expect(page.locator('.ProseMirror table')).toHaveCount(1);
  await expect(page.locator('.ProseMirror table th').nth(1)).toHaveText('no!!');
  expect(crashes).toEqual([]);
  // And opening it did not rewrite it.
  expect(await getContent(page)).toBe(BANG_TABLE);
});

test('a paragraph ending in `!` opens and round-trips', async ({ page }) => {
  const crashes: string[] = [];
  page.on('pageerror', (error) => crashes.push(error.message));

  // The headline shape from the issue: the `!` is the last thing on the line.
  const source = 'What a note!\n\nAnd another one!\n';
  await open(page, source);

  await expect(page.locator('.ProseMirror p').first()).toHaveText('What a note!');
  expect(crashes).toEqual([]);
  expect(await getContent(page)).toBe(source);
});

test('the `!` lookahead still claims the bang in front of a real embed', async ({ page }) => {
  // The construct's whole reason to exist: without it micromark's image label
  // eats `![` and the surviving `[` cannot start a wikilink.
  await open(page, '![[Projects/Roadmap]]\n');
  await expect(chip(page)).toHaveText('Projects/Roadmap');
});
