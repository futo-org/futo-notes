// Part of the futoBridge Milkdown suite: scope and input rules are in
// editor-embed-milkdown.spec.ts.

import { expect } from '@playwright/test';
import { DEFAULT_LONG_PRESS_MS } from '../src/features/editor/milkdown/mobileBlockDnd';
import { clearMessages, messagesOfType } from './lib/editorEmbedHost';
import { settleChangeDebounce, hostSetContent } from './lib/editorEmbedMilkdown';
import {
  touch,
  blockBox,
  blockCenter,
  reflowGap,
  mobileDndTest,
  mobileDndLineTest,
} from './lib/editorEmbedMilkdownDrag';

/* One boundary is ONE place to drop it. The lower half of a block and the upper
 * half of the block below it are the same document position and commit the same
 * move, so they must be the same slot: one bar, in the gap, and no second tick
 * for crossing between them. They used to be two targets whose indicator drew on
 * two different edges (MR !276; blockDragGeometry.ts). */
mobileDndTest('one boundary is one slot, approached from either side', async ({ page, cdp }) => {
  await hostSetContent(page, 'alpha\n\nbravo\n\ncharlie');
  await clearMessages(page);

  const ticks = async () =>
    (await messagesOfType(page, 'haptic')).filter((m) => m.kind === 'move').length;
  const alpha = await blockCenter(page, 'alpha');
  const bravo = await blockBox(page, 'bravo');
  const charlie = await blockBox(page, 'charlie');

  await touch(cdp, 'touchStart', alpha.x, alpha.y);
  await page.waitForTimeout(DEFAULT_LONG_PRESS_MS + 110);

  // "bravo"'s lower half: the boundary between bravo and charlie.
  await touch(cdp, 'touchMove', bravo.x, bravo.bottom - 3);
  await page.waitForTimeout(32);
  const fromAboveTicks = await ticks();
  expect(fromAboveTicks).toBeGreaterThan(0);

  // The slot opens after bravo: alpha parked there, bravo slid up into its place.
  expect(await reflowGap(page, ['alpha', 'bravo', 'charlie'], 0)).toBe(2);

  // "charlie"'s upper half: the SAME boundary, reached from the other side.
  await touch(cdp, 'touchMove', charlie.x, charlie.top + 3);
  await page.waitForTimeout(32);
  expect(await ticks()).toBe(fromAboveTicks);
  expect(await reflowGap(page, ['alpha', 'bravo', 'charlie'], 0)).toBe(2);

  await touch(cdp, 'touchEnd', charlie.x, charlie.top + 3);
  await settleChangeDebounce(page);
  // Same slot, same commit: alpha lands between bravo and charlie either way.
  const changes = await messagesOfType(page, 'change');
  expect(changes[changes.length - 1].content).toBe('bravo\n\nalpha\n\ncharlie\n');
});

mobileDndLineTest(
  'one boundary is one slot (drop line), approached from either side',
  async ({ page, cdp }) => {
    await hostSetContent(page, 'alpha\n\nbravo\n\ncharlie');
    await clearMessages(page);

    const ticks = async () =>
      (await messagesOfType(page, 'haptic')).filter((m) => m.kind === 'move').length;
    const indicatorTop = () =>
      page.evaluate(() => {
        const el = document.querySelector('.futo-mobile-dnd-indicator');
        return el instanceof HTMLElement ? el.style.top : null;
      });

    const alpha = await blockCenter(page, 'alpha');
    const bravo = await blockBox(page, 'bravo');
    const charlie = await blockBox(page, 'charlie');

    await touch(cdp, 'touchStart', alpha.x, alpha.y);
    await page.waitForTimeout(DEFAULT_LONG_PRESS_MS + 110);

    // "bravo"'s lower half: the boundary between bravo and charlie.
    await touch(cdp, 'touchMove', bravo.x, bravo.bottom - 3);
    await page.waitForTimeout(32);
    const fromAboveTicks = await ticks();
    const fromAboveTop = await indicatorTop();
    expect(fromAboveTicks).toBeGreaterThan(0);
    expect(fromAboveTop).not.toBeNull();

    // The bar sits IN the gap, not on either block's edge.
    const drawnAt = Number.parseFloat(fromAboveTop as string);
    expect(drawnAt).toBeGreaterThanOrEqual(bravo.bottom);
    expect(drawnAt).toBeLessThanOrEqual(charlie.top);

    // "charlie"'s upper half: the SAME boundary, reached from the other side.
    await touch(cdp, 'touchMove', charlie.x, charlie.top + 3);
    await page.waitForTimeout(32);
    expect(await ticks()).toBe(fromAboveTicks);
    expect(await indicatorTop()).toBe(fromAboveTop);

    await touch(cdp, 'touchEnd', charlie.x, charlie.top + 3);
    await settleChangeDebounce(page);
    // Same slot, same commit: alpha lands between bravo and charlie either way.
    const changes = await messagesOfType(page, 'change');
    expect(changes[changes.length - 1].content).toBe('bravo\n\nalpha\n\ncharlie\n');
  },
);

