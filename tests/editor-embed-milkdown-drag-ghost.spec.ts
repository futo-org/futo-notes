// Part of the futoBridge Milkdown suite: scope and input rules are in
// editor-embed-milkdown.spec.ts.

import { expect, type CDPSession, type Page } from '@playwright/test';
import { GHOST_PAD_Y_PX } from '../src/features/editor/milkdown/blockDragSession';
import { DEFAULT_LONG_PRESS_MS } from '../src/features/editor/milkdown/mobileBlockDnd';
import { clearMessages, flushFrames } from './lib/editorEmbedHost';
import { hostSetContent } from './lib/editorEmbedMilkdown';
import { touch, blockCenter, mobileDndTest } from './lib/editorEmbedMilkdownDrag';

// ---- the lifted ghost's own geometry -------------------------------------
//
// MR !276, Android: "the ghost while dragging is cut off (it's slightly above
// the orange line)". The ghost card is a clone that deliberately carries the
// `ProseMirror` class and is hosted INSIDE `.futo-milkdown` (createGhost/
// ghostHost) so the editor's own content typography applies to it — which at
// the time also made it inherit the editor's offscreen-block containment rule
// (`content-visibility: auto`), so a never-rendered block popped up one
// unrendered line tall. That rule is gone (eager rendering won on the phone;
// see the Performance spec), and these assertions stay as the guard for the
// card's first-frame geometry: whatever the editor applies to its blocks, the
// card shows the whole block from its first frame.
//
// Heights are read in layout pixels (`offsetHeight`/`clientHeight`), never from
// `getBoundingClientRect`: the lifted card carries a 1.04 pop scale, and these
// assertions are about what the card CONTAINS, not how big it looks.

/** Record the card's very first layout — the frame the pop animation starts
 * from, and the one the reviewer's screenshot caught. A `MutationObserver`
 * callback is a microtask, so it runs after `createGhost` has finished
 * inserting and measuring the card but before the engine's next rendering
 * update: exactly the state a skipped-rendering clone is in. */
