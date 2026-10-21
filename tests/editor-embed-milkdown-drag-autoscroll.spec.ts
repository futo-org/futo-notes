// Part of the futoBridge Milkdown suite: scope and input rules are in
// editor-embed-milkdown.spec.ts.

import { expect, type CDPSession, type Page } from '@playwright/test';
import { DEFAULT_LONG_PRESS_MS } from '../src/features/editor/milkdown/mobileBlockDnd';
import {
  clearMessages,
  flushFrames,
  getContent,
  messagesOfType,
  waitForMessages,
} from './lib/editorEmbedHost';
import { hostSetContent } from './lib/editorEmbedMilkdown';
import { touch, blockBox, blockCenter, mobileDndTest } from './lib/editorEmbedMilkdownDrag';
import {
  scrollableNote,
  editorScroll,
  expectDropMatchesPreview,
} from './lib/editorEmbedMilkdownDropLayout';

// ---- edge auto-scroll (the off-screen half of the note) ------------------
//
// Without it, a block can only be moved to a boundary that is ALREADY on
// screen: the finger has to stay down, so it cannot scroll the note first. The
// original helper stepped `scrollTop` by 14px once per `pointermove`, which
// means a finger PARKED in the edge zone — the whole gesture — produced no
// events and therefore no scrolling at all. A device QA pass on a 250-block
// note held the bottom edge for 20-25 seconds, re-approaching it from several
// y positions, and the content never moved once.

mobileDndTest(
  'a stationary finger held at the bottom edge scrolls the note and drops off-screen',
  async ({ page, cdp }) => {
    await hostSetContent(page, scrollableNote());
    await clearMessages(page);

    const start = await editorScroll(page);
    // Otherwise the assertions below would pass on a note that never scrolled
    // because it never could (AGENTS.md M11).
    expect(start.max).toBeGreaterThan(1500);
    expect(start.top).toBe(0);

    const first = await blockCenter(page, 'Line 0');
    await touch(cdp, 'touchStart', first.x, first.y);
    await page.waitForTimeout(DEFAULT_LONG_PRESS_MS + 110);
    expect((await messagesOfType(page, 'haptic')).map((m) => m.kind)).toEqual(['lift']);

    // ONE move into the bottom edge zone. After this the finger does not move
    // again — which is exactly the gesture the old helper could not serve.
    const edgeY = start.bottomEdge - 12;
    await touch(cdp, 'touchMove', first.x, edgeY);
    const engaged = (await editorScroll(page)).top;

    await expect
      .poll(async () => (await editorScroll(page)).top, { timeout: 8000 })
      .toBeGreaterThan(engaged + 600);

    // ...all the way to the end, and no further: it must not loop or fight the
    // scroller once there is nothing left to reveal. Read against the CURRENT
    // max and with a pixel of slack — `scrollHeight` is a rounded-up integer
    // while `scrollTop` need not be, so the resting value is at most a hair
    // under the arithmetic maximum.
    await expect
      .poll(
        async () => {
          const now = await editorScroll(page);
          return now.max - now.top;
        },
        { timeout: 15000 },
      )
      .toBeLessThanOrEqual(1);
    const clamped = (await editorScroll(page)).top;
    await page.waitForTimeout(300);
    const stillClamped = await editorScroll(page);
    expect(stillClamped.top).toBe(clamped);
    expect(stillClamped.top).toBeLessThanOrEqual(stillClamped.max);

    // The boundary under the STATIONARY finger is recomputed as the document
    // moves beneath it, so the release lands where the finger now points —
    // deep in territory that was off screen when the block was lifted.
    await touch(cdp, 'touchEnd', first.x, edgeY);
    const changes = await waitForMessages(page, 'change');
    const content = changes[changes.length - 1].content as string;
    expect(content.indexOf('\nLine 0\n')).toBeGreaterThan(content.indexOf('\nLine 140\n'));

    // And the loop is gone with the gesture: a leaked rAF that keeps writing
    // scrollTop after the drop is a worse bug than the one this fixes.
    await page.waitForTimeout(300);
    const settled = (await editorScroll(page)).top;
    await page.waitForTimeout(500);
    expect((await editorScroll(page)).top).toBe(settled);
  },
);

