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
    { from, to }
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
// BLOCK HANDLE
// ============================================================================

test.describe('Block handle', () => {
  test('appears on hover over a paragraph', async ({ page }) => {
    await setupEditor(page, 'alpha\n\nbeta\n\ngamma');

    // Hover over the first paragraph line
    const firstLine = page.locator('.cm-line').first();
    await firstLine.hover();
    await page.waitForTimeout(100);

    const handle = page.locator('.sf-block-handle--visible');
    await expect(handle).toBeVisible();
  });

  test('each list item gets its own handle, vertically centered on its row', async ({ page }) => {
    await setupEditor(page, '- [ ] unchecked\n- [x] already done\n- [ ] not done');

    async function hoverAndRead(lineIdx: number): Promise<{ handleCenter: number; rowCenter: number }> {
      await page.locator('.cm-line').nth(lineIdx).hover({ position: { x: 10, y: 5 } });
      await page.waitForTimeout(120);
      return await page.evaluate((idx) => {
        const handleEl = document.querySelector('.sf-block-handle') as HTMLElement;
        const rowEl = document.querySelectorAll('.cm-line')[idx] as HTMLElement;
        const hr = handleEl.getBoundingClientRect();
        const lr = rowEl.getBoundingClientRect();
        return {
          handleCenter: hr.top + hr.height / 2,
          rowCenter: lr.top + lr.height / 2,
        };
      }, lineIdx);
    }

    const r0 = await hoverAndRead(0);
    const r1 = await hoverAndRead(1);
    const r2 = await hoverAndRead(2);

    // Handle moves with the hovered row (not stuck at the top of the list)
    expect(r1.handleCenter).toBeGreaterThan(r0.handleCenter);
    expect(r2.handleCenter).toBeGreaterThan(r1.handleCenter);

    // Handle is centered on its row (not offset by the checkbox widget baseline).
    // Allow a small tolerance — sub-pixel rounding + line-height padding.
    for (const r of [r0, r1, r2]) {
      expect(Math.abs(r.handleCenter - r.rowCenter)).toBeLessThan(3);
    }

    // Drop indicator sits between rows, not inside one. Trigger by dragging
    // the first handle's grip and dispatching dragover at the "after first row" y.
    await page.locator('.cm-line').nth(0).hover({ position: { x: 10, y: 5 } });
    await page.waitForTimeout(80);
    const { boundaryY, contentX } = await page.evaluate(() => {
      const lines = document.querySelectorAll('.cm-line');
      const r0 = (lines[0] as HTMLElement).getBoundingClientRect();
      const r1 = (lines[1] as HTMLElement).getBoundingClientRect();
      const content = document.querySelector('.cm-content') as HTMLElement;
      return { boundaryY: (r0.bottom + r1.top) / 2, contentX: content.getBoundingClientRect().left + 50 };
    });
    await page.evaluate(({ x, y }) => {
      const grip = document.querySelector('.sf-block-handle__drag') as HTMLElement;
      const dt = new DataTransfer();
      const dragStart = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt });
      grip.dispatchEvent(dragStart);
      const content = document.querySelector('.cm-content') as HTMLElement;
      const dragOver = new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt });
      content.dispatchEvent(dragOver);
    }, { x: contentX, y: boundaryY - 3 }); // just above the row-1/row-2 boundary → "after" row 1
    await page.waitForTimeout(60);

    const indicator = await page.locator('.sf-block-drop-indicator').evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, visible: (el as HTMLElement).style.display !== 'none' };
    });
    if (indicator.visible) {
      // Indicator must not land inside a row — should be near a boundary between rows
      const rows = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('.cm-line')).map((el) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          return { top: r.top, bottom: r.bottom };
        });
      });
      const insideAny = rows.some((r) => indicator.top > r.top + 4 && indicator.top < r.bottom - 4);
      expect(insideAny).toBe(false);
    }
  });

  test('pointer in the left gutter summons the handle for the aligned row', async ({ page }) => {
    await setupEditor(page, '- [ ] unchecked\n- [x] already done\n- [ ] not done');

    // Move the mouse into the gutter (outside contentDOM), aligned vertically with row 2
    const { gutterX, rowCenterY } = await page.evaluate(() => {
      const content = document.querySelector('.cm-content') as HTMLElement;
      const line = document.querySelectorAll('.cm-line')[1] as HTMLElement;
      const cr = content.getBoundingClientRect();
      const lr = line.getBoundingClientRect();
      return { gutterX: cr.left - 20, rowCenterY: lr.top + lr.height / 2 };
    });
    await page.mouse.move(gutterX, rowCenterY);
    await page.waitForTimeout(120);

    const handle = page.locator('.sf-block-handle');
    await expect(handle).toHaveClass(/sf-block-handle--visible/);

    // It should be anchored to row 2, not left hovering over row 1 or hidden
    const centers = await page.evaluate(() => {
      const h = document.querySelector('.sf-block-handle') as HTMLElement;
      const rows = Array.from(document.querySelectorAll('.cm-line')).map((el) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        return r.top + r.height / 2;
      });
      const hr = h.getBoundingClientRect();
      return { handleCenter: hr.top + hr.height / 2, rows };
    });
    // Closest row to the handle center should be row index 1
    const distances = centers.rows.map((c) => Math.abs(c - centers.handleCenter));
    const closest = distances.indexOf(Math.min(...distances));
    expect(closest).toBe(1);
  });

  test('drop indicator tracks cursor even when dragging straight down from the handle (gutter)', async ({ page }) => {
    await setupEditor(page, '- [ ] unchecked\n- [x] already done\n- [ ] not done');
    // Hover first line so the handle is visible
    await page.locator('.cm-line').nth(0).hover({ position: { x: 10, y: 5 } });
    await page.waitForTimeout(80);

    // Dispatch dragstart on the grip, then dragover on `document` at a point to
    // the LEFT of the content column (i.e., in the gutter where the handle sits).
    // With the fix, clientX is clamped into the content and the indicator tracks
    // the y position.
    const info = await page.evaluate(() => {
      const content = document.querySelector('.cm-content') as HTMLElement;
      const lines = document.querySelectorAll('.cm-line');
      const r1 = (lines[1] as HTMLElement).getBoundingClientRect();
      const r2 = (lines[2] as HTMLElement).getBoundingClientRect();
      const contentRect = content.getBoundingClientRect();
      return {
        gutterX: contentRect.left - 40, // well outside the content column
        boundaryY: (r1.bottom + r2.top) / 2,
      };
    });

    await page.evaluate(({ gutterX, boundaryY }) => {
      const grip = document.querySelector('.sf-block-handle__drag') as HTMLElement;
      const dt = new DataTransfer();
      grip.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
      // Dispatch on document — the new gutter-aware listener should pick it up
      document.dispatchEvent(
        new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: gutterX, clientY: boundaryY, dataTransfer: dt })
      );
    }, info);
    await page.waitForTimeout(60);

    const indicator = await page.locator('.sf-block-drop-indicator').evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, visible: (el as HTMLElement).style.display !== 'none' };
    });
    expect(indicator.visible).toBe(true);

    // Indicator must land on a row boundary, not inside any row
    const rows = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.cm-line')).map((el) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        return { top: r.top, bottom: r.bottom };
      })
    );
    const insideAny = rows.some((r) => indicator.top > r.top + 4 && indicator.top < r.bottom - 4);
    expect(insideAny).toBe(false);
  });

  test('+ button opens slash menu at a new line below the block', async ({ page }) => {
    await setupEditor(page, 'alpha\n\nbeta');
    const firstLine = page.locator('.cm-line').first();
    await firstLine.hover();
    await page.waitForTimeout(100);

    await page.locator('.sf-block-handle button[aria-label="Insert block below"]').click();
    await page.waitForTimeout(100);

    const menu = page.locator('.sf-slash-menu');
    await expect(menu).toBeVisible();
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
      const focusedIsCell = await page.evaluate(() =>
        document.activeElement?.classList.contains('sf-table__cell') ?? false
      );
      expect(focusedIsCell).toBe(true);
    }
    expect(await getDocText(page)).toContain('| 1abcd | 2 |');
  });
});
