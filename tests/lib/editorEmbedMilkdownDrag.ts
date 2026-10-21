// Block-drag gestures and fixtures shared by the editor-embed-milkdown
// gutter-handle, long-press and drag-* specs.

import { expect, test as base, type CDPSession, type Page } from '@playwright/test';
import { DEFAULT_LONG_PRESS_MS } from '../../src/features/editor/milkdown/mobileBlockDnd';
import { EDITOR_URL } from '../editorEmbedBundle';
import { installFakeAndroidHost, type FakeHostWindow } from './editorEmbedHost';
import { hostConfig, initialize } from './editorEmbedMilkdown';

// ============================================================
// The iOS long-press block drag (haptic + reorder)
// ============================================================

/**
 * A real touch stream through the browser's input pipeline. Playwright's
 * `touchscreen` only taps, and the long-press path needs a hold, moves, and a
 * release — so this goes through CDP, which is still genuine input (M21: DOM
 * `dispatchEvent` would miss the plugin's own listeners the same way it misses
 * Svelte's).
 */
export async function touch(
  cdp: CDPSession,
  type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel',
  x: number,
  y: number,
): Promise<void> {
  const released = type === 'touchEnd' || type === 'touchCancel';
  await cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: released ? [] : [{ x, y, id: 1 }],
  });
}

export async function blockBox(
  page: Page,
  text: string,
): Promise<{ x: number; top: number; bottom: number }> {
  const box = await page.locator('.ProseMirror > *', { hasText: text }).first().boundingBox();
  if (!box) throw new Error(`no geometry for the block containing "${text}"`);
  return { x: box.x + box.width / 2, top: box.y, bottom: box.y + box.height };
}

export async function blockCenter(page: Page, text: string): Promise<{ x: number; y: number }> {
  const box = await blockBox(page, text);
  return { x: box.x, y: (box.top + box.bottom) / 2 };
}

/** Long-press `from`, drag to `to`, release. Mirrors a real finger. */
export async function longPressDrag(
  page: Page,
  cdp: CDPSession,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  await touch(cdp, 'touchStart', from.x, from.y);
  // Past the lift timer, stationary (any real movement cancels it). A hold
  // genuinely needs wall time; the number comes from the plugin's own default
  // so the two cannot drift apart.
  await page.waitForTimeout(DEFAULT_LONG_PRESS_MS + 110);
  // Several moves, as a finger produces — one jump would skip the indicator.
  for (let step = 1; step <= 4; step += 1) {
    await touch(
      cdp,
      'touchMove',
      from.x + ((to.x - from.x) * step) / 4,
      from.y + ((to.y - from.y) * step) / 4,
    );
    await page.waitForTimeout(16);
  }
  await touch(cdp, 'touchEnd', to.x, to.y);
}

// ============================================================
// The ⠿ gutter handle's mouse drag (desktop browser)
// ============================================================

// The other drag path. The only page a harness can load is `editor.html`, which
// declares itself a native shell and therefore long-presses — hence the
// explicit `?blockDragMode=gutter-handle` (blockDragMode.ts): its test-only
// override is what keeps this path reachable at all from here.
//
// The handle is rendered and positioned by @milkdown/plugin-block, but its drag
// is OURS and pointer-driven (handleBlockDrag.ts): plain `page.mouse` events
// drive it, there is no HTML5 drag to intercept. This is easy to break from the
// outside without noticing: the handle is OUR element, positioned by OUR
// getOffset, surfaced by OUR synthetic pointermove, and the plugin's own drag
// is canceled by listeners that only win because they are registered before
// its own.
const gutterHandleFixture = (query: string) =>
  base.extend<{ page: Page }>({
    page: async ({ browser }, use) => {
      const context = await browser.newContext();
      await context.addInitScript(installFakeAndroidHost);
      const page = await context.newPage();
      await page.goto(`${EDITOR_URL}&blockDragMode=gutter-handle${query}`);
      await page.waitForFunction(() =>
        (window as unknown as FakeHostWindow).__msgs?.some((m) => m.type === 'ready'),
      );
      await use(page);
      await context.close();
    },
  });
