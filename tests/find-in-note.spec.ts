import { expect, test, type Page } from '@playwright/test';

async function openNewNote(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.goto('/#/note/new');
  await page.waitForSelector('.cm-content', { timeout: 10_000 });
}

async function setBody(page: Page, body: string): Promise<void> {
  await page.evaluate((text) => {
    const view = (
      window as typeof window & {
        __cmGetView?: () => import('@codemirror/view').EditorView | null;
      }
    ).__cmGetView?.();
    if (!view) throw new Error('editor view is unavailable');
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  }, body);
}

test.describe('Find in note', () => {
  test('opens, counts, steps, wraps, and closes from the keyboard', async ({ page }) => {
    await openNewNote(page);
    await setBody(page, 'cat dog CAT concatenate');

    await page.keyboard.press('Control+f');
    const query = page.locator('.cm-find-query');
    await expect(query).toBeFocused();
    const panelPlacement = await page.locator('.cm-find-panel').evaluate((panel) => {
      const editorPane = document.querySelector('.note-body');
      return {
        isBottomPanel: panel.parentElement?.classList.contains('cm-panels-bottom') ?? false,
        panelRect: panel.getBoundingClientRect().toJSON(),
        editorPaneRect: editorPane?.getBoundingClientRect().toJSON() ?? null,
      };
    });
    expect(panelPlacement.isBottomPanel).toBe(true);
    expect(panelPlacement.editorPaneRect).not.toBeNull();
    expect(panelPlacement.panelRect.x).toBe(panelPlacement.editorPaneRect?.x);
    expect(panelPlacement.panelRect.width).toBe(panelPlacement.editorPaneRect?.width);
    expect(panelPlacement.panelRect.bottom).toBe(panelPlacement.editorPaneRect?.bottom);
    await query.fill('cat');
    const count = page.locator('.cm-find-count');
    await expect(count).toHaveText(/^[1-3] of 3$/);
    await expect(page.locator('.cm-find-match')).toHaveCount(3);
    const initialIndex = Number((await count.textContent())?.split(' ')[0]);
    const after = (offset: number): string => `${((initialIndex - 1 + offset) % 3) + 1} of 3`;

    await query.press('Enter');
    await expect(count).toHaveText(after(1));
    await page.keyboard.press('Control+g');
    await expect(count).toHaveText(after(2));
    await page.keyboard.press('Control+g');
    await expect(count).toHaveText(after(3));
    await page.keyboard.press('Control+Shift+g');
    await expect(count).toHaveText(after(2));

    await query.press('Escape');
    await expect(page.locator('.cm-find-panel')).toHaveCount(0);
    await expect(page.locator('.cm-find-match')).toHaveCount(0);
    await expect(page.locator('.cm-content')).toBeFocused();
    await page.keyboard.press('Control+g');
    await expect(page.locator('.cm-find-panel')).toHaveCount(0);
  });

  // Regression: CodeMirror's PanelGroup.syncClasses() copies the view's theme
  // classes onto our custom panel host, and CM6's base theme carries
  // `position: relative !important` — which beat the host's `position: sticky`
  // and let the whole find bar scroll off the bottom of the pane. The first
  // test's fixture is too short to scroll the pane, so it never saw this.
  test('stays docked to the pane bottom in a note tall enough to scroll', async ({ page }) => {
    await openNewNote(page);
    await setBody(
      page,
      Array.from({ length: 120 }, (_, index) => `paragraph ${index} cat`).join('\n\n'),
    );

    const paneScrolls = await page.locator('.note-body').evaluate((pane) => {
      return pane.scrollHeight > pane.clientHeight + 1;
    });
    expect(paneScrolls).toBe(true);

    await page.keyboard.press('Control+f');
    await expect(page.locator('.cm-find-query')).toBeFocused();

    const placement = async (): Promise<{ panelBottom: number; paneBottom: number }> =>
      page.locator('.cm-find-panel').evaluate((panel) => {
        const pane = document.querySelector('.note-body');
        if (!pane) throw new Error('editor pane is unavailable');
        return {
          panelBottom: panel.getBoundingClientRect().bottom,
          paneBottom: pane.getBoundingClientRect().bottom,
        };
      });

    const atTop = await placement();
    expect(atTop.panelBottom).toBe(atTop.paneBottom);

    await page.locator('.note-body').evaluate((pane) => {
      pane.scrollTop = Math.floor((pane.scrollHeight - pane.clientHeight) / 2);
    });
    await expect(page.locator('.cm-find-panel')).toBeVisible();

    const afterScroll = await placement();
    expect(afterScroll.panelBottom).toBe(afterScroll.paneBottom);
  });

  test('reveals a source-markdown match while the query owns focus', async ({ page }) => {
    await openNewNote(page);
    await setBody(page, '[label](hidden-target)');
    await page.locator('.title-input').click();
    await expect(page.locator('.cm-content')).not.toContainText('hidden-target');

    await page.keyboard.press('Control+f');
    await page.locator('.cm-find-query').fill('hidden');
    await expect(page.locator('.cm-find-count')).toHaveText('1 of 1');

    await expect(page.locator('.cm-content')).toContainText('hidden-target');
    await expect(page.locator('.cm-find-query')).toBeFocused();
    await expect(page.locator('.cm-find-match-current')).toHaveText('hidden');
  });

  test('does nothing on the Home tab', async ({ page }) => {
    await page.goto('/#/');
    await page.waitForLoadState('domcontentloaded');
    await page.keyboard.press('Control+f');

    await expect(page.locator('.cm-find-panel')).toHaveCount(0);
  });
});
