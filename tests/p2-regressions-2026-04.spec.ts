import { test, expect, Page } from '@playwright/test';

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
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: text.length },
    });
  }, content);
  await page.waitForTimeout(150);
  await page.locator('.title-input').click();
  await page.locator('.title-input').blur();
  await page.waitForTimeout(150);
}

async function readState(page: Page) {
  return page.evaluate(() => {
    const view = (window as any).__cmGetView?.();
    return {
      doc: view.state.doc.toString(),
      selFrom: view.state.selection.main.from,
      selTo: view.state.selection.main.to,
    };
  });
}

test.describe('cursor placement past inline-styled spans', () => {
  test('clicking before plain text after bold does not snap to line end', async ({ page }) => {
    const text =
      '**Next 7-10 days:** Finish polishing the editor. Should be cutting a release today.';
    await setupEditor(page, text);

    const target = await page.evaluate(() => {
      const root = document.querySelector('.cm-content')!;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const t = node.textContent ?? '';
        const i = t.indexOf('Finish');
        if (i === -1) continue;
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const rect = range.getBoundingClientRect();
        return { x: rect.left - 1, y: (rect.top + rect.bottom) / 2 };
      }
      throw new Error('Finish not found');
    });

    await page.evaluate(() => (window as any).__cmGetView?.().focus());
    await page.mouse.click(target.x, target.y);
    await page.waitForTimeout(200);

    const state = await readState(page);
    // Source pos 20 is the position right before "F" in "Finish".
    expect(state.selFrom).toBe(20);
  });
});

test.describe('ordered list auto-renumber on delete', () => {
  test('deleting middle item renumbers items below', async ({ page }) => {
    await setupEditor(page, '1. thing\n2. thing2\n3. thing3\n4. thing4');

    // Select the entire third line including its trailing newline-ish boundary
    // and delete via Backspace, mirroring how a user would clear a line.
    await page.evaluate(() => {
      const view = (window as any).__cmGetView?.();
      const line3 = view.state.doc.line(3);
      view.dispatch({
        changes: { from: line3.from, to: line3.to + 1, insert: '' },
        selection: { anchor: line3.from },
      });
    });
    await page.waitForTimeout(200);

    const state = await readState(page);
    expect(state.doc).toBe('1. thing\n2. thing2\n3. thing4');
  });

  test('preserves a list that starts above 1', async ({ page }) => {
    await setupEditor(page, '5. five\n6. six\n7. seven');

    await page.evaluate(() => {
      const view = (window as any).__cmGetView?.();
      const line2 = view.state.doc.line(2);
      view.dispatch({
        changes: { from: line2.from, to: line2.to + 1, insert: '' },
        selection: { anchor: line2.from },
      });
    });
    await page.waitForTimeout(200);

    const state = await readState(page);
    expect(state.doc).toBe('5. five\n6. seven');
  });

  test('does not bleed renumber across indent boundaries', async ({ page }) => {
    // Renumbering must respect indent: deleting a deeper item should not
    // disturb the outer list's numbers, and vice versa.
    await setupEditor(page, '1. outer\n  1. inner\n  2. inner two\n  3. inner three\n2. outer two');

    await page.evaluate(() => {
      const view = (window as any).__cmGetView?.();
      const line3 = view.state.doc.line(3); // `  2. inner two`
      view.dispatch({
        changes: { from: line3.from, to: line3.to + 1, insert: '' },
        selection: { anchor: line3.from },
      });
    });
    await page.waitForTimeout(200);

    const state = await readState(page);
    expect(state.doc).toBe('1. outer\n  1. inner\n  2. inner three\n2. outer two');
  });
});
