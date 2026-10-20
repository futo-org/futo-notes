// Part of the futoBridge Milkdown suite: scope and input rules are in
// editor-embed-milkdown.spec.ts.

import { expect, type CDPSession, type Page } from '@playwright/test';
import { LAND_CAP_MS } from '../src/features/editor/milkdown/blockDragCurtain';
import {
  clearMessages,
  flushFrames,
  getContent,
  messagesOfType,
  waitForMessages,
  type FakeHostWindow,
} from './lib/editorEmbedHost';
import { settleChangeDebounce, hostSetContent } from './lib/editorEmbedMilkdown';
import {
  blockBox,
  gutterHandleTest,
  curtainUp,
  mobileDndTest,
} from './lib/editorEmbedMilkdownDrag';
import {
  scrollableNote,
  editorScroll,
  expectDropMatchesPreview,
  blockBoxAt,
  type LiftedBlock,
  liftWithHandle,
  liftWithTouch,
  animationRate,
  liftAndStopMidSlide,
  SLIDE_NOTE,
  realOrder,
} from './lib/editorEmbedMilkdownDropLayout';

/* A drop still landing is an edit the host must not miss. The release reports
 * it at once (`edited`): a native host leaving the foreground flushes only an
 * editor that has told it of an edit since its last change, and would
 * otherwise save the note as it was before the drop. Whatever reads or saves
 * the note, and the page going away, commits the move first. */

const MOVED = /^bravo\n\ncharlie\n\ndelta\n\nalpha\n\n/;

/** Releases alpha past delta mid-slide with the clock stopped (and the cap
 * off), and checks the drop is still landing: the curtain up, the real note
 * not yet moved. */
async function releaseLandingDrop(page: Page, cdp: CDPSession): Promise<void> {
  await page.setViewportSize({ width: 760, height: 1200 });
  await hostSetContent(page, SLIDE_NOTE);
  await clearMessages(page);
  const lifted = await liftAndStopMidSlide(page, cdp);
  await lifted.release();
  await flushFrames(page);
  expect(await curtainUp(page)).toBe(true);
  expect((await realOrder(page))[0]).toBe('alpha');
}

mobileDndTest('a release reports its move as an edit before it lands', async ({ page, cdp }) => {
  await releaseLandingDrop(page, cdp);
  expect(await messagesOfType(page, 'edited')).toHaveLength(1);
  // The change debounce runs out while it lands: the note before the move is
  // not reported as the edit.
  await settleChangeDebounce(page);
  expect(await curtainUp(page)).toBe(true);
  expect(await messagesOfType(page, 'change')).toHaveLength(0);

  await animationRate(cdp, 1);
  await waitForMessages(page, 'change');
  expect((await messagesOfType(page, 'change')).at(-1)?.content).toMatch(MOVED);
});

mobileDndTest(
  'a flush while a drop lands reports the note with the move in it',
  async ({ page, cdp }) => {
    await releaseLandingDrop(page, cdp);
    await page.evaluate(() => (window as unknown as FakeHostWindow).FutoEditor.flush('leaving'));
    expect(await curtainUp(page)).toBe(false);
    const flushed = (await messagesOfType(page, 'change')).filter(
      (m) => m.flushToken === 'leaving',
    );
    expect(flushed).toHaveLength(1);
    expect(flushed[0].content).toMatch(MOVED);
  },
);

mobileDndTest('getContent while a drop lands has the move in it', async ({ page, cdp }) => {
  await releaseLandingDrop(page, cdp);
  expect(await getContent(page)).toMatch(MOVED);
  expect(await curtainUp(page)).toBe(false);
});

for (const event of ['visibilitychange', 'pagehide'] as const) {
  mobileDndTest(
    `the page going away (${event}) while a drop lands commits and reports the move`,
    async ({ page, cdp }) => {
      await releaseLandingDrop(page, cdp);
      await page.evaluate((type) => {
        if (type === 'visibilitychange') {
          Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            get: () => 'hidden',
          });
          document.dispatchEvent(new Event('visibilitychange'));
        } else {
          window.dispatchEvent(new PageTransitionEvent('pagehide'));
        }
      }, event);
      expect(await curtainUp(page)).toBe(false);
      expect((await messagesOfType(page, 'change')).at(-1)?.content).toMatch(MOVED);
    },
  );
}

/** Milliseconds from the release (pointerup) to the curtain coming down. */
async function releaseToCommit(page: Page, release: () => Promise<void>): Promise<number> {
  await page.evaluate(() => {
    const w = window as unknown as { __releasedAt?: number; __committedAt?: number };
    w.__releasedAt = undefined;
    w.__committedAt = undefined;
    window.addEventListener(
      'pointerup',
      () => {
        w.__releasedAt = performance.now();
        new MutationObserver((_, observer) => {
          if (document.querySelector('.futo-mobile-dnd-reflow-clip')) return;
          w.__committedAt = performance.now();
          observer.disconnect();
        }).observe(document.body, { childList: true, subtree: true });
      },
      { capture: true, once: true },
    );
  });
  await release();
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __committedAt?: number }).__committedAt ?? null),
    )
    .not.toBeNull();
  return page.evaluate(() => {
    const w = window as unknown as { __releasedAt: number; __committedAt: number };
    return w.__committedAt - w.__releasedAt;
  });
}