export const gutterHandleTest = gutterHandleFixture('');
/** Same, with live reflow forced off: the drop LINE, which a doc that changes
 * shape mid-drag still falls back to. */
export const gutterHandleLineTest = gutterHandleFixture('&blockDragReflow=off');

/**
 * Live-reflow state, read off the curtain's clones (their inline `top` plus
 * transform is where they are sliding to): the previewed target gap (0..n)
 * given the blocks' texts in document order and the dragged block's index, or
 * null when the curtain is absent or the source is where it started (its own
 * gaps). Read from the source's place in the previewed order, not from which
 * blocks shifted: a heading moved away from the top also nudges the blocks
 * after the gap, by the margins it takes with it.
 */
export async function reflowGap(
  page: Page,
  order: string[],
  source: number,
): Promise<number | null> {
  const tops = await page.evaluate(() => {
    const out: Record<string, number> = {};
    for (const el of document.querySelectorAll('.futo-mobile-dnd-reflow-curtain > *')) {
      const style = (el as HTMLElement).style;
      const m = /translateY\((-?[\d.]+)px\)/.exec(style.transform);
      out[(el.textContent ?? '').trim()] =
        Number.parseFloat(style.top) + (m ? Number.parseFloat(m[1]) : 0);
    }
    return out;
  });
  if (!(order[source] in tops)) return null;
  const rank = order.filter((t, i) => i !== source && tops[t] < tops[order[source]]).length;
  if (rank === source) return null;
  return rank > source ? rank + 1 : rank;
}

/**
 * Where the reflow preview DRAWS the block containing `text`, in client
 * coordinates: the real block's box (the real blocks never move during a
 * drag) moved by the shift its clone slides to. Read from the clone's target
 * transform, not its rect, so it is right mid-slide too. The drop slot is
 * judged against this layout, not the one the drag started from.
 */
export async function drawnBox(page: Page, text: string): Promise<{ top: number; bottom: number }> {
  const box = await blockBox(page, text);
  const shift = await page.evaluate((wanted) => {
    for (const el of document.querySelectorAll('.futo-mobile-dnd-reflow-curtain > *')) {
      if (!(el.textContent ?? '').includes(wanted)) continue;
      const m = /translateY\((-?[\d.]+)px\)/.exec((el as HTMLElement).style.transform);
      return m ? Number.parseFloat(m[1]) : 0;
    }
    return null;
  }, text);
  if (shift === null) throw new Error(`the preview draws no clone of "${text}"`);
  return { top: box.top + shift, bottom: box.bottom + shift };
}

/** True while the reflow curtain is up. */
export function curtainUp(page: Page): Promise<boolean> {
  return page.evaluate(() => document.querySelector('.futo-mobile-dnd-reflow-clip') !== null);
}

/**
 * A pointer-driven drag off the ⠿ handle (handleBlockDrag.ts), ONE move at a
 * time so a gap can be SAMPLED at several y positions.
 *
 * `locator.dragTo()` cannot do this job: it moves the pointer to the target in
 * a single hop, so a drag that must be sampled at several y positions inside one
 * gap never reports the intermediate ones.
 *
 * Plain `page.mouse` calls are the whole driver: the page listens for
 * `pointerdown` on the handle, lifts once the pointer has traveled a few
 * pixels, follows every `pointermove`, and commits on `pointerup`. (This used to
 * ride Playwright's HTML5 drag interception over CDP, which is why the helper
 * once needed a long explanation of `Input.dispatchDragEvent`.)
 */
export async function startHandleDrag(page: Page, from: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // Past the page's lift distance. The FIRST move is the one that lifts the
  // block, so it is spent here rather than on a boundary we assert.
  await page.mouse.move(from.x + 4, from.y + 8);
  await page.mouse.move(from.x + 8, from.y + 20);

  /** The pointermove handler writes the indicator synchronously; a frame is
   * plenty for the assertion to read it back. */
  const settle = () => page.waitForTimeout(16);

  return {
    over: async (x: number, y: number) => {
      await page.mouse.move(x, y);
      await settle();
    },
    drop: async (x: number, y: number) => {
      await page.mouse.move(x, y);
      await settle();
      await page.mouse.up();
    },
  };
}

