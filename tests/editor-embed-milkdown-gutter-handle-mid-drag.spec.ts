// Part of the futoBridge Milkdown suite: scope and input rules are in
// editor-embed-milkdown.spec.ts.

import { expect } from '@playwright/test';
import {
  clearMessages,
  getContent,
  messagesOfType,
  type FakeHostWindow,
} from './lib/editorEmbedHost';
import { hostSetContent } from './lib/editorEmbedMilkdown';
import {
  blockBox,
  gutterHandleTest,
  gutterHandleLineTest,
  reflowGap,
  curtainUp,
  startHandleDrag,
  dropIndicatorTop,
  surfaceHandle,
} from './lib/editorEmbedMilkdownDrag';

// The curtain hides the real blocks, so it must paint what the native shell
// paints behind the (transparent) web view: iOS Theme.background (#FCFCFC /
// #1A1A1A), Android FutoTheme.colors.surface (#FFFFFF / #1F1C19). It once fell
// through to white in dark mode.
for (const [host, theme, expected] of [
  ['iOS', 'dark', 'rgb(26, 26, 26)'],
  ['iOS', 'light', 'rgb(252, 252, 252)'],
  ['Android', 'dark', 'rgb(31, 28, 25)'],
  ['Android', 'light', 'rgb(255, 255, 255)'],
] as const) {
  gutterHandleTest(
    `the reflow curtain paints the ${host} ${theme} editor surface over a transparent page`,
    async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      // The fake host is Android's (`window.futoBridge`); iOS has no such tag.
      if (host === 'iOS') {
        await page.evaluate(() => document.documentElement.removeAttribute('data-platform'));
      }
      await page.evaluate(
        (t) => (window as unknown as FakeHostWindow).FutoEditor.setTheme(t),
        theme,
      );
      await hostSetContent(page, 'alpha\n\nbravo\n\ncharlie');
      expect(
        await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor),
      ).toBe('rgba(0, 0, 0, 0)');

      const handle = await surfaceHandle(page, 'alpha');
      const charlie = await blockBox(page, 'charlie');
      const drag = await startHandleDrag(page, handle);
      await drag.over(charlie.x, charlie.bottom - 3);
      expect(await curtainUp(page)).toBe(true);
      expect(
        await page.evaluate(
          () =>
            getComputedStyle(document.querySelector('.futo-mobile-dnd-reflow-curtain') as Element)
              .backgroundColor,
        ),
      ).toBe(expected);

      await page.keyboard.press('Escape');
      await page.mouse.up();
    },
  );
}

// ProseMirror keeps a block's DOM, and its view descriptor, when the new
// document has an EQUAL block there, without pointing the descriptor at the
// new node object. A curtain that matched blocks to their DOM by identity
// refused every drag after the host's setContent, and those drags quietly
// showed the drop line instead.
gutterHandleTest(
  'a drag after the host replaces the content still previews by reflow',
  async ({ page }) => {
    await hostSetContent(page, 'alpha\n\nbravo\n\ncharlie\n\ndelta');
    await hostSetContent(page, 'alpha\n\nbravo\n\ncharlie');

    const handle = await surfaceHandle(page, 'alpha');
    const charlie = await blockBox(page, 'charlie');
    const drag = await startHandleDrag(page, handle);
    await drag.over(charlie.x, charlie.bottom - 3);
    await expect(page.locator('.futo-mobile-dnd-ghost')).toHaveCount(1);
    expect(await curtainUp(page)).toBe(true);
    expect(await reflowGap(page, ['alpha', 'bravo', 'charlie'], 0)).toBe(3);
    await page.keyboard.press('Escape');
    await page.mouse.up();
  },
);

gutterHandleTest(
  'Escape mid-drag cancels the ⠿ handle drag with no transaction',
  async ({ page }) => {
    await hostSetContent(page, 'alpha\n\nbravo\n\ncharlie');
    await clearMessages(page);

    const handle = await surfaceHandle(page, 'alpha');
    const charlie = await blockBox(page, 'charlie');
    const drag = await startHandleDrag(page, handle);
    await drag.over(charlie.x, charlie.bottom - 3);
    await expect(page.locator('.futo-mobile-dnd-ghost')).toHaveCount(1);
    expect(await curtainUp(page)).toBe(true);
    expect(await reflowGap(page, ['alpha', 'bravo', 'charlie'], 0)).toBe(3);

    await page.keyboard.press('Escape');
    await expect(page.locator('.futo-mobile-dnd-ghost')).toHaveCount(0);
    expect(await curtainUp(page)).toBe(false);
    await expect(page.locator('.futo-mobile-dnd-source')).toHaveCount(0);

    // The release that follows the Escape must not commit anything either.
    await page.mouse.up();
    await page.waitForTimeout(50);
    expect(await getContent(page)).toBe('alpha\n\nbravo\n\ncharlie');
    expect(await messagesOfType(page, 'change')).toHaveLength(0);
  },
);

