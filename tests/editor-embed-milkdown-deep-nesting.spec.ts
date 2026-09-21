import { expect, test as base, type Page } from '@playwright/test';

import { BRIDGE_VERSION } from '@futo-notes/editor';

import { EDITOR_URL } from './editorEmbedBundle';
import { flushFrames, installFakeAndroidHost, type FakeHostWindow } from './lib/editorEmbedHost';

/**
 * A deeply nested list stays readable at phone width, Milkdown engine.
 *
 * The defect this locks: a 590-byte note holding ONE bullet nested 20 levels
 * deep (`- level 0`, each level indented two more spaces) opened to a
 * completely blank editor body on iPhone. Nothing had failed to mount — all 20
 * items were in the DOM. Every nesting level added 1.4em of `padding-left`, so
 * by level 13 the item's content box had been squeezed to ZERO width and by
 * level 14 the box itself started past the right edge of a 402px screen. A
 * `padding-left` that exceeds its container SHRINKS the content box instead of
 * overflowing it, so `scrollWidth === clientWidth`: there was nothing to
 * scroll to, and nothing to see.
 *
 * Nested TASK lists are the worse sibling (AGENTS.md M17): each level pays the
 * list's indent AND the task item's own 28px checkbox slot, 52px in all, so
 * they collapsed by level 6 — a far more reachable note than a 20-deep bullet.
 * The slot is a minimum tap target and cannot taper, so capping the indent
 * moves that depth to 8 rather than removing it; the remainder is recorded as a
 * Gap in docs/spec/editor.md and locked here only at the depth people write.
 *
 * Geometry against the single-file `editor.html` the native shells ship, at the
 * viewport the report came from (iPhone 16/17 CSS pixels).
 */

/** iPhone 16/17 Pro CSS pixels — the viewport the blank-body report came from. */
const PHONE = { width: 402, height: 874 };

/**
 * The narrowest content column a list item may be squeezed to. Below roughly
 * this, a line holds fewer than a dozen characters and the item is not readable
 * at all — which is what `min-width` on the item turns into honest, scrollable
 * overflow. 6em at the editor's 17px base.
 */
const MIN_ITEM_WIDTH_PX = 6 * 17;

/** `ul`/`ol` `padding-left` for the first four levels: 1.4em at 17px. */
const LEVEL_INDENT_PX = 1.4 * 17;

const test = base.extend<{ page: Page }>({
  page: async ({ browser }, use) => {
    const context = await browser.newContext({ hasTouch: true, viewport: PHONE });
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

async function open(page: Page, content: string): Promise<void> {
  await page.evaluate(
    (json) => (window as unknown as FakeHostWindow).FutoEditor.initialize(json),
    JSON.stringify({
      bridgeVersion: BRIDGE_VERSION,
      theme: 'light',
      content,
      nativeToolbar: true,
      contentPaddingInlinePx: 14,
    }),
  );
  await flushFrames(page);
}

/** The exact note from the report: one bullet, nested `levels` deep. */
function nestedBullets(levels: number): string {
  return (
    Array.from({ length: levels }, (_, i) => `${' '.repeat(i * 2)}- level ${i}`).join('\n') + '\n'
  );
}

function nestedTasks(levels: number): string {
  return (
    Array.from({ length: levels }, (_, i) => `${' '.repeat(i * 2)}- [ ] task ${i}`).join('\n') +
    '\n'
  );
}

interface ItemGeometry {
  text: string;
  left: number;
  right: number;
  width: number;
}

interface Layout {
  items: ItemGeometry[];
  scrollWidth: number;
  clientWidth: number;
  scrollLeft: number;
}

/** Every list item's own paragraph box, outermost first, plus the scroller. */
async function layout(page: Page): Promise<Layout> {
  return page.evaluate(() => {
    const scroller = document.querySelector('.ProseMirror') as HTMLElement;
    const box = scroller.getBoundingClientRect();
    // One decimal, not whole pixels: a sub-pixel indent step still has to be
    // recognisable as the ordinary 1.4em one.
    const px = (n: number) => Math.round(n * 10) / 10;
    return {
      items: [...scroller.querySelectorAll('li > p')].map((p) => {
        const rect = p.getBoundingClientRect();
        return {
          text: p.textContent ?? '',
          // Relative to the scroller's own content origin, so a scrolled
          // viewport does not change what the geometry means.
          left: px(rect.left - box.left + scroller.scrollLeft),
          right: px(rect.right - box.left + scroller.scrollLeft),
          width: px(rect.width),
        };
      }),
      scrollWidth: scroller.scrollWidth,
      clientWidth: scroller.clientWidth,
      scrollLeft: scroller.scrollLeft,
    };
  });
}

test('a 20-level nested bullet list is readable without scrolling sideways', async ({ page }) => {
  await open(page, nestedBullets(20));
  const { items, scrollWidth, clientWidth, scrollLeft } = await layout(page);

  expect(items).toHaveLength(20);
  // The failure was silent — no error, no missing node, just unreadable boxes —
  // so name the offenders rather than asserting a bare count.
  const tooNarrow = items.filter((item) => item.width < MIN_ITEM_WIDTH_PX);
  expect(tooNarrow, 'every level keeps a readable content column').toEqual([]);
  const offRight = items.filter((item) => item.right > clientWidth);
  expect(offRight, 'no level is laid out past the right edge of the screen').toEqual([]);

  // Indentation is bounded, so a bullet list of any depth still fits the
  // column: nothing to scroll to sideways, and nowhere empty to open into.
  expect(scrollWidth).toBe(clientWidth);
  expect(scrollLeft).toBe(0);
});

test('the first four levels keep the indentation an ordinary list has', async ({ page }) => {
  await open(page, nestedBullets(20));
  const { items } = await layout(page);

  // The common case is one to three levels; capping deep indentation must not
  // move it. Levels 1-4 keep the full 1.4em step.
  for (let level = 1; level <= 3; level += 1) {
    expect(
      items[level].left - items[level - 1].left,
      `level ${level} keeps the ordinary indent step`,
    ).toBeCloseTo(LEVEL_INDENT_PX, 0);
  }
});

test('a nested task list at a realistic depth stays readable', async ({ page }) => {
  await open(page, nestedTasks(4));
  const { items, clientWidth } = await layout(page);

  expect(items).toHaveLength(4);
  // A task item pays its 28px checkbox slot on TOP of the list indent, so it
  // runs out of column sooner than a bullet list does — capping the indent
  // moves that depth from 6 to 8 but does not remove it (see the Gap in
  // docs/spec/editor.md). What must hold is the depth people actually write.
  const tooNarrow = items.filter((item) => item.width < MIN_ITEM_WIDTH_PX);
  expect(tooNarrow, 'every task level keeps a readable content column').toEqual([]);
  const offRight = items.filter((item) => item.right > clientWidth);
  expect(offRight, 'no task level is laid out past the right edge').toEqual([]);
});
