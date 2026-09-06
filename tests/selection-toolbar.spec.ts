import { expect, test, type Page } from '@playwright/test';

import {
  EDITOR,
  openNewNote,
  setEditorMarkdown,
  typeInEditor,
  waitForMarkdown,
} from './lib/desktopEditor';

/**
 * The floating selection toolbar on the desktop shell — Milkdown's tooltip
 * plugin, wired in `src/features/editor/milkdown/selectionToolbar/`.
 *
 * This is the CodeMirror selection toolbar's replacement
 * (docs/plan/desktop-editor-parity.md D1). Assertions are on the note's
 * MARKDOWN: what a button is worth is what gets saved.
 */

const BAR = '.futo-selection-toolbar';
const button = (label: string) => `${BAR} button[aria-label="${label}"]`;

/** Visible means shown — TooltipProvider hides with `data-show="false"`. */
async function expectBarOpen(page: Page): Promise<void> {
  await expect(page.locator(BAR)).toBeVisible();
}

async function expectBarClosed(page: Page): Promise<void> {
  await expect(page.locator(BAR)).toBeHidden();
}

/** Type `text`, then select its last `count` characters with the keyboard. */
async function typeAndSelectTail(page: Page, text: string, count: number): Promise<void> {
  await typeInEditor(page, text);
  for (let i = 0; i < count; i += 1) await page.keyboard.press('Shift+ArrowLeft');
}

test.describe('selection toolbar', () => {
  test.beforeEach(async ({ page }) => {
    await openNewNote(page);
  });

  test('a caret shows no toolbar; selecting text shows it', async ({ page }) => {
    await typeInEditor(page, 'hello world');
    await expectBarClosed(page);

    for (let i = 0; i < 5; i += 1) await page.keyboard.press('Shift+ArrowLeft');
    await expectBarOpen(page);
    await expect(page.locator(button('Bold'))).toBeVisible();
    await expect(page.locator(button('Italic'))).toBeVisible();
    await expect(page.locator(button('Strikethrough'))).toBeVisible();
    await expect(page.locator(button('Code'))).toBeVisible();
    await expect(page.locator(button('Link'))).toBeVisible();
  });

  test('Bold wraps the selection and lights up, and the selection survives the click', async ({
    page,
  }) => {
    await typeAndSelectTail(page, 'hello world', 5);
    await expectBarOpen(page);

    await page.locator(button('Bold')).click();
    await waitForMarkdown(page, 'hello **world**');
    await expect(page.locator(button('Bold'))).toHaveAttribute('aria-pressed', 'true');
    await expectBarOpen(page);

    // Toggle it straight back off from the same bar.
    await page.locator(button('Bold')).click();
    await waitForMarkdown(page, 'hello world');
    await expect(page.locator(button('Bold'))).toHaveAttribute('aria-pressed', 'false');
  });

  test('Italic, Strikethrough and Code each write their markdown', async ({ page }) => {
    await typeAndSelectTail(page, 'a word', 4);
    await page.locator(button('Italic')).click();
    await waitForMarkdown(page, 'a *word*');
    await page.locator(button('Italic')).click();
    await waitForMarkdown(page, 'a word');

    await page.locator(button('Strikethrough')).click();
    await waitForMarkdown(page, 'a ~~word~~');
    await page.locator(button('Strikethrough')).click();
    await waitForMarkdown(page, 'a word');

    await page.locator(button('Code')).click();
    await waitForMarkdown(page, 'a `word`');
  });

  test('Link opens a URL field, and Enter writes the link', async ({ page }) => {
    await typeAndSelectTail(page, 'read the docs', 4);
    await page.locator(button('Link')).click();

    const url = page.locator(`${BAR} input[aria-label="Link URL"]`);
    await expect(url).toBeVisible();
    await expect(url).toBeFocused();
    await url.fill('https://example.test/docs');
    await url.press('Enter');

    await waitForMarkdown(page, 'read the [docs](https://example.test/docs)');
    // Focus is back in the note, so the writer can keep typing.
    await expect(page.locator(EDITOR)).toBeFocused();
  });

  test('on an existing link the field is prefilled, and emptying it removes the link', async ({
    page,
  }) => {
    await setEditorMarkdown(page, 'see [the docs](https://example.test) now\n');
    // Select "the docs" by clicking into the link text and extending by word.
    await page.locator(`${EDITOR} a`).click();
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    for (let i = 0; i < 8; i += 1) await page.keyboard.press('Shift+ArrowRight');
    await expectBarOpen(page);
    await expect(page.locator(button('Edit link'))).toHaveAttribute('aria-pressed', 'true');

    await page.locator(button('Edit link')).click();
    const url = page.locator(`${BAR} input[aria-label="Link URL"]`);
    await expect(url).toHaveValue('https://example.test');

    await url.fill('https://example.test/moved');
    await url.press('Enter');
    await waitForMarkdown(page, 'see [the docs](https://example.test/moved) now');

    // Same selection, same bar: clear the URL to unlink.
    await expectBarOpen(page);
    await page.locator(button('Edit link')).click();
    await url.fill('');
    await url.press('Enter');
    await waitForMarkdown(page, 'see the docs now');
  });

  test('Escape in the URL field leaves the note as it was', async ({ page }) => {
    await typeAndSelectTail(page, 'plain text', 4);
    await page.locator(button('Link')).click();
    const url = page.locator(`${BAR} input[aria-label="Link URL"]`);
    await url.fill('https://example.test');
    await url.press('Escape');
    await waitForMarkdown(page, 'plain text');
    await expect(page.locator(EDITOR)).toBeFocused();
  });

  test('inside a fenced code block the toolbar stays hidden', async ({ page }) => {
    await setEditorMarkdown(page, 'prose\n\n```\nconst x = 1\n```\n');
    await page.locator(`${EDITOR} pre`).click();
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');
    // A selection exists, but nothing in a fence is markup.
    await expect(page.locator(EDITOR)).toBeFocused();
    await expectBarClosed(page);
  });

  test('clicking outside the note hides the toolbar', async ({ page }) => {
    await typeAndSelectTail(page, 'hello world', 5);
    await expectBarOpen(page);
    await page.locator('.title-input').click();
    await expectBarClosed(page);
  });
});
