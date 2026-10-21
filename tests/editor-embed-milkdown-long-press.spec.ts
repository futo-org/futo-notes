// Part of the futoBridge Milkdown suite: scope and input rules are in
// editor-embed-milkdown.spec.ts.

import { expect } from '@playwright/test';
import { DEFAULT_LONG_PRESS_MS } from '../src/features/editor/milkdown/mobileBlockDnd';
import { clearMessages, getContent, messagesOfType, waitForMessages } from './lib/editorEmbedHost';
import { settleChangeDebounce, hostSetContent } from './lib/editorEmbedMilkdown';
import {
  touch,
  blockBox,
  blockCenter,
  longPressDrag,
  reflowGap,
  dropIndicatorTop,
  listOnly,
  mobileDndTest,
} from './lib/editorEmbedMilkdownDrag';

mobileDndTest(
  'a long-press drag reorders the block and posts lift, a tick per boundary, then drop',
  async ({ page, cdp }) => {
    await hostSetContent(page, 'alpha\n\nbravo\n\ncharlie');
    await clearMessages(page);

    // Released in the LOWER half of "charlie", which resolves to the boundary
    // AFTER it (resolveDropTarget picks by which half of the block's rect
    // the release point falls in).
    const charlie = await blockCenter(page, 'charlie');
    await longPressDrag(page, cdp, await blockCenter(page, 'alpha'), {
      x: charlie.x,
      y: charlie.y + 4,
    });

    const changes = await waitForMessages(page, 'change');
    expect(changes[changes.length - 1].content).toBe('bravo\n\ncharlie\n\nalpha\n');
    /* One pickup, a tick per boundary the bar crossed on the way, one landing. */
    const kinds = (await messagesOfType(page, 'haptic')).map((m) => m.kind);
    expect(kinds[0]).toBe('lift');
    expect(kinds[kinds.length - 1]).toBe('drop');
    expect(kinds.slice(1, -1).every((kind) => kind === 'move')).toBe(true);
    expect(kinds.filter((kind) => kind === 'move').length).toBeGreaterThan(0);
    /* The shell suspends WKWebView's text interaction between these two, so
     * the OS magnifier stays out of the drag (bridge.ts BlockDragMessage). */
    expect((await messagesOfType(page, 'blockDrag')).map((m) => m.active)).toEqual([true, false]);
  },
);

/* A drag only ever lifts a TOP-LEVEL block. A long press on an item of a list,
 * at any depth, lifts the whole list, so it gets the same live-reflow preview
 * as every other block rather than the drop line. */
mobileDndTest(
  'a long press on a nested list item lifts the whole list, with the reflow preview',
  async ({ page, cdp }) => {
    await hostSetContent(page, 'intro\n\n- one\n- two\n  - nested\n- three\n\noutro');
    await clearMessages(page);

    const order = ['intro', 'onetwonestedthree', 'outro'];
    const nested = (await page.getByText('nested', { exact: true }).boundingBox())!;
    const outro = await blockBox(page, 'outro');
    await touch(cdp, 'touchStart', nested.x + nested.width / 2, nested.y + nested.height / 2);
    await page.waitForTimeout(DEFAULT_LONG_PRESS_MS + 110);
    for (let step = 1; step <= 4; step += 1) {
      await touch(cdp, 'touchMove', outro.x, nested.y + ((outro.bottom - 3 - nested.y) * step) / 4);
      await page.waitForTimeout(16);
    }

    // The whole list is the dimmed source, previewed below "outro" by the
    // curtain: no drop line.
    await expect(page.locator('.futo-mobile-dnd-source')).toHaveText(/one.*two.*nested.*three/s);
    await expect.poll(() => reflowGap(page, order, 1)).toBe(3);
    expect(await dropIndicatorTop(page)).toBeNull();

    await touch(cdp, 'touchEnd', outro.x, outro.bottom - 3);
    const changes = await waitForMessages(page, 'change');
    expect(listOnly(changes[changes.length - 1].content as string)).toBe(
      'intro\n\noutro\n\n- one\n- two\n  - nested\n- three\n',
    );
  },
);

