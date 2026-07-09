import { test, expect, Page } from '@playwright/test';

/**
 * Coverage for the Crepe-style editor UX additions:
 *  - floating selection toolbar
 *  - slash command menu
 *  - block gutter handle
 *  - interactive table editor
 */

async function setupEditor(page: Page, content: string): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.goto('/#/note/new');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.cm-editor', { timeout: 10000 });
  await page.waitForSelector('.cm-content', { timeout: 10000 });
  await page.waitForFunction(() => typeof (window as any).__cmGetView === 'function');
  await page.evaluate((text) => {
    const view = (window as any).__cmGetView?.();
    if (!view) throw new Error('CM EditorView not found');
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: text.length },
    });
    view.focus();
  }, content);
  await page.waitForTimeout(200);
}

async function getDocText(page: Page): Promise<string> {
  return page.evaluate(() => (window as any).__cmGetView?.()?.state.doc.toString() ?? '');
}

async function selectRange(page: Page, from: number, to: number): Promise<void> {
  await page.evaluate(
    ({ from, to }) => {
      const view = (window as any).__cmGetView?.();
      if (!view) return;
      view.dispatch({ selection: { anchor: from, head: to } });
      view.focus();
    },
    { from, to },
  );
  await page.waitForTimeout(60);
}

async function setCursor(page: Page, pos: number): Promise<void> {
  await page.evaluate((pos) => {
    const view = (window as any).__cmGetView?.();
    if (!view) return;
    view.dispatch({ selection: { anchor: pos } });
    view.focus();
  }, pos);
  await page.waitForTimeout(60);
}

// ============================================================================
// SELECTION TOOLBAR
// ============================================================================

test.describe('Selection toolbar', () => {
  test('appears on non-empty selection, hides on empty', async ({ page }) => {
    await setupEditor(page, 'hello world');
    await selectRange(page, 0, 5);

    const toolbar = page.locator('.sf-selection-toolbar').first();
    await expect(toolbar).toBeVisible();

    await setCursor(page, 0);
    await expect(toolbar).toBeHidden();
  });

  test('editor focus state follows CodeMirror focus', async ({ page }) => {
    await setupEditor(page, 'hello world');

    await expect(page.locator('.note-body')).toHaveAttribute('data-editor-focused', '');

    await page.evaluate(() => {
      const view = (window as any).__cmGetView?.();
      view?.contentDOM.blur();
    });

    await expect(page.locator('.note-body')).not.toHaveAttribute('data-editor-focused', '');
  });

  test('bold button wraps selection in **', async ({ page }) => {
    await setupEditor(page, 'hello world');
    await selectRange(page, 0, 5);

    const toolbar = page.locator('.sf-selection-toolbar').first();
    await expect(toolbar).toBeVisible();
    await toolbar.locator('button[aria-label="Bold"]').click();

    expect(await getDocText(page)).toBe('**hello** world');
  });

  test('italic button wraps selection in *', async ({ page }) => {
    await setupEditor(page, 'hello');
    await selectRange(page, 0, 5);
    const toolbar = page.locator('.sf-selection-toolbar').first();
    await toolbar.locator('button[aria-label="Italic"]').click();
    expect(await getDocText(page)).toBe('*hello*');
  });

  test('inline code button wraps selection in backticks', async ({ page }) => {
    await setupEditor(page, 'abc def');
    await selectRange(page, 0, 3);
    const toolbar = page.locator('.sf-selection-toolbar').first();
    await toolbar.locator('button[aria-label="Inline code"]').click();
    expect(await getDocText(page)).toBe('`abc` def');
  });

  test('does not appear for multi-line selection', async ({ page }) => {
    await setupEditor(page, 'line one\nline two');
    await selectRange(page, 0, 14);
    const toolbar = page.locator('.sf-selection-toolbar');
    await expect(toolbar).toHaveCount(0);
  });

  // Regression: the selection toolbar is a DESKTOP feature and must NOT show
  // inside the native iOS/Android WebView embed (editor.html mounts
  // MarkdownEditor with nativeShell:true). It leaked back onto the native apps
  // because the gate keyed on `isMobile`, which is a Tauri-only flag that is
  // false in the native WebView. See MarkdownEditor.svelte selectionToolbar gate.
  test('stays hidden in the native embed (nativeShell)', async ({ page }) => {
    await page.goto('/editor.html');
    await page.waitForSelector('.cm-editor', { timeout: 10000 });
    await page.waitForFunction(() => typeof (window as any).__cmGetView === 'function');
    await page.evaluate(() => {
      const view = (window as any).__cmGetView?.();
      if (!view) throw new Error('CM EditorView not found');
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: 'hello world' },
        selection: { anchor: 0, head: 5 },
      });
      view.focus();
    });
    await page.waitForTimeout(200);
    await expect(page.locator('.sf-selection-toolbar')).toHaveCount(0);
  });
});

// ============================================================================
// SLASH MENU
// ============================================================================