gutterHandleTest(
  'a host setContent that shrinks the note mid-drag ends the curtain and cannot strand the drag',
  async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    // Long, and lifted from the middle: the curtain measures blocks lazily
    // (around the viewport and along its binary searches), so after a shrink a
    // search for the top of the page probes slots that were never measured.
    const words = Array.from({ length: 600 }, (_, i) => `block${i}`);
    await hostSetContent(page, words.join('\n\n'));
    await page.evaluate(() =>
      [...document.querySelectorAll('.ProseMirror > *')]
        .find((el) => el.textContent === 'block300')
        ?.scrollIntoView({ block: 'center' }),
    );
    await clearMessages(page);

    const handle = await surfaceHandle(page, 'block300');
    const below = await blockBox(page, 'block302');
    const drag = await startHandleDrag(page, handle);
    await drag.over(below.x, below.bottom - 3);
    expect(await curtainUp(page)).toBe(true);

    // The host swaps the note for a shorter one while the block is held.
    await hostSetContent(page, 'one\n\ntwo\n\nthree');
    const one = await blockBox(page, 'one');
    // Sweep the pointer down the page: each y probes a different path through
    // the stale block count.
    for (let y = one.top + 3; y < one.top + 700; y += 90) await drag.over(one.x, y);
    await drag.drop(one.x, one.top + 3);
    await page.waitForTimeout(50);

    expect(errors, 'the release threw').toEqual([]);
    expect(await curtainUp(page)).toBe(false);
    await expect(page.locator('.futo-mobile-dnd-ghost')).toHaveCount(0);
    await expect(page.locator('.futo-mobile-dnd-source')).toHaveCount(0);
    // The held block no longer exists, so the drop is cancelled.
    expect(await getContent(page)).toBe('one\n\ntwo\n\nthree');
  },
);

gutterHandleLineTest(
  'Escape mid-drag cancels the ⠿ handle drag with no transaction (drop line)',
  async ({ page }) => {
    await hostSetContent(page, 'alpha\n\nbravo\n\ncharlie');
    await clearMessages(page);

    const handle = await surfaceHandle(page, 'alpha');
    const charlie = await blockBox(page, 'charlie');
    const drag = await startHandleDrag(page, handle);
    await drag.over(charlie.x, charlie.bottom - 3);
    await expect(page.locator('.futo-mobile-dnd-ghost')).toHaveCount(1);
    expect(await dropIndicatorTop(page)).not.toBeNull();

    await page.keyboard.press('Escape');
    await expect(page.locator('.futo-mobile-dnd-ghost')).toHaveCount(0);
    expect(await dropIndicatorTop(page)).toBeNull();
    await expect(page.locator('.futo-mobile-dnd-source')).toHaveCount(0);

    // The release that follows the Escape must not commit anything either.
    await page.mouse.up();
    await page.waitForTimeout(50);
    expect(await getContent(page)).toBe('alpha\n\nbravo\n\ncharlie');
    expect(await messagesOfType(page, 'change')).toHaveLength(0);
  },
);

/* The grabbing cursor is a full-window layer (handleBlockDrag.ts
 * showCursorLayer), not a class on the root element: `cursor` is inherited, so
 * a root class restyled every element at the lift and again at the drop
 * (~200ms each on a 3,000-block note). The layer catches the wheel, so it hands
 * each wheel event to the scroller under the pointer — mid-drag, the wheel is
 * how a desktop user reaches a gap that is off screen. */
gutterHandleTest(
  'mid-drag, the wheel still scrolls the note through the ⠿ cursor layer',
  async ({ page }) => {
    await hostSetContent(page, Array.from({ length: 80 }, (_, i) => `paragraph ${i}`).join('\n\n'));
    const handle = await surfaceHandle(page, 'paragraph 0');
    const drag = await startHandleDrag(page, handle);
    await drag.over(handle.x + 200, handle.y + 120);
    await expect(page.locator('.futo-block-drag-cursor')).toHaveCount(1);

    const scrollTop = () =>
      page.evaluate(() => {
        for (
          let el: HTMLElement | null = document.querySelector('.ProseMirror');
          el;
          el = el.parentElement
        ) {
          const overflowY = getComputedStyle(el).overflowY;
          if (
            (overflowY === 'auto' || overflowY === 'scroll') &&
            el.scrollHeight > el.clientHeight
          ) {
            return el.scrollTop;
          }
        }
        return document.scrollingElement?.scrollTop ?? 0;
      });
    const before = await scrollTop();
    await page.mouse.wheel(0, 400);
    await expect.poll(scrollTop).toBeGreaterThan(before + 100);

    await page.keyboard.press('Escape');
    await expect(page.locator('.futo-block-drag-cursor')).toHaveCount(0);
    await page.mouse.up();
  },
);
