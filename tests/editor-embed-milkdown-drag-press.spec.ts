// Part of the futoBridge Milkdown suite: scope and input rules are in
// editor-embed-milkdown.spec.ts.

import { expect, type CDPSession, type Page } from '@playwright/test';
import { DEFAULT_LONG_PRESS_MS } from '../src/features/editor/milkdown/mobileBlockDnd';
import {
  clearMessages,
  getContent,
  messages,
  messagesOfType,
  waitForMessages,
} from './lib/editorEmbedHost';
import { settleChangeDebounce, hostSetContent } from './lib/editorEmbedMilkdown';
import { touch, blockCenter, longPressDrag, mobileDndTest } from './lib/editorEmbedMilkdownDrag';

mobileDndTest('a scroll gesture never lifts a block', async ({ page, cdp }) => {
  await hostSetContent(page, 'alpha\n\nbravo\n\ncharlie');
  await clearMessages(page);

  const alpha = await blockCenter(page, 'alpha');
  await touch(cdp, 'touchStart', alpha.x, alpha.y);
  // Moving immediately (before the 340 ms timer) is an ordinary scroll.
  for (let step = 1; step <= 6; step += 1) {
    await touch(cdp, 'touchMove', alpha.x, alpha.y - step * 12);
    await page.waitForTimeout(16);
  }
  await touch(cdp, 'touchEnd', alpha.x, alpha.y - 72);
  await settleChangeDebounce(page);

  expect(await messagesOfType(page, 'haptic')).toHaveLength(0);
  expect(await messagesOfType(page, 'change')).toHaveLength(0);
  /* And no drag was reported, so the shell never suspended its text
   * interaction: a tap and a scroll both have to leave selection alone. */
  expect(await messagesOfType(page, 'blockDrag')).toHaveLength(0);
  expect(await getContent(page)).toBe('alpha\n\nbravo\n\ncharlie');
});

/* ---- blockPress: the suspension the shell acts on, requested at TOUCH-DOWN --
 *
 * `blockDrag` can only be posted once the 340ms lift timer has fired, which made
 * the shell's protection conditional on the page winning a race it does not
 * control — and a press that produced no lift got the OS magnifier and a word
 * selection with nothing suspended at all (bridge.ts BlockPressMessage).
 *
 * The RACE itself is native and cannot be reproduced here: Chromium has no
 * UIKit text-interaction stack to lose to. What these lock is the mechanism —
 * that the request goes out at touch-down and BEFORE the lift, and that every
 * single arm is resolved, so no gesture can leave the shell suspended (which
 * would kill text selection for the rest of the session). */

mobileDndTest('the press is reported at touch-down, before any lift', async ({ page, cdp }) => {
  await hostSetContent(page, 'alpha\n\nbravo\n\ncharlie');
  await clearMessages(page);

  const alpha = await blockCenter(page, 'alpha');
  await touch(cdp, 'touchStart', alpha.x, alpha.y);
  // Deliberately sampled BEFORE the lift timer could have fired. This is the
  // window that used to be unprotected.
  await waitForMessages(page, 'blockPress');
  expect((await messagesOfType(page, 'blockPress')).map((m) => m.pressed)).toEqual([true]);
  expect(await messagesOfType(page, 'blockDrag')).toHaveLength(0);
  expect(await messagesOfType(page, 'haptic')).toHaveLength(0);

  await touch(cdp, 'touchEnd', alpha.x, alpha.y);
  await settleChangeDebounce(page);
  expect((await messagesOfType(page, 'blockPress')).map((m) => m.pressed)).toEqual([true, false]);
});

