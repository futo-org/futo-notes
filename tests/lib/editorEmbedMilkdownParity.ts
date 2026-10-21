// The page fixture and real-input helpers shared by the editor-embed-milkdown-parity*.spec.ts
// suites, moved here verbatim from editor-embed-milkdown-parity.spec.ts.

import type { CDPSession, Page } from '@playwright/test';
import type { FakeHostWindow } from './editorEmbedHost';
import { CHANGE_DEBOUNCE_MS, embedTest, hostConfig, initialize } from './editorEmbedSpec';

export { CHANGE_DEBOUNCE_MS };
export const test = embedTest;

export async function open(
  page: Page,
  content: string,
  theme: 'light' | 'dark' = 'light',
): Promise<void> {
  await initialize(page, hostConfig({ content, theme }));
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