mobileDndTest(
  'moving the finger to the other edge reverses the auto-scroll, and it stops at the start',
  async ({ page, cdp }) => {
    await hostSetContent(page, scrollableNote());
    await clearMessages(page);

    const start = await editorScroll(page);
    const first = await blockCenter(page, 'Line 0');
    await touch(cdp, 'touchStart', first.x, first.y);
    await page.waitForTimeout(DEFAULT_LONG_PRESS_MS + 110);

    // Down first, so there is somewhere to come back FROM. Driving it with the
    // gesture rather than by poking `scrollTop` keeps this a story a finger can
    // actually tell.
    await touch(cdp, 'touchMove', first.x, start.bottomEdge - 12);
    await expect
      .poll(async () => (await editorScroll(page)).top, { timeout: 15000 })
      .toBeGreaterThan(800);

    // Same held finger, other edge.
    await touch(cdp, 'touchMove', first.x, start.topEdge + 12);
    await expect.poll(async () => (await editorScroll(page)).top, { timeout: 15000 }).toBe(0);
    await page.waitForTimeout(300);
    expect((await editorScroll(page)).top).toBe(0);

    // And parking the finger back in the middle stops it dead — no coasting.
    await touch(cdp, 'touchMove', first.x, (start.topEdge + start.bottomEdge) / 2);
    await page.waitForTimeout(200);
    const parked = (await editorScroll(page)).top;
    await page.waitForTimeout(500);
    expect((await editorScroll(page)).top).toBe(parked);

    await touch(cdp, 'touchCancel', first.x, (start.topEdge + start.bottomEdge) / 2);
  },
);

// The tick means "the bar is somewhere new". While the note sweeps past a
// stationary finger it would instead be a continuous buzz — hundreds of
// boundaries a second — so auto-scroll redraws the indicator silently. The
// spec already says a hold ticks nothing; an auto-scroll IS a hold.
mobileDndTest(
  'auto-scrolling past many boundaries does not machine-gun the haptic',
  async ({ page, cdp }) => {
    await hostSetContent(page, scrollableNote());
    await clearMessages(page);

    const start = await editorScroll(page);
    const first = await blockCenter(page, 'Line 0');
    await touch(cdp, 'touchStart', first.x, first.y);
    await page.waitForTimeout(DEFAULT_LONG_PRESS_MS + 110);
    await touch(cdp, 'touchMove', first.x, start.bottomEdge - 12);
    // Long enough to sweep the whole note past the finger.
    await page.waitForTimeout(2500);

    const ticks = (await messagesOfType(page, 'haptic')).filter((m) => m.kind === 'move').length;
    // The one move that carried the finger to the bottom is allowed to tick.
    expect(ticks).toBeLessThanOrEqual(1);
    // ...and it really did scroll a long way, so the low count is restraint and
    // not a broken auto-scroll.
    expect((await editorScroll(page)).top).toBeGreaterThan(1000);

    await touch(cdp, 'touchCancel', first.x, start.bottomEdge - 12);
  },
);

// Cancel (an incoming call, a system gesture) takes the touch away mid-air
// with no drop and no doc change — and must take the loop with it.
mobileDndTest('a canceled drag stops the auto-scroll', async ({ page, cdp }) => {
  await hostSetContent(page, scrollableNote());
  await clearMessages(page);

  const start = await editorScroll(page);
  const first = await blockCenter(page, 'Line 0');
  await touch(cdp, 'touchStart', first.x, first.y);
  await page.waitForTimeout(DEFAULT_LONG_PRESS_MS + 110);
  await touch(cdp, 'touchMove', first.x, start.bottomEdge - 12);
  // Cancel while there is still plenty of note left below, so a leaked loop
  // would visibly keep going instead of sitting clamped at the end.
  await expect
    .poll(async () => (await editorScroll(page)).top, { timeout: 8000 })
    .toBeGreaterThan(300);
  await touch(cdp, 'touchCancel', first.x, start.bottomEdge - 12);

  await page.waitForTimeout(200);
  const stopped = (await editorScroll(page)).top;
  expect(stopped).toBeLessThan(start.max);
  await page.waitForTimeout(600);
  expect((await editorScroll(page)).top).toBe(stopped);
  expect(await messagesOfType(page, 'change')).toHaveLength(0);
});

