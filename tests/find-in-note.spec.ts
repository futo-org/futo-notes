import { expect, test, type Page } from '@playwright/test';

import { EDITOR, openNewNote, setEditorMarkdown } from './lib/desktopEditor';

/**
 * Find in note on the DESKTOP shell (docs/spec/editor.md "Find in note", issue
 * #26) — the web find bar and its two accelerators.
 *
 * The engine itself is shared with the native shells and is asserted over the
 * bridge in `editor-embed-milkdown-find.spec.ts`; what is desktop-only, and so
 * only provable here, is the bar's placement, its keyboard contract, and the
 * Ctrl/Cmd+F / Ctrl/Cmd+G accelerators reaching it from anywhere in the shell.
 *
 * This replaces the CodeMirror suite of the same name (commit 8e902802).
 */

const PANEL = '.futo-find-panel';
const QUERY = '.futo-find-query';
const COUNT = '.futo-find-count';
const MATCH = '.futo-find-match';
const CURRENT = '.futo-find-match-current';

async function openFind(page: Page): Promise<void> {
  await page.keyboard.press('ControlOrMeta+f');
  await expect(page.locator(QUERY)).toBeFocused();
}

test.describe('find in note', () => {
  test('opens docked at the bottom of the note pane, with the query focused', async ({ page }) => {
    await openNewNote(page);
    await setEditorMarkdown(page, 'cat dog CAT');

    await openFind(page);

    const placement = await page.locator(PANEL).evaluate((panel) => {
      const pane = document.querySelector('.note-body');
      return {
        panel: panel.getBoundingClientRect().toJSON(),
        pane: pane?.getBoundingClientRect().toJSON() ?? null,
      };
    });
    expect(placement.pane).not.toBeNull();
    // Docked over the bottom of the shell's scrolling pane, full width.
    expect(placement.panel.bottom).toBeCloseTo(placement.pane?.bottom ?? -1, 0);
    expect(placement.panel.x).toBeCloseTo(placement.pane?.x ?? -1, 0);
    expect(placement.panel.width).toBeCloseTo(placement.pane?.width ?? -1, 0);
  });

  test('counts, steps from the field and from the shell, wraps, and closes', async ({ page }) => {
    await openNewNote(page);
    await setEditorMarkdown(page, 'cat dog CAT concatenate');

    await openFind(page);
    await page.locator(QUERY).fill('cat');

    await expect(page.locator(COUNT)).toHaveText('1 of 3');
    await expect(page.locator(MATCH)).toHaveCount(3);
    await expect(page.locator(CURRENT)).toHaveCount(1);

    await page.locator(QUERY).press('Enter');
    await expect(page.locator(COUNT)).toHaveText('2 of 3');

    // From anywhere in the shell, not just the query field.
    await page.keyboard.press('ControlOrMeta+g');
    await expect(page.locator(COUNT)).toHaveText('3 of 3');
    await page.keyboard.press('ControlOrMeta+g');
    await expect(page.locator(COUNT)).toHaveText('1 of 3');
    await page.keyboard.press('ControlOrMeta+Shift+g');
    await expect(page.locator(COUNT)).toHaveText('3 of 3');

    await page.locator(QUERY).press('Escape');
    await expect(page.locator(PANEL)).toHaveCount(0);
    await expect(page.locator(MATCH)).toHaveCount(0);
    await expect(page.locator(EDITOR)).toBeFocused();

    // A closed bar makes the step accelerator a no-op; it never reopens find.
    await page.keyboard.press('ControlOrMeta+g');
    await expect(page.locator(PANEL)).toHaveCount(0);
  });

  test('seeds the query from the editor selection', async ({ page }) => {
    await openNewNote(page);
    await setEditorMarkdown(page, 'needle in a haystack');

    await page.locator(EDITOR).click();
    await page.keyboard.press('Home');
    for (let i = 0; i < 6; i += 1) await page.keyboard.press('Shift+ArrowRight');
    await openFind(page);

    await expect(page.locator(QUERY)).toHaveValue('needle');
    await expect(page.locator(COUNT)).toHaveText('1 of 1');
  });

  test('a second Ctrl+F refocuses and selects the query instead of opening a second bar', async ({
    page,
  }) => {
    await openNewNote(page);
    await setEditorMarkdown(page, 'cat cat');

    await openFind(page);
    await page.locator(QUERY).fill('cat');
    await page.locator(EDITOR).click();
    await expect(page.locator(QUERY)).not.toBeFocused();

    await page.keyboard.press('ControlOrMeta+f');

    await expect(page.locator(PANEL)).toHaveCount(1);
    await expect(page.locator(QUERY)).toBeFocused();
    expect(
      await page
        .locator(QUERY)
        .evaluate((input: HTMLInputElement) => input.selectionEnd! - input.selectionStart!),
    ).toBe(3);
  });

  test('reports zero and disables stepping when nothing matches', async ({ page }) => {
    await openNewNote(page);
    await setEditorMarkdown(page, 'cat dog');

    await openFind(page);
    await page.locator(QUERY).fill('zebra');

    await expect(page.locator(COUNT)).toHaveText('0');
    await expect(page.locator(MATCH)).toHaveCount(0);
    await expect(page.locator(`${PANEL} button[aria-label="Next match"]`)).toBeDisabled();
  });

  test('the selection toolbar stays down while find owns the editor', async ({ page }) => {
    await openNewNote(page);
    await setEditorMarkdown(page, 'cat dog cat');

    await openFind(page);
    await page.locator(QUERY).fill('cat');
    await expect(page.locator(CURRENT)).toHaveCount(1);

    await expect(page.locator('.futo-selection-toolbar')).toBeHidden();
  });

  test('typing in the note body keeps the bar open and recounts', async ({ page }) => {
    await openNewNote(page);
    await setEditorMarkdown(page, 'cat dog');

    await openFind(page);
    await page.locator(QUERY).fill('cat');
    await expect(page.locator(COUNT)).toHaveText('1 of 1');

    await page.locator(EDITOR).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' cat', { delay: 40 });

    await expect(page.locator(PANEL)).toHaveCount(1);
    await expect(page.locator(COUNT)).toHaveText('1 of 2');
  });

  test('does nothing on the Home tab', async ({ page }) => {
    await page.goto('/#/');
    await page.waitForLoadState('domcontentloaded');
    await page.keyboard.press('ControlOrMeta+f');

    await expect(page.locator(PANEL)).toHaveCount(0);
  });
});