/** Lifts alpha and moves it past delta with the slides slowed to 5%, so
 * they are a long way from their end at the release. */
async function liftAndSlowSlide(page: Page, cdp: CDPSession): Promise<LiftedBlock> {
  await page.setViewportSize({ width: 760, height: 1200 });
  await hostSetContent(page, SLIDE_NOTE);
  await clearMessages(page);
  const delta = await blockBox(page, 'delta');
  const lifted = await liftWithTouch(page, cdp, 0);
  await page.waitForTimeout(300);
  await animationRate(cdp, 0.05);
  await lifted.move(delta.top + (delta.bottom - delta.top) * 0.75);
  await page.waitForTimeout(100);
  return lifted;
}

/* Where the slides never end (the animation clock stopped, as in an app sent
 * to the background mid-slide; a hidden curtain), the drop lands at a cap. */
mobileDndTest('a drop whose slides stall still lands within the cap', async ({ page, cdp }) => {
  const lifted = await liftAndSlowSlide(page, cdp);
  await animationRate(cdp, 0);
  const ms = await releaseToCommit(page, () => lifted.release());
  expect(ms).toBeLessThan(LAND_CAP_MS + 150);
  await waitForMessages(page, 'change');
  expect(await getContent(page)).toMatch(MOVED);
});

mobileDndTest('with reduced motion, a drop lands at the release', async ({ page, cdp }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const lifted = await liftAndSlowSlide(page, cdp);
  expect(await releaseToCommit(page, () => lifted.release())).toBeLessThan(100);
  await waitForMessages(page, 'change');
  expect(await getContent(page)).toMatch(MOVED);
});

/* A move can make the note SHORTER: the final paragraph moved above a first
 * heading (`shorteningNote`) becomes the first block, whose top margin the editor zeroes, while
 * the heading keeps its own — one paragraph gap fewer. Scrolled to the bottom,
 * the browser would then clamp the scroll position to the shorter note and
 * every block on screen would move down by the difference. The note here
 * overflows by a few pixels, less than that gap, so the move is on screen with
 * the note at its bottom. */
/** A note whose final paragraph moved above its first heading makes it
 * shorter (see above), with `paragraphs` plain paragraphs between the two. */
function shorteningNote(paragraphs = 5): string {
  return [
    '# A first heading long enough to wrap over several lines of a narrow screen',
    ...Array.from({ length: paragraphs }, (_, i) => `Paragraph ${i}`),
    'The final paragraph',
  ].join('\n\n');
}

/** Opens `shorteningNote(paragraphs)` in a viewport (about `height` tall) it
 * overflows by 6px, scrolls it to its bottom, then lifts its final paragraph
 * with `lift` and drops it above the heading, holding the drop to the
 * invariant. */
async function runShorteningDrop(
  page: Page,
  lift: (index: number) => Promise<LiftedBlock>,
  { paragraphs = 5, height = 640 } = {},
) {
  await page.setViewportSize({ width: 420, height });
  await hostSetContent(page, shorteningNote(paragraphs));
  await clearMessages(page);
  // The editor's bottom padding is max(40vh, 280px): under 700px tall the
  // overflow follows the viewport height one for one, above it 0.6 for one.
  for (let tries = 0; tries < 3; tries += 1) {
    const { max } = await editorScroll(page);
    if (max > 2 && max < 10) break;
    height = Math.round(height + (max - 6) / (height > 700 ? 0.6 : 1));
    await page.setViewportSize({ width: 420, height });
  }
  await page.evaluate(() => {
    const dom = document.querySelector('.ProseMirror') as HTMLElement;
    dom.scrollTop = dom.scrollHeight;
  });
  await flushFrames(page);
  const start = await editorScroll(page);
  expect(start.max).toBeGreaterThan(2);
  expect(start.max).toBeLessThan(10);
  expect(start.top).toBe(start.max);

  const count = await page.locator('.ProseMirror[contenteditable] > *').count();
  const heading = await blockBoxAt(page, 0);
  // Above the heading's middle, below the edge auto-scroll zone (64px).
  const y = Math.max(start.topEdge + 72, heading.top + 12);
  expect(y).toBeLessThan((heading.top + heading.bottom) / 2);
  const lifted = await lift(count - 1);
  await lifted.move(y);

  await expectDropMatchesPreview(page, () => lifted.release());
  expect(await getContent(page)).toMatch(/^The final paragraph\n\n# A first heading/);
  return height;
}

/** The scroll extent a shortening drop is holding on the editor, as inline
 * styles; empty once released. */
function heldExtent(page: Page): Promise<string> {
  return page.evaluate(() => {
    const style = (document.querySelector('.ProseMirror') as HTMLElement).style;
    return `${style.paddingBottom}${style.borderBottomWidth}`;
  });
}

/** Scrolls the note up to its top 2px at a time, a frame or two each, and
 * returns every step the browser did not land on (a clamp). */
function clampsScrollingUp(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const dom = document.querySelector('.ProseMirror') as HTMLElement;
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    const clamps: string[] = [];
    for (let to = dom.scrollTop; ; to = Math.max(to - 2, 0)) {
      dom.scrollTop = to;
      await frame();
      await frame();
      if (Math.abs(dom.scrollTop - to) > 1) clamps.push(`${to} -> ${dom.scrollTop}`);
      if (to === 0) break;
    }
    return clamps;
  });
}