// ---- the drop keeps the view still ---------------------------------------
//
// The reflow preview already draws the note as it will be after the drop, at
// the current scroll position. So the drop itself must not move anything on
// screen: the user reported that after an auto-scroll the view SOMETIMES
// jumped on release (Android, 2026-10-08).

/** A tall first block (it wraps over many lines), so a drop that shifts the
 * view by the source's size is unmistakable, then numbered one-line blocks. */
const TALL_BLOCK = `Tall ${'block of wrapping words '.repeat(60)}`.trim();
function tallSourceNote(): string {
  return `${TALL_BLOCK}\n\n${scrollableNote(120)}`;
}

/** Drops at `y` (a long-press drag) and holds it to the drop invariant. */
async function dropAndExpectStill(page: Page, cdp: CDPSession, x: number, y: number) {
  await expectDropMatchesPreview(page, () => touch(cdp, 'touchEnd', x, y));
}

mobileDndTest(
  'a drop after auto-scroll carried the source off the top keeps the view still',
  async ({ page, cdp }) => {
    await hostSetContent(page, tallSourceNote());
    await clearMessages(page);

    const start = await editorScroll(page);
    const tall = await blockBox(page, 'Tall block');
    // The source must be big enough that a jump of its size cannot hide in
    // the tolerance.
    expect(tall.bottom - tall.top).toBeGreaterThan(150);
    const middle = (start.topEdge + start.bottomEdge) / 2;

    await touch(cdp, 'touchStart', tall.x, tall.top + 20);
    await page.waitForTimeout(DEFAULT_LONG_PRESS_MS + 110);
    await touch(cdp, 'touchMove', tall.x, start.bottomEdge - 12);
    // Until the source is wholly above the viewport, then park the finger
    // mid-screen so the scroll stops and the drop lands among visible blocks.
    await expect
      .poll(async () => (await editorScroll(page)).top, { timeout: 8000 })
      .toBeGreaterThan(tall.bottom - start.topEdge + 200);
    await touch(cdp, 'touchMove', tall.x, middle);

    await dropAndExpectStill(page, cdp, tall.x, middle);
    const content = await getContent(page);
    expect(content.indexOf('Tall block')).toBeGreaterThan(content.indexOf('Line 10\n'));
  },
);

mobileDndTest(
  'a drop with the source still on screen keeps the view still',
  async ({ page, cdp }) => {
    await hostSetContent(page, tallSourceNote());
    await clearMessages(page);

    const start = await editorScroll(page);
    const tall = await blockBox(page, 'Tall block');
    const target = start.bottomEdge - 100;
    expect(target).toBeGreaterThan(tall.bottom + 40);

    await touch(cdp, 'touchStart', tall.x, tall.top + 20);
    await page.waitForTimeout(DEFAULT_LONG_PRESS_MS + 110);
    for (let step = 1; step <= 4; step += 1) {
      await touch(cdp, 'touchMove', tall.x, tall.top + 20 + ((target - tall.top - 20) * step) / 4);
      await page.waitForTimeout(16);
    }
    expect((await editorScroll(page)).top).toBe(0);

    await dropAndExpectStill(page, cdp, tall.x, target);
  },
);

mobileDndTest(
  'a drop after auto-scroll carried the source off the bottom keeps the view still',
  async ({ page, cdp }) => {
    await hostSetContent(page, `${scrollableNote(120)}\n${TALL_BLOCK}\n`);
    await clearMessages(page);
    // Start at the end, so the tall block is on screen to be lifted.
    await page.evaluate(() => {
      const dom = document.querySelector('.ProseMirror') as HTMLElement;
      dom.scrollTop = dom.scrollHeight;
    });
    await flushFrames(page);

    const start = await editorScroll(page);
    const tall = await blockBox(page, 'Tall block');
    const middle = (start.topEdge + start.bottomEdge) / 2;

    await touch(cdp, 'touchStart', tall.x, tall.top + 20);
    await page.waitForTimeout(DEFAULT_LONG_PRESS_MS + 110);
    await touch(cdp, 'touchMove', tall.x, start.topEdge + 12);
    await expect
      .poll(async () => (await editorScroll(page)).top, { timeout: 8000 })
      .toBeLessThan(start.top - (start.bottomEdge - tall.top) - 400);
    await touch(cdp, 'touchMove', tall.x, middle);

    await dropAndExpectStill(page, cdp, tall.x, middle);
  },
);
