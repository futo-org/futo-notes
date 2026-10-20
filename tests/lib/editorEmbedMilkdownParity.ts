// The page fixture and real-input helpers shared by the editor-embed-milkdown-parity*.spec.ts
// suites, moved here verbatim from editor-embed-milkdown-parity.spec.ts.

import { test as base, type CDPSession, type Page } from '@playwright/test';
import { BRIDGE_VERSION } from '@futo-notes/editor';
import { EDITOR_URL } from '../editorEmbedBundle';
import { flushFrames, installFakeAndroidHost, type FakeHostWindow } from './editorEmbedHost';

/** @milkdown/plugin-listener debounces `markdownUpdated` by 200 ms (trailing). */
export const CHANGE_DEBOUNCE_MS = 200;

export const test = base.extend<{ page: Page }>({
  page: async ({ browser }, use) => {
    const context = await browser.newContext({ hasTouch: true });
    await context.addInitScript(installFakeAndroidHost);
    const page = await context.newPage();
    await page.goto(EDITOR_URL);
    await page.waitForFunction(() =>
      (window as unknown as FakeHostWindow).__msgs?.some((m) => m.type === 'ready'),
    );
    await use(page);
    await context.close();
  },
});

export async function open(
  page: Page,
  content: string,
  theme: 'light' | 'dark' = 'light',
): Promise<void> {
  await page.evaluate(
    (json) => (window as unknown as FakeHostWindow).FutoEditor.initialize(json),
    JSON.stringify({
      bridgeVersion: BRIDGE_VERSION,
      noteId: 'test-note',
      theme,
      content,
      nativeToolbar: true,
      contentPaddingInlinePx: 14,
    }),
  );
  await flushFrames(page);
}

/** Type one character at the very end, the smallest thing that is a real edit. */
export async function typeAtEnd(page: Page, text = 'X'): Promise<void> {
  await page.evaluate(() => (window as unknown as FakeHostWindow).FutoEditor.focus());
  await page.keyboard.press('Control+End');
  await page.keyboard.type(text);
  await page.waitForTimeout(CHANGE_DEBOUNCE_MS + 120);
}

export async function tap(page: Page, x: number, y: number): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: Math.round(x), y: Math.round(y), id: 1 }],
  });
  await page.waitForTimeout(40);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(CHANGE_DEBOUNCE_MS + 120);
  return cdp;
}

export async function centerOf(page: Page, selector: string, nth = 0) {
  const box = await page.locator(selector).nth(nth).boundingBox();
  if (!box) throw new Error(`no geometry for ${selector} #${nth}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
}