for (const gesture of ['handle', 'long press'] as const) {
  const dragTest = gesture === 'handle' ? gutterHandleTest : mobileDndTest;
  dragTest(
    `a drop that shortens a note scrolled to its bottom keeps the view still (${gesture})`,
    async ({ page }) => {
      const cdp = gesture === 'handle' ? null : await page.context().newCDPSession(page);
      await runShorteningDrop(page, (index) =>
        cdp ? liftWithTouch(page, cdp, index) : liftWithHandle(page, index),
      );
      // The extent that kept the view still is temporary, and goes at the
      // first scroll that leaves the view clear of it, without a clamp.
      expect(await heldExtent(page)).not.toBe('');
      expect(await clampsScrollingUp(page)).toEqual([]);
      expect(await heldExtent(page)).toBe('');
    },
  );
}

/* The editor's bottom padding is max(40vh, 280px), so above a 700px-tall
 * viewport it follows the height. A held extent frozen into that padding
 * restored a SMALLER padding when it was released after the viewport shrank,
 * and the browser clamped the scroll position on the way up. */
mobileDndTest(
  'a held scroll extent released after the viewport shrank never clamps the view',
  async ({ page, cdp }) => {
    const height = await runShorteningDrop(page, (index) => liftWithTouch(page, cdp, index), {
      paragraphs: 10,
      height: 1000,
    });
    expect(height).toBeGreaterThan(760);
    expect(await heldExtent(page)).not.toBe('');
    // Shrinking the viewport throws the scroll position to the top in the
    // layout of the resize itself, and the scroll event for that reaches the
    // editor a frame later: a view clear of the held extent, which releases
    // it (as it should: it moved nothing). Whether the test's own scroll to
    // the bottom beat that frame depended on how loaded the machine was. So
    // go back to the bottom, which the held extent still reaches, inside the
    // resize event: before any scroll event for it is dispatched, whatever
    // the load. Then up from there through the point where it is released.
    await page.evaluate(() => {
      (window as unknown as { shrunk: Promise<void> }).shrunk = new Promise((resolve) =>
        window.addEventListener(
          'resize',
          () => {
            const dom = document.querySelector('.ProseMirror') as HTMLElement;
            dom.scrollTop = dom.scrollHeight;
            resolve();
          },
          { once: true },
        ),
      );
    });
    await page.setViewportSize({ width: 420, height: height - 60 });
    await page.evaluate(() => (window as unknown as { shrunk: Promise<void> }).shrunk);
    await flushFrames(page);
    expect(await heldExtent(page)).not.toBe('');
    expect(await clampsScrollingUp(page)).toEqual([]);
    expect(await heldExtent(page)).toBe('');
  },
);

/* Opening another note replaces the editor's blocks; the held extent goes
 * with the note it was held for. */
mobileDndTest('opening another note releases a held scroll extent', async ({ page, cdp }) => {
  await runShorteningDrop(page, (index) => liftWithTouch(page, cdp, index));
  expect(await heldExtent(page)).not.toBe('');
  await hostSetContent(page, scrollableNote(60));
  await expect.poll(() => heldExtent(page)).toBe('');
});

/* A second drop while the first's extent is held, then a scroll: nothing of
 * either drop's scroll protection is left on the editor. */
mobileDndTest('repeated drops leave no scroll protection behind', async ({ page, cdp }) => {
  await runShorteningDrop(page, (index) => liftWithTouch(page, cdp, index));
  expect(await heldExtent(page)).not.toBe('');
  // The final paragraph, now first, back down to the end: below the last
  // block, wherever it is drawn.
  const count = await page.locator('.ProseMirror[contenteditable] > *').count();
  const last = await blockBoxAt(page, count - 1);
  const lifted = await liftWithTouch(page, cdp, 0);
  await lifted.move(last.bottom + 12);
  await expectDropMatchesPreview(page, () => lifted.release());
  expect(await getContent(page)).toMatch(/The final paragraph\n$/);

  expect(await clampsScrollingUp(page)).toEqual([]);
  await flushFrames(page);
  expect(await heldExtent(page)).toBe('');
  expect(
    await page.evaluate(
      () => (document.querySelector('.ProseMirror') as HTMLElement).style.overflowAnchor,
    ),
  ).toBe('');
});