/** The y the drop indicator is currently drawn at, or null when it is hidden.
 * This is the value the plugin computed, not a rendered rect, so the assertion
 * is about the resolved gap rather than about the 3px bar's own box. */
export function dropIndicatorTop(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const el = document.querySelector('.futo-mobile-dnd-indicator');
    if (!(el instanceof HTMLElement)) return null;
    if (!el.classList.contains('futo-mobile-dnd-indicator--visible')) return null;
    const top = Number.parseFloat(el.style.top);
    return Number.isFinite(top) ? top : null;
  });
}

/** Center of the ⠿ handle for the block containing `text`, surfaced by hover. */
export async function surfaceHandle(page: Page, text: string): Promise<{ x: number; y: number }> {
  const block = await blockCenter(page, text);
  const range = await blockBox(page, text);
  await page.mouse.move(block.x, block.y);
  const handle = page.locator('.milkdown-block-handle[data-show="true"]');
  await handle.waitFor({ state: 'attached' });
  // plugin-block's hover detection is throttled, so a handle already showing
  // for the block the pointer came FROM is still there for a beat: wait for it
  // to reach this one.
  await expect
    .poll(
      async () => {
        const box = await handle.boundingBox();
        const y = box ? box.y + box.height / 2 : -1;
        return y >= range.top && y <= range.bottom;
      },
      { message: `the ⠿ handle never reached "${text}"` },
    )
    .toBe(true);
  const box = await handle.boundingBox();
  if (!box) throw new Error('the ⠿ handle has no geometry');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** A list-final document with its trailing newlines collapsed to one:
 * @milkdown/kit/plugin/trailing keeps an empty paragraph after a list-final
 * document, which is upstream behavior and not what these assert. */
export const listOnly = (markdown: string): string => markdown.replace(/\n+$/, '\n');

/** The DOM selection, reduced to what these tests assert on. */
export function domSelection(
  page: Page,
): Promise<{ collapsed: boolean; text: string; block: string }> {
  return page.evaluate(() => {
    const selection = window.getSelection()!;
    const node = selection.anchorNode;
    const el = node instanceof Element ? node : node?.parentElement;
    return {
      collapsed: selection.isCollapsed,
      text: selection.toString(),
      block: el?.closest('.ProseMirror > *')?.textContent ?? '',
    };
  });
}

/** Put the caret at the end of the block containing `text`. */
export async function caretAtEndOf(page: Page, text: string): Promise<void> {
  const box = (await page.getByText(text, { exact: true }).first().boundingBox())!;
  await page.mouse.click(box.x + box.width - 1, box.y + box.height / 2);
  await expect.poll(() => domSelection(page)).toMatchObject({ collapsed: true, block: text });
}

// The long-press path is what a bare `editor.html` mounts — the page both
// native shells load declares `nativeShell: true`, and that flag IS the gate
// (blockDragMode.ts). This fixture differs from the default one only in
// carrying a CDP session for the genuine touch stream.
const mobileDndFixture = (query: string) =>
  base.extend<{ page: Page; cdp: CDPSession }>({
    page: async ({ browser }, use) => {
      const context = await browser.newContext({ hasTouch: true });
      await context.addInitScript(installFakeAndroidHost);
      const page = await context.newPage();
      await page.goto(`${EDITOR_URL}${query}`);
      await page.waitForFunction(() =>
        (window as unknown as FakeHostWindow).__msgs?.some((m) => m.type === 'ready'),
      );
      await initialize(page, hostConfig());
      await use(page);
      await context.close();
    },
    cdp: async ({ page }, use) => {
      const session = await page.context().newCDPSession(page);
      await use(session);
      await session.detach();
    },
  });
export const mobileDndTest = mobileDndFixture('');
/** Live reflow forced off: the long-press drag draws the drop line. */
export const mobileDndLineTest = mobileDndFixture('&blockDragReflow=off');