async function watchGhostFirstFrame(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __ghostFrame?: unknown };
    w.__ghostFrame = null;
    new MutationObserver((records) => {
      if (w.__ghostFrame) return;
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          if (!(node instanceof HTMLElement) || !node.matches('.futo-mobile-dnd-ghost')) continue;
          const card = node.querySelector('.futo-mobile-dnd-ghost-card') as HTMLElement | null;
          const clone = (card?.firstElementChild ?? null) as HTMLElement | null;
          if (!card || !clone) return;
          w.__ghostFrame = { cloneHeight: clone.offsetHeight };
          return;
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
}

function ghostFirstFrame(page: Page): Promise<{ cloneHeight: number } | null> {
  return page.evaluate(
    () => (window as unknown as { __ghostFrame: { cloneHeight: number } | null }).__ghostFrame,
  );
}

async function ghostGeometry(page: Page, blockText: string) {
  return page.evaluate((text) => {
    const live = document.querySelector('.futo-milkdown .milkdown .ProseMirror');
    const source = Array.from(live?.children ?? []).find((el) =>
      (el.textContent ?? '').includes(text),
    ) as HTMLElement | undefined;
    const ghost = document.querySelector('.futo-mobile-dnd-ghost') as HTMLElement | null;
    const card = ghost?.querySelector('.futo-mobile-dnd-ghost-card') as HTMLElement | null;
    const clone = (card?.firstElementChild ?? null) as HTMLElement | null;
    if (!source || !ghost || !card || !clone) return null;
    const cardStyle = getComputedStyle(card);
    return {
      ghostTop: ghost.getBoundingClientRect().top,
      sourceTop: source.getBoundingClientRect().top,
      sourceHeight: source.offsetHeight,
      cloneHeight: clone.offsetHeight,
      /** What the card actually makes room for, padding removed. */
      cardContentHeight:
        card.clientHeight - parseFloat(cardStyle.paddingTop) - parseFloat(cardStyle.paddingBottom),
      clipped: card.classList.contains('futo-mobile-dnd-ghost-card--clipped'),
      /** The cap, as the engine resolved it. `40vh` in the stylesheet came out
       * as `0px` in the native hosts' web view; a pixel value computed from
       * `window.innerHeight` cannot. */
      maxHeight: cardStyle.maxHeight,
      expectedMaxHeight: `${Math.round(window.innerHeight * 0.4)}px`,
    };
  }, blockText);
}

/** Hold past the lift timer without moving, so the block is lifted and nothing
 * has been dragged anywhere yet. */
async function liftOnly(page: Page, cdp: CDPSession, at: { x: number; y: number }): Promise<void> {
  await touch(cdp, 'touchStart', at.x, at.y);
  await page.waitForTimeout(DEFAULT_LONG_PRESS_MS + 110);
  await flushFrames(page);
}

/** Wraps to several lines at a phone width, so a card capped at one unrendered
 * line is unmistakably shorter than the block — and still far under the card's
 * 40vh cap, so nothing about this block is meant to be cropped. */
const WRAPPING_PARAGRAPH =
  'bravo wraps across several lines at a phone width so that a ghost capped at ' +
  'one unrendered line is unmistakably shorter than the block it was lifted from';

mobileDndTest(
  'the lifted ghost shows the whole block, from its very first frame',
  async ({ page, cdp }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await hostSetContent(page, `alpha\n\n${WRAPPING_PARAGRAPH}\n\ncharlie`);
    await clearMessages(page);
    await watchGhostFirstFrame(page);

    const bravo = await blockCenter(page, 'bravo wraps');
    await liftOnly(page, cdp, bravo);

    const geo = await ghostGeometry(page, 'bravo wraps');
    expect(geo).not.toBeNull();
    if (!geo) throw new Error('no ghost geometry');

    // The block really does wrap — otherwise one unrendered line's worth of
    // height would pass by accident (AGENTS.md M11).
    expect(geo.sourceHeight).toBeGreaterThan(50);
    // A block this short is not meant to be cropped at all...
    expect(geo.clipped).toBe(false);
    expect(geo.cardContentHeight).toBeCloseTo(geo.cloneHeight, 0);
    expect(geo.cloneHeight).toBeCloseTo(geo.sourceHeight, 0);
    // ...and the card sits over the block it was lifted from, padded by the
    // card's own breathing room. A ghost that is offset from its block cannot
    // be read against the drop indicator, which is drawn in viewport space.
    expect(geo.ghostTop).toBeCloseTo(geo.sourceTop - GHOST_PAD_Y_PX, 0);

    // The pop animation's FIRST frame, not a settled one: the cropped card
    // showed up here (and, on a phone, stayed visible while the finger moved).
    const firstFrame = await ghostFirstFrame(page);
    expect(firstFrame).not.toBeNull();
    expect(firstFrame?.cloneHeight).toBeCloseTo(geo.sourceHeight, 0);

    // The card's height cap is a real pixel count, resolved from
    // `window.innerHeight`. Written as `40vh` it resolved to `0px` in both
    // native hosts' web view — whose initial containing block is zero-height,
    // the same defect editor.html pins the body against — and `overflow:
    // hidden` then cropped the card to its own padding. Chromium-on-desktop
    // resolves `vh` normally, so this assertion, not a height, is what carries
    // that regression here.
    expect(geo.maxHeight).toBe(geo.expectedMaxHeight);
    expect(geo.maxHeight).not.toBe('0px');

    await touch(cdp, 'touchCancel', bravo.x, bravo.y);
  },
);

// A block taller than the card's 40vh cap IS cropped, and the fade mask that
// exists for exactly that case has to be applied — `createGhost` decides it by
// measuring the card right after inserting it, so a clone whose rendering was
// still skipped read as one line, overflowed nothing, and lost its fade: the
// crop became a hard edge across the middle of a paragraph.
mobileDndTest('a ghost taller than the cap is cropped WITH its fade', async ({ page, cdp }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const tall = Array.from({ length: 200 }, (_, i) => `tall line ${i}`).join(' ');
  await hostSetContent(page, `alpha\n\n${tall}\n\ncharlie`);
  await clearMessages(page);

  const block = await blockCenter(page, 'tall line 0');
  await liftOnly(page, cdp, block);

  const geo = await ghostGeometry(page, 'tall line 0');
  expect(geo).not.toBeNull();
  if (!geo) throw new Error('no ghost geometry');

  // It genuinely overflows the cap, so the fade is the right answer here.
  expect(geo.cloneHeight).toBeGreaterThan(geo.cardContentHeight + 100);
  expect(geo.clipped).toBe(true);

  await touch(cdp, 'touchCancel', block.x, block.y);
});
