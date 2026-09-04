import { expect, test, type Page } from '@playwright/test';

import { EDITOR, editorMarkdown, openNewNote, TYPE_DELAY_MS } from './lib/desktopEditor';

/**
 * The `/` block menu on the desktop shell — Milkdown's slash plugin, wired in
 * `src/features/editor/milkdown/slash/`.
 *
 * This is the CodeMirror block-command menu's replacement
 * (docs/plan/desktop-editor-parity.md D2). Assertions are on the note's
 * MARKDOWN, not on the rendered DOM: what a menu pick is worth is what gets
 * saved.
 */

const MENU = '.futo-slash-menu';
const ROW = `${MENU} li`;

/** Visible means shown — SlashProvider hides with `data-show="false"`. */
async function expectMenuOpen(page: Page): Promise<void> {
  await expect(page.locator(MENU)).toBeVisible();
}

async function expectMenuClosed(page: Page): Promise<void> {
  await expect(page.locator(MENU)).toBeHidden();
}

async function typeSlash(page: Page, text: string): Promise<void> {
  await page.locator(EDITOR).click();
  await page.keyboard.type(text, { delay: TYPE_DELAY_MS });
}

test.describe('slash menu', () => {
  test.beforeEach(async ({ page }) => {
    await openNewNote(page);
  });

  test('typing / at the start of a block opens the menu with every item', async ({ page }) => {
    await typeSlash(page, '/');
    await expectMenuOpen(page);
    await expect(page.locator(ROW)).toHaveCount(11);
  });

  test('the query filters the menu', async ({ page }) => {
    await typeSlash(page, '/head');
    await expectMenuOpen(page);
    await expect(page.locator(ROW)).toHaveCount(3);
    await expect(page.locator(ROW).first()).toContainText('Heading 1');
  });

  test('a query that matches nothing hides the menu', async ({ page }) => {
    await typeSlash(page, '/zzzz');
    await expectMenuClosed(page);
  });

  test('Enter picks the highlighted item and removes the typed run', async ({ page }) => {
    await typeSlash(page, '/quote');
    await expectMenuOpen(page);
    await page.keyboard.press('Enter');
    await expectMenuClosed(page);

    await page.keyboard.type('hello', { delay: TYPE_DELAY_MS });
    expect(await editorMarkdown(page)).toContain('> hello');
    // The `/quote` the user typed to reach the menu is not part of the note.
    expect(await editorMarkdown(page)).not.toContain('/quote');
  });

  test('arrow keys move the highlight, and Enter takes that item', async ({ page }) => {
    await typeSlash(page, '/head');
    await expectMenuOpen(page);
    await expect(page.locator(`${ROW}[aria-selected="true"]`)).toContainText('Heading 1');

    await page.keyboard.press('ArrowDown');
    await expect(page.locator(`${ROW}[aria-selected="true"]`)).toContainText('Heading 2');

    await page.keyboard.press('Enter');
    await page.keyboard.type('title', { delay: TYPE_DELAY_MS });
    expect(await editorMarkdown(page)).toContain('## title');
  });

  test('clicking a row picks it', async ({ page }) => {
    await typeSlash(page, '/task');
    await expectMenuOpen(page);
    await page.locator(ROW).first().click();
    await page.keyboard.type('buy milk', { delay: TYPE_DELAY_MS });
    expect(await editorMarkdown(page)).toContain('[ ] buy milk');
  });

  test('Escape closes the menu and leaves the typed text alone', async ({ page }) => {
    await typeSlash(page, '/quo');
    await expectMenuOpen(page);
    await page.keyboard.press('Escape');
    await expectMenuClosed(page);

    // It stays closed while the same run is still being typed.
    await page.keyboard.type('te', { delay: TYPE_DELAY_MS });
    await expectMenuClosed(page);
    expect(await editorMarkdown(page)).toContain('/quote');
  });

  test('a / that is not the first character on the line is just a character', async ({ page }) => {
    await typeSlash(page, 'and/or');
    await expectMenuClosed(page);
    expect(await editorMarkdown(page)).toContain('and/or');
  });

  test('a space after the / closes the menu', async ({ page }) => {
    await typeSlash(page, '/');
    await expectMenuOpen(page);
    await page.keyboard.type(' ', { delay: TYPE_DELAY_MS });
    await expectMenuClosed(page);
  });

  test('picking Divider inserts a horizontal rule', async ({ page }) => {
    await typeSlash(page, '/divider');
    await expectMenuOpen(page);
    await page.keyboard.press('Enter');
    await expect(page.locator(`${EDITOR} hr`)).toHaveCount(1);
    // `***`, not `---`: remark-stringify's default thematic-break marker. The
    // editor pins `bullet: '-'` (MilkdownEditor.svelte) but not `rule`, so a
    // note that ALREADY contains `---` is rewritten to `***` on its first
    // edit — a pre-existing round-trip normalization this menu only makes
    // easier to reach. Changing the marker is a serializer change and has to be
    // measured against the corpus first (`just milkdown-census --diff`,
    // packages/editor/AGENTS.md), so this asserts what the editor does today.
    await expect.poll(async () => await editorMarkdown(page)).toContain('***');
  });

  test('picking Table inserts a header row plus two body rows', async ({ page }) => {
    await typeSlash(page, '/table');
    await expectMenuOpen(page);
    await page.keyboard.press('Enter');
    await expect(page.locator(`${EDITOR} table`)).toHaveCount(1);
    await expect(page.locator(`${EDITOR} table tr`)).toHaveCount(3);
  });

  test('picking Code block gives a fence', async ({ page }) => {
    await typeSlash(page, '/code');
    await expectMenuOpen(page);
    await page.keyboard.press('Enter');
    await expect(page.locator(`${EDITOR} pre`)).toHaveCount(1);
  });

  test('a / inside a code block does not open the menu', async ({ page }) => {
    await typeSlash(page, '/code');
    await page.keyboard.press('Enter');
    await expect(page.locator(`${EDITOR} pre`)).toHaveCount(1);
    await page.keyboard.type('/head', { delay: TYPE_DELAY_MS });
    await expectMenuClosed(page);
  });
});