mobileDndTest('a committed drag brackets its blockDrag inside its press', async ({ page, cdp }) => {
  await hostSetContent(page, 'alpha\n\nbravo\n\ncharlie');
  await clearMessages(page);

  const charlie = await blockCenter(page, 'charlie');
  await longPressDrag(page, cdp, await blockCenter(page, 'alpha'), {
    x: charlie.x,
    y: charlie.y + 4,
  });
  await waitForMessages(page, 'change');
  await settleChangeDebounce(page);

  /* The shell steps up a level and back down; the press is the outer bracket,
   * so it is never asked to restore while a block is still airborne. */
  const order = (await messages(page))
    .filter((m) => m.type === 'blockPress' || m.type === 'blockDrag')
    .map((m) => `${m.type}:${m.type === 'blockPress' ? m.pressed : m.active}`);
  expect(order).toEqual([
    'blockPress:true',
    'blockDrag:true',
    'blockDrag:false',
    'blockPress:false',
  ]);
});

/* EVERY way a press can end has to release it. A shell told `pressed: true` and
 * never told otherwise has WKWebView's loupe gesture disabled for the rest of
 * the session. */
for (const [name, run] of [
  [
    'a plain tap',
    async (page: Page, cdp: CDPSession, alpha: { x: number; y: number }) => {
      await touch(cdp, 'touchStart', alpha.x, alpha.y);
      await page.waitForTimeout(40);
      await touch(cdp, 'touchEnd', alpha.x, alpha.y);
    },
  ],
  [
    'a short hold that never lifts',
    async (page: Page, cdp: CDPSession, alpha: { x: number; y: number }) => {
      await touch(cdp, 'touchStart', alpha.x, alpha.y);
      await page.waitForTimeout(DEFAULT_LONG_PRESS_MS - 140);
      await touch(cdp, 'touchEnd', alpha.x, alpha.y);
    },
  ],
  [
    'a scroll',
    async (page: Page, cdp: CDPSession, alpha: { x: number; y: number }) => {
      await touch(cdp, 'touchStart', alpha.x, alpha.y);
      for (let step = 1; step <= 6; step += 1) {
        await touch(cdp, 'touchMove', alpha.x, alpha.y - step * 12);
        await page.waitForTimeout(16);
      }
      await touch(cdp, 'touchEnd', alpha.x, alpha.y - 72);
    },
  ],
  [
    'a cancelled press',
    async (page: Page, cdp: CDPSession, alpha: { x: number; y: number }) => {
      await touch(cdp, 'touchStart', alpha.x, alpha.y);
      await page.waitForTimeout(40);
      await touch(cdp, 'touchCancel', alpha.x, alpha.y);
    },
  ],
  [
    'a drop back at the source',
    async (page: Page, cdp: CDPSession, alpha: { x: number; y: number }) => {
      await longPressDrag(page, cdp, alpha, { x: alpha.x, y: alpha.y + 4 });
    },
  ],
  [
    'a cancel while airborne',
    async (page: Page, cdp: CDPSession, alpha: { x: number; y: number }) => {
      await touch(cdp, 'touchStart', alpha.x, alpha.y);
      await page.waitForTimeout(DEFAULT_LONG_PRESS_MS + 110);
      await touch(cdp, 'touchMove', alpha.x, alpha.y + 40);
      await page.waitForTimeout(16);
      await touch(cdp, 'touchCancel', alpha.x, alpha.y + 40);
    },
  ],
] as const) {
  mobileDndTest(`${name} leaves the shell unsuspended`, async ({ page, cdp }) => {
    await hostSetContent(page, 'alpha\n\nbravo\n\ncharlie');
    await clearMessages(page);

    await run(page, cdp, await blockCenter(page, 'alpha'));
    await settleChangeDebounce(page);

    expect((await messagesOfType(page, 'blockPress')).map((m) => m.pressed)).toEqual([true, false]);
    /* And the drag half stays balanced too, whether or not it fired at all. */
    const drags = (await messagesOfType(page, 'blockDrag')).map((m) => m.active);
    expect(drags.filter((a) => a === true)).toHaveLength(drags.length / 2);
    expect(drags[drags.length - 1] ?? false).toBe(false);
  });
}