// A tester reported the orange drop-indicator line showing through the ghost
// card while still holding a block over itself, which looked wrong on an
// empty paragraph (a blank rounded card with a line running through it). Two
// causes: the line drew for a drop that does nothing (either of the dragged
// block's own two boundaries), and the card and line raced for the same
// z-index. isNoOpDrop (blockMove.ts) fixes the first; the second is fixed by
// drawing the card OVER the line with a translucent background, so the line
// (and the dimmed source block) still read through it (mobileBlockDnd.ts).
mobileDndTest(
  "the slot closes over the dragged block's own boundaries, and the card reads through",
  async ({ page, cdp }) => {
    await hostSetContent(page, 'alpha\n\nbravo\n\ncharlie');
    await clearMessages(page);

    const order = ['alpha', 'bravo', 'charlie'];
    const slotOpen = async () => (await reflowGap(page, order, 0)) !== null;
    const ticks = async () =>
      (await messagesOfType(page, 'haptic')).filter((m) => m.kind === 'move').length;

    const alpha = await blockBox(page, 'alpha');
    const alphaY = (alpha.top + alpha.bottom) / 2;
    const bravo = await blockBox(page, 'bravo');

    await touch(cdp, 'touchStart', alpha.x, alphaY);
    await page.waitForTimeout(DEFAULT_LONG_PRESS_MS + 110);

    // Still holding over "alpha" itself: resolves to one of its own two
    // boundaries, a no-op drop — no slot, no tick.
    expect(await slotOpen()).toBe(false);
    expect(await ticks()).toBe(0);

    // "bravo"'s lower half: a genuinely new, real boundary.
    await touch(cdp, 'touchMove', bravo.x, bravo.bottom - 3);
    await page.waitForTimeout(32);
    expect(await slotOpen()).toBe(true);
    const ticksAtBravo = await ticks();
    expect(ticksAtBravo).toBeGreaterThan(0);

    // Back over alpha's own place: hidden again, and the tick count must not
    // move — this is a no-op boundary, not a new one to announce. The slot is
    // judged against the blocks as drawn, and bravo is drawn in alpha's place
    // now, its middle exactly at `alphaY` (where a tie keeps the slot open);
    // so the finger goes above bravo's drawn middle.
    const backY = alpha.top + 3;
    expect(backY).toBeLessThan(alphaY);
    await touch(cdp, 'touchMove', alpha.x, backY);
    await page.waitForTimeout(32);
    expect(await slotOpen()).toBe(false);
    expect(await ticks()).toBe(ticksAtBravo);

    // The card's background must be genuinely translucent (alpha strictly
    // between 0 and 1) — not opaque (which would hide the slot completely)
    // and not `opacity` on the whole card (which would fade the text).
    const cardAlpha = await page.evaluate(() => {
      const card = document.querySelector('.futo-mobile-dnd-ghost-card');
      if (!card) return null;
      const bg = getComputedStyle(card).backgroundColor;
      // A color-mix() background resolves to `color(srgb r g b / a)` in this
      // Chromium, not rgb()/rgba() — handle both forms, defaulting to fully
      // opaque (1) when no alpha component is present.
      const rgbMatch = bg.match(
        /^rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(?:,\s*([\d.]+)\s*)?\)$/,
      );
      if (rgbMatch) return rgbMatch[1] === undefined ? 1 : Number.parseFloat(rgbMatch[1]);
      const colorMatch = bg.match(
        /^color\([\w-]+\s+[\d.]+\s+[\d.]+\s+[\d.]+(?:\s*\/\s*([\d.]+)\s*)?\)$/,
      );
      if (colorMatch) return colorMatch[1] === undefined ? 1 : Number.parseFloat(colorMatch[1]);
      return null;
    });
    expect(cardAlpha).not.toBeNull();
    expect(cardAlpha as number).toBeGreaterThan(0);
    expect(cardAlpha as number).toBeLessThan(1);

    // Release over the source: a true no-op, same as the dedicated test above.
    await touch(cdp, 'touchEnd', alpha.x, backY);
    await settleChangeDebounce(page);
    expect(await messagesOfType(page, 'change')).toHaveLength(0);
  },
);

