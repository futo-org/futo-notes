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
    await expect(page.locator(ROW)).toHaveCount(13);
  });

  test('the menu offers Image', async ({ page }) => {
    await typeSlash(page, '/');
    await expectMenuOpen(page);
    await expect(page.locator(`${ROW}[data-slash-id="image"]`)).toContainText('Image');
  });

  test('Image is reachable by the words a reader would type for it', async ({ page }) => {
    for (const query of ['image', 'picture', 'photo', 'img']) {
      await openNewNote(page);
      await typeSlash(page, `/${query}`);
      await expectMenuOpen(page);
      await expect(page.locator(`${ROW}[data-slash-id="image"]`)).toHaveCount(1);
    }
  });

  /*
   * Picking Image opens the HOST's file picker, which only exists on Tauri
   * desktop — `PlatformFS.pickImage`, a native dialog Playwright's browser has
   * no equivalent of. What this asserts is the half a browser CAN see and the
   * half that protects the note: the pick is accepted, the typed `/image` run
   * is removed like any other item's, and nothing bogus is written when the
   * host has no picker to answer with. The picker call itself, the vault write
   * and the inserted `![](…)` are covered against a mocked `PlatformFS` in
   * `src/features/editor/milkdown/slash/exec.test.ts` and
   * `src/features/editor/imageInsert.test.ts`.
   */
  test('picking Image consumes the typed run and writes no image markdown', async ({ page }) => {
    await typeSlash(page, '/image');
    await expectMenuOpen(page);
    await page.keyboard.press('Enter');
    await expectMenuClosed(page);

    const markdown = await editorMarkdown(page);
    expect(markdown).not.toContain('/image');
    expect(markdown).not.toContain('![](');
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

  test('picking Divider inserts a horizontal rule with no leftover "/divider" text (QA-010/013)', async ({
    page,
  }) => {
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
    // QA-013: the typed `/divider` run used to survive as literal text right
    // after the rule (the run's remembered position no longer described the
    // post-command document, so the delete silently no-opped).
    expect(await editorMarkdown(page)).not.toContain('divider');
    // The caret is ready to type in an empty paragraph right after the rule.
    await page.keyboard.type('after', { delay: TYPE_DELAY_MS });
    expect(await editorMarkdown(page)).toMatch(/\*\*\*\s*\n\s*after/);
  });

  test('picking Table inserts a header row plus two body rows', async ({ page }) => {
    await typeSlash(page, '/table');
    await expectMenuOpen(page);
    await page.keyboard.press('Enter');
    await expect(page.locator(`${EDITOR} table`)).toHaveCount(1);
    await expect(page.locator(`${EDITOR} table tr`)).toHaveCount(3);
  });

  test('picking Code block gives a fence with no leftover "/code" text (QA-010)', async ({
    page,
  }) => {
    await typeSlash(page, '/code');
    await expectMenuOpen(page);
    await page.keyboard.press('Enter');
    await expect(page.locator(`${EDITOR} pre`)).toHaveCount(1);
    // The literal bug: the typed run used to survive AS the fence's content,
    // because the old commit() ran the command before deleting it, and a
    // code block's content is literal text a post-command read can't see
    // into. Assert the fence is genuinely empty, not just present.
    await expect(page.locator(`${EDITOR} pre`)).toHaveText('');
    expect(await editorMarkdown(page)).not.toContain('/code');
  });

  test('a / inside a code block does not open the menu', async ({ page }) => {
    await typeSlash(page, '/code');
    await page.keyboard.press('Enter');
    await expect(page.locator(`${EDITOR} pre`)).toHaveCount(1);
    await page.keyboard.type('/head', { delay: TYPE_DELAY_MS });
    await expectMenuClosed(page);
  });

  /*
   * QA-019 — Link, added to the `/` menu. It opens the SAME URL prompt the
   * desktop selection toolbar's Link button does (`linkPrompt/`); the deeper
   * "existing link" / "prefilled field" behavior is `selection-toolbar.spec.ts`'s
   * to prove, since the `/` menu's Link only ever fires on a plain caret.
   */
  test('the menu offers Link', async ({ page }) => {
    await typeSlash(page, '/');
    await expectMenuOpen(page);
    await expect(page.locator(`${ROW}[data-slash-id="link"]`)).toContainText('Link');
  });

  test('picking Link opens the URL prompt; Enter inserts the URL as a selected label', async ({
    page,
  }) => {
    await typeSlash(page, '/link');
    await expectMenuOpen(page);
    await page.keyboard.press('Enter');
    await expectMenuClosed(page);

    const url = page.locator('input[aria-label="Link URL"]');
    await expect(url).toBeVisible();
    await expect(url).toBeFocused();
    await url.fill('https://example.test/docs');
    await url.press('Enter');

    // Inserted with the URL as its own label — asserted on the DOM, not the
    // markdown: remark-stringify shortens a link whose text equals its href
    // to the autolink form (`<https://…>`), which is a serializer choice, not
    // what this asserts. Typing right away replaces the label — proof the
    // label text was left SELECTED, not just inserted after it.
    const link = page.locator(`${EDITOR} a[href="https://example.test/docs"]`);
    await expect(link).toHaveText('https://example.test/docs');
    await page.keyboard.type('the docs', { delay: TYPE_DELAY_MS });
    expect(await editorMarkdown(page)).toContain('[the docs](https://example.test/docs)');
    // The typed `/link` run is gone — never restored alongside the link.
    expect(await editorMarkdown(page)).not.toContain('/link');
  });

  test('cancelling the Link prompt with Escape leaves the note untouched', async ({ page }) => {
    await typeSlash(page, '/link');
    await expectMenuOpen(page);
    await page.keyboard.press('Enter');
    await expectMenuClosed(page);

    const url = page.locator('input[aria-label="Link URL"]');
    await expect(url).toBeVisible();
    await url.press('Escape');

    // The typed `/link` run is gone (deleted before the prompt ever opened),
    // and nothing was inserted in its place.
    expect(await editorMarkdown(page)).not.toContain('/link');
    expect(await editorMarkdown(page)).not.toContain('[');
  });
});
