import { test, expect, Page } from '@playwright/test';

async function setupEditor(page: Page, content: string): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.goto('/#/note/new');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.cm-editor', { timeout: 10000 });
  await page.waitForSelector('.cm-content', { timeout: 10000 });
  await page.waitForFunction(() => typeof (window as any).__cmGetView === 'function');

  if (content) {
    await page.evaluate((text) => {
      const view = (window as any).__cmGetView?.();
      if (!view) throw new Error('CM EditorView not found');
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor: text.length },
      });
    }, content);
    await page.waitForTimeout(100);
  }
}

async function getDocText(page: Page): Promise<string> {
  return page.evaluate(() => (window as any).__cmGetView?.()?.state.doc.toString() ?? '');
}

/**
 * Dispatch a synthetic paste event with an image File into the CM editor.
 * In web dev mode saveImageBytes is not available, so we verify that
 * the handler does NOT swallow normal paste (no-op path).
 */
test.describe('Image Paste', () => {
  test('paste handler does not interfere with plain text paste when saveImageBytes is unavailable', async ({ page }) => {
    await setupEditor(page, '');

    // Simulate typing then pasting plain text
    await page.locator('.cm-content').click();
    await page.evaluate(() => {
      const view = (window as any).__cmGetView?.();
      if (!view) throw new Error('no view');
      const dt = new DataTransfer();
      dt.setData('text/plain', 'pasted text');
      const event = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      view.contentDOM.dispatchEvent(event);
    });

    // Plain text paste should go through (handler returns false for non-image paste)
    // The actual insertion depends on CM's default handler; just verify no crash
    // and no image markdown was inserted
    const doc = await getDocText(page);
    expect(doc).not.toContain('![](');
  });

  test('paste with image clipboard data does not insert image markdown without saveImageBytes', async ({ page }) => {
    await setupEditor(page, 'some text');

    // In web dev mode, saveImageBytes is not available, so our handler
    // returns false and no image markdown is inserted.
    await page.evaluate(() => {
      const view = (window as any).__cmGetView?.();
      if (!view) throw new Error('no view');

      const dt = new DataTransfer();
      const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'screenshot.png', { type: 'image/png' });
      dt.items.add(file);

      const event = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      view.contentDOM.dispatchEvent(event);
    });

    const doc = await getDocText(page);
    expect(doc).not.toContain('![](');
  });

  test('paste with mixed text and image does not insert image without saveImageBytes', async ({ page }) => {
    await setupEditor(page, '');

    await page.evaluate(() => {
      const view = (window as any).__cmGetView?.();
      if (!view) throw new Error('no view');

      const dt = new DataTransfer();
      dt.setData('text/plain', 'fallback text');
      const file = new File([new Uint8Array([0xff, 0xd8, 0xff])], 'photo.jpg', { type: 'image/jpeg' });
      dt.items.add(file);

      const event = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      view.contentDOM.dispatchEvent(event);
    });

    const doc = await getDocText(page);
    expect(doc).not.toContain('![](');
  });
});