test.describe('Slash menu', () => {
  test('opens when `/` is typed on an empty line and filters', async ({ page }) => {
    await setupEditor(page, '');
    await page.locator('.cm-content').focus();
    await page.keyboard.type('/');

    const menu = page.locator('.sf-slash-menu');
    await expect(menu).toBeVisible();
    // All commands visible initially
    const items = menu.locator('.sf-slash-menu__item');
    expect(await items.count()).toBeGreaterThan(5);

    await page.keyboard.type('head');
    // "Heading 1" should be first
    const first = menu.locator('.sf-slash-menu__item').first();
    await expect(first).toHaveAttribute('data-command-id', 'heading-1');
  });

  test('Enter commits selected command', async ({ page }) => {
    await setupEditor(page, '');
    await page.locator('.cm-content').focus();
    await page.keyboard.type('/head');
    await page.keyboard.press('Enter');

    const doc = await getDocText(page);
    expect(doc).toBe('# ');
  });

  test('ArrowDown + Enter commits different command', async ({ page }) => {
    await setupEditor(page, '');
    await page.locator('.cm-content').focus();
    await page.keyboard.type('/head');
    await page.keyboard.press('ArrowDown'); // to heading-2
    await page.keyboard.press('Enter');

    expect(await getDocText(page)).toBe('## ');
  });

  test('Escape dismisses without committing', async ({ page }) => {
    await setupEditor(page, '');
    await page.locator('.cm-content').focus();
    await page.keyboard.type('/head');
    await page.keyboard.press('Escape');

    const menu = page.locator('.sf-slash-menu');
    await expect(menu).toBeHidden();
    // The /head text remains
    expect(await getDocText(page)).toBe('/head');
  });

  test('does not open mid-line', async ({ page }) => {
    await setupEditor(page, 'hello');
    await page.locator('.cm-content').focus();
    // Cursor is at end of line
    await page.keyboard.type('/');
    const menu = page.locator('.sf-slash-menu');
    await expect(menu).toBeHidden();
  });

  test('table command inserts a minimal table', async ({ page }) => {
    await setupEditor(page, '');
    await page.locator('.cm-content').focus();
    await page.keyboard.type('/table');
    await page.keyboard.press('Enter');

    const doc = await getDocText(page);
    expect(doc).toContain('| Column 1 | Column 2 |');
    expect(doc).toContain('| --- | --- |');
  });

  test('divider command renders the HR widget (regression #10)', async ({ page }) => {
    await setupEditor(page, '');
    await page.locator('.cm-content').focus();
    await page.keyboard.type('/divider');
    await page.keyboard.press('Enter');
    // Give the decoration a tick to settle
    await page.waitForTimeout(150);

    const hr = page.locator('.cm-md-hr-widget');
    await expect(hr).toBeVisible();
  });
});

// ============================================================================
// TABLE EDITOR
// ============================================================================

test.describe('Table editor', () => {
  // Trailing blank line + text keeps cursor outside the table range so the widget renders.
  const MINIMAL_TABLE = `| A | B |
| --- | --- |
| 1 | 2 |

after`;

  test('cells are contentEditable', async ({ page }) => {
    await setupEditor(page, MINIMAL_TABLE);
    // Blur CM so the table widget can render
    await page.locator('.title-input').click();
    await page.waitForTimeout(200);

    const cells = page.locator('.sf-table__cell');
    expect(await cells.count()).toBe(4); // 2 headers + 2 data cells
    const first = cells.first();
    await expect(first).toHaveAttribute('contenteditable', 'true');
  });

  test('typing in a cell syncs back to markdown', async ({ page }) => {
    await setupEditor(page, MINIMAL_TABLE);
    await page.locator('.title-input').click();
    await page.waitForTimeout(200);

    // Focus the first data cell and type
    await page.evaluate(() => {
      const cells = document.querySelectorAll('.sf-table__cell');
      const dataCell = cells[2] as HTMLElement; // third cell = first data cell
      dataCell.focus();
      const range = document.createRange();
      range.selectNodeContents(dataCell);
      range.collapse(false);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    });
    await page.keyboard.type('0');
    // Wait past sync debounce
    await page.waitForTimeout(300);

    const doc = await getDocText(page);
    expect(doc).toContain('| 10 | 2 |');
  });

  test('cell keeps focus across successive keystrokes (regression #11)', async ({ page }) => {
    await setupEditor(page, MINIMAL_TABLE);
    await page.locator('.title-input').click();
    await page.waitForTimeout(200);

    // Focus first data cell, place caret at end
    await page.evaluate(() => {
      const cells = document.querySelectorAll('.sf-table__cell');
      const dataCell = cells[2] as HTMLElement;
      dataCell.focus();
      const range = document.createRange();
      range.selectNodeContents(dataCell);
      range.collapse(false);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    });

    // Type several characters with the debounce window elapsing between them
    for (const c of 'abcd') {
      await page.keyboard.type(c);
      await page.waitForTimeout(220); // > sync debounce (180ms)
      const focusedIsCell = await page.evaluate(
        () => document.activeElement?.classList.contains('sf-table__cell') ?? false,
      );
      expect(focusedIsCell).toBe(true);
    }
    expect(await getDocText(page)).toContain('| 1abcd | 2 |');
  });
});