mobileDndTest(
  'releasing back at the source is a true no-op: no change, no drop haptic',
  async ({ page, cdp }) => {
    await hostSetContent(page, 'alpha\n\nbravo\n\ncharlie');
    await clearMessages(page);

    const alpha = await blockCenter(page, 'alpha');
    await longPressDrag(page, cdp, alpha, { x: alpha.x, y: alpha.y + 4 });
    await settleChangeDebounce(page);

    expect(await messagesOfType(page, 'edited')).toHaveLength(0);
    /* Lift only: no `drop` (nothing was committed) and no `move` either — the
     * finger never left the gap the block already sat in, so there was no new
     * place to tell the thumb about. */
    expect((await messagesOfType(page, 'haptic')).map((m) => m.kind)).toEqual(['lift']);
    /* `haptic` is deliberately silent on a no-op drop; `blockDrag` must NOT be.
     * The shell has text interaction suspended, and a gesture that ended
     * without saying so leaves the note unselectable for the rest of the
     * session. */
    expect((await messagesOfType(page, 'blockDrag')).map((m) => m.active)).toEqual([true, false]);
    expect(await getContent(page)).toBe('alpha\n\nbravo\n\ncharlie');
  },
);

// The system can take the touch away mid-air (an incoming call, a system
// gesture). That path posts no change and no drop haptic — and still has to
// hand the shell's suspended text interaction back.
mobileDndTest('a canceled drag reports the drag as over', async ({ page, cdp }) => {
  await hostSetContent(page, 'alpha\n\nbravo\n\ncharlie');
  await clearMessages(page);

  const alpha = await blockCenter(page, 'alpha');
  const charlie = await blockCenter(page, 'charlie');
  await touch(cdp, 'touchStart', alpha.x, alpha.y);
  await page.waitForTimeout(DEFAULT_LONG_PRESS_MS + 110);
  await touch(cdp, 'touchMove', charlie.x, charlie.y);
  await page.waitForTimeout(16);
  await touch(cdp, 'touchCancel', charlie.x, charlie.y);
  await settleChangeDebounce(page);

  expect((await messagesOfType(page, 'blockDrag')).map((m) => m.active)).toEqual([true, false]);
  /* The finger traveled, so the indicator ticked on the way; what a cancel
   * must NOT produce is the landing haptic, because nothing landed. */
  const kinds = (await messagesOfType(page, 'haptic')).map((m) => m.kind);
  expect(kinds[0]).toBe('lift');
  expect(kinds).not.toContain('drop');
  expect(await messagesOfType(page, 'change')).toHaveLength(0);
  expect(await getContent(page)).toBe('alpha\n\nbravo\n\ncharlie');
});

mobileDndTest('the preview ticks once per boundary, not once per move', async ({ page, cdp }) => {
  await hostSetContent(page, 'alpha\n\nbravo\n\ncharlie\n\ndelta');
  await clearMessages(page);

  const ticks = async () =>
    (await messagesOfType(page, 'haptic')).filter((m) => m.kind === 'move').length;

  const alpha = await blockCenter(page, 'alpha');
  // Lower halves: a block's own midpoint is where its boundary flips.
  const bravo = await blockBox(page, 'bravo');
  const charlie = await blockBox(page, 'charlie');

  await touch(cdp, 'touchStart', alpha.x, alpha.y);
  await page.waitForTimeout(DEFAULT_LONG_PRESS_MS + 110);
  // The hold itself is silent: the bar is where the block already is.
  expect(await ticks()).toBe(0);

  await touch(cdp, 'touchMove', bravo.x, bravo.bottom - 3);
  await page.waitForTimeout(32);
  const afterFirstBoundary = await ticks();
  expect(afterFirstBoundary).toBe(1);

  // Two more moves that resolve to the SAME boundary — no thumb should feel
  // anything, because nothing moved as far as the eye is concerned.
  await touch(cdp, 'touchMove', bravo.x, bravo.bottom - 4);
  await page.waitForTimeout(32);
  await touch(cdp, 'touchMove', bravo.x, bravo.bottom - 5);
  await page.waitForTimeout(32);
  expect(await ticks()).toBe(afterFirstBoundary);

  await touch(cdp, 'touchMove', charlie.x, charlie.bottom - 3);
  await page.waitForTimeout(32);
  expect(await ticks()).toBe(afterFirstBoundary + 1);

  await touch(cdp, 'touchEnd', charlie.x, charlie.bottom - 3);
  await settleChangeDebounce(page);
});