mobileDndLineTest(
  "the drop line (line mode) hides over the dragged block's own boundaries, and reads through the card",
  async ({ page, cdp }) => {
    await hostSetContent(page, 'alpha\n\nbravo\n\ncharlie');
    await clearMessages(page);

    const indicatorVisible = () =>
      page.evaluate(() => {
        const el = document.querySelector('.futo-mobile-dnd-indicator');
        return (
          el instanceof HTMLElement && el.classList.contains('futo-mobile-dnd-indicator--visible')
        );
      });
    const ticks = async () =>
      (await messagesOfType(page, 'haptic')).filter((m) => m.kind === 'move').length;

    const alpha = await blockBox(page, 'alpha');
    const alphaY = (alpha.top + alpha.bottom) / 2;
    const bravo = await blockBox(page, 'bravo');

    await touch(cdp, 'touchStart', alpha.x, alphaY);
    await page.waitForTimeout(DEFAULT_LONG_PRESS_MS + 110);

    // Still holding over "alpha" itself: resolves to one of its own two
    // boundaries, a no-op drop — no line, no tick.
    expect(await indicatorVisible()).toBe(false);
    expect(await ticks()).toBe(0);

    // "bravo"'s lower half: a genuinely new, real boundary.
    await touch(cdp, 'touchMove', bravo.x, bravo.bottom - 3);
    await page.waitForTimeout(32);
    expect(await indicatorVisible()).toBe(true);
    const ticksAtBravo = await ticks();
    expect(ticksAtBravo).toBeGreaterThan(0);

    // Back inside "alpha": hidden again, and the tick count must not move —
    // this is a no-op boundary, not a new one to announce.
    await touch(cdp, 'touchMove', alpha.x, alphaY);
    await page.waitForTimeout(32);
    expect(await indicatorVisible()).toBe(false);
    expect(await ticks()).toBe(ticksAtBravo);

    // The card is drawn over the line, not under it — and the card's
    // background is translucent so the line (and the dimmed source block)
    // still show through it.
    const zIndices = await page.evaluate(() => {
      const ghost = document.querySelector('.futo-mobile-dnd-ghost');
      const indicator = document.querySelector('.futo-mobile-dnd-indicator');
      return {
        ghost: ghost ? Number.parseFloat(getComputedStyle(ghost).zIndex) : null,
        indicator: indicator ? Number.parseFloat(getComputedStyle(indicator).zIndex) : null,
      };
    });
    expect(zIndices.ghost).not.toBeNull();
    expect(zIndices.indicator).not.toBeNull();
    expect(zIndices.ghost as number).toBeGreaterThan(zIndices.indicator as number);

    // The card's background must be genuinely translucent (alpha strictly
    // between 0 and 1) — not opaque (which would hide the line completely
    // again) and not `opacity` on the whole card (which would fade the text).
    const cardAlpha = await page.evaluate(() => {
      const card = document.querySelector('.futo-mobile-dnd-ghost-card');
      if (!card) return null;
      const bg = getComputedStyle(card).backgroundColor;
      // A color-mix() background resolves to `color(srgb r g b / a)` in this
      // Chromium, not rgb()/rgba() — handle both forms, defaulting to fully
      // opaque (1) when no alpha component is present.
      const rgbMatch = bg.match(
        /^rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(?:,\s*([\d.]+)\s*)?\)$/,
      );
      if (rgbMatch) return rgbMatch[1] === undefined ? 1 : Number.parseFloat(rgbMatch[1]);
      const colorMatch = bg.match(
        /^color\([\w-]+\s+[\d.]+\s+[\d.]+\s+[\d.]+(?:\s*\/\s*([\d.]+)\s*)?\)$/,
      );
      if (colorMatch) return colorMatch[1] === undefined ? 1 : Number.parseFloat(colorMatch[1]);
      return null;
    });
    expect(cardAlpha).not.toBeNull();
    expect(cardAlpha as number).toBeGreaterThan(0);
    expect(cardAlpha as number).toBeLessThan(1);

    // Release over the source: a true no-op, same as the dedicated test above.
    await touch(cdp, 'touchEnd', alpha.x, alphaY);
    await settleChangeDebounce(page);
    expect(await messagesOfType(page, 'change')).toHaveLength(0);
  },
);
