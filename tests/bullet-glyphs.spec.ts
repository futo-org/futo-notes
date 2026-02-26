import { test, expect, Page } from '@playwright/test';

async function openNewNote(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.goto('/#/note/new');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.cm-editor', { timeout: 10000 });
  await page.waitForSelector('.cm-content', { timeout: 10000 });
}

test.describe('Bullet Glyphs by Nesting Level', () => {
  test('different glyphs via direct doc content', async ({ page }) => {
    await openNewNote(page);

    // Set content directly to ensure correct markdown indentation
    // Add trailing blank line so cursor doesn't land on a list line
    const nestedList = [
      '- level 0',
      '  - level 1',
      '    - level 2',
      '      - level 3 (wraps to 0)',
      '',
    ].join('\n');

    await page.evaluate((text) => {
      const view = (window as any).__cmGetView?.();
      if (view) {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
          selection: { anchor: text.length },
        });
      }
    }, nestedList);

    await page.waitForTimeout(300);

    // Get all bullet widgets and their text
    const bullets = await page.locator('.cm-md-bullet').all();
    const texts = await Promise.all(bullets.map(b => b.textContent()));

    expect(bullets.length).toBe(4);
    expect(texts[0]).toBe('•');  // level 0
    expect(texts[1]).toBe('◦');  // level 1
    expect(texts[2]).toBe('▪');  // level 2
    expect(texts[3]).toBe('•');  // level 3 wraps
  });

  test('indent content position is consistent at multiple nesting levels', async ({ page }) => {
    await openNewNote(page);

    // 4 levels of nesting + blank line at end
    const nestedList = '- L0\n  - L1\n    - L2\n      - L3\n';
    await page.evaluate((text) => {
      const view = (window as any).__cmGetView?.();
      if (view) {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
          selection: { anchor: text.length },
        });
      }
    }, nestedList);
    await page.waitForTimeout(300);

    // Helper: measure the left edge of content text ("L0", "L1", etc.) in each cm-line.
    // We find the actual text (not spaces, not markers) so measurement is consistent
    // regardless of whether decorations are active.
    async function measureTextLefts(): Promise<number[]> {
      return page.evaluate(() => {
        const lines = document.querySelectorAll('.cm-line');
        return Array.from(lines).slice(0, 4).map(line => {
          // Walk all text nodes and find the first one containing our "L" content
          const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
          let node: Text | null;
          while ((node = walker.nextNode() as Text | null)) {
            const text = node.textContent || '';
            // Find a text node that contains the actual content (e.g., "L0", "L1")
            const match = text.match(/L\d/);
            if (match && match.index !== undefined) {
              const range = document.createRange();
              range.setStart(node, match.index);
              range.setEnd(node, match.index + 1);
              return range.getBoundingClientRect().left;
            }
          }
          return -1;
        });
      });
    }

    // For each nesting level, measure text position with and without cursor on line.
    // The diff should be small and constant (not growing with level).
    for (let i = 0; i < 4; i++) {
      // Move cursor off all list lines (onto blank line at end)
      await page.evaluate((text) => {
        const view = (window as any).__cmGetView?.();
        if (view) view.dispatch({ selection: { anchor: text.length } });
      }, nestedList);
      await page.waitForTimeout(200);
      const decLefts = await measureTextLefts();

      // Click on line i to put cursor there
      await page.locator('.cm-line').nth(i).click();
      await page.waitForTimeout(200);
      const curLefts = await measureTextLefts();

      const diff = Math.abs(decLefts[i] - curLefts[i]);
      // Small constant diff from bullet widget vs raw marker is OK (<5px)
      // Growing diff proportional to indent level is NOT OK
      expect(diff).toBeLessThan(5);
    }
  });

  test('Tab indent changes glyph', async ({ page }) => {
    await openNewNote(page);

    const editor = page.locator('.cm-content');
    await editor.click();

    // Type two bullet items
    await page.keyboard.type('- parent');
    await page.keyboard.press('Enter');
    // List continuation adds "- " automatically, so just type content
    await page.keyboard.type('child');
    await page.waitForTimeout(100);

    // Now indent second line with Tab
    await page.keyboard.press('Tab');
    await page.waitForTimeout(200);

    // Blur editor so cursor-on-line doesn't suppress decorations
    await page.evaluate(() => {
      const view = (window as any).__cmGetView?.();
      if (view) { view.contentDOM.blur(); view.dom.blur(); }
    });
    await page.waitForTimeout(200);

    const bullets = await page.locator('.cm-md-bullet').all();
    const texts = await Promise.all(bullets.map(b => b.textContent()));

    expect(bullets.length).toBe(2);
    expect(texts[0]).toBe('•');  // parent - level 0
    expect(texts[1]).toBe('◦');  // child - level 1
  });
});
