// Part of the futoBridge Milkdown suite: scope and input rules are in
// editor-embed-milkdown.spec.ts.

import { expect, type Page } from '@playwright/test';
import { DEFAULT_LONG_PRESS_MS } from '../src/features/editor/milkdown/mobileBlockDnd';
import {
  clearMessages,
  flushFrames,
  getContent,
  waitForMessages,
  type FakeHostWindow,
} from './lib/editorEmbedHost';
import { settleChangeDebounce, hostSetContent } from './lib/editorEmbedMilkdown';
import {
  touch,
  blockBox,
  gutterHandleTest,
  drawnBox,
  curtainUp,
  mobileDndTest,
} from './lib/editorEmbedMilkdownDrag';
import {
  dragLayout,
  expectDropMatchesPreview,
  blockBoxAt,
  LATE_IMAGE_BASE,
  LATE_IMAGE_SVG,
  animationRate,
  liftAndStopMidSlide,
  SLIDE_NOTE,
  realOrder,
} from './lib/editorEmbedMilkdownDropLayout';

// ---- the drop invariant mid-slide ------------------------------------------
//
// The preview's clones slide to their places over 0.18s. A release, or a
// layout change, during that slide must not teleport a neighbor to where it
// was going: it carries on from where it is drawn. The page's animation clock
// is slowed and then stopped through CDP, so the slide is caught part-way
// every time, and positions are read off what is RENDERED (the clones' rects,
// transform included), never off their target transforms.

/** The blocks as rendered right now: the curtain's clones while it is up,
 * else the real blocks. */
async function renderedLayout(page: Page) {
  return dragLayout(page, await curtainUp(page));
}

/** Every block in `before` but `except` is within 1px of its place (top
 * only, with `topOnly`) in `after`. */
function expectNoneMoved(
  before: Awaited<ReturnType<typeof dragLayout>>,
  after: Awaited<ReturnType<typeof dragLayout>>,
  { except = '', topOnly = false } = {},
) {
  const moved: string[] = [];
  for (const [key, was] of Object.entries(before.blocks)) {
    if (key === except) continue;
    const now = after.blocks[key];
    if (!now) moved.push(`"${key}" is gone`);
    else if (
      Math.abs(now.top - was.top) > 1 ||
      (!topOnly && Math.abs(now.bottom - was.bottom) > 1)
    ) {
      moved.push(`"${key}" ${was.top.toFixed(1)} -> ${now.top.toFixed(1)}`);
    }
  }
  expect(moved, 'blocks that jumped').toEqual([]);
}

mobileDndTest(
  'a release mid-slide lets the neighbors finish their slide instead of jumping',
  async ({ page, cdp }) => {
    await page.setViewportSize({ width: 760, height: 1200 });
    await hostSetContent(page, SLIDE_NOTE);
    await clearMessages(page);

    const lifted = await liftAndStopMidSlide(page, cdp);
    const before = await renderedLayout(page);
    // Caught part-way: bravo is drawn neither where it was nor where it goes.
    const bravoGoes = await drawnBox(page, 'bravo');
    const bravoWas = await blockBox(page, 'bravo');
    expect(Math.abs(before.blocks.bravo.top - bravoGoes.top)).toBeGreaterThan(5);
    expect(Math.abs(before.blocks.bravo.top - bravoWas.top)).toBeGreaterThan(5);

    await lifted.release();
    await flushFrames(page);
    // Only the dropped block moved (into its slot); the rest are where they
    // were drawn, still part-way.
    expectNoneMoved(before, await renderedLayout(page), { except: 'alpha' });

    // Once the clock runs, the slide finishes, the move commits and the
    // preview goes.
    await animationRate(cdp, 1);
    await expect(page.locator('.futo-mobile-dnd-reflow-clip')).toHaveCount(0);
    await waitForMessages(page, 'change');
    expect(await getContent(page)).toMatch(/^bravo\n\ncharlie\n\ndelta\n\nalpha\n\n/);
  },
);

mobileDndTest(
  'a layout change mid-slide lets the clones finish their slide instead of jumping',
  async ({ page, cdp }) => {
    await page.setViewportSize({ width: 760, height: 1200 });
    await page.route(`${LATE_IMAGE_BASE}**`, (route) =>
      route.fulfill({ contentType: 'image/svg+xml', body: LATE_IMAGE_SVG }),
    );
    await hostSetContent(page, SLIDE_NOTE);
    await clearMessages(page);

    const lifted = await liftAndStopMidSlide(page, cdp);
    const before = await renderedLayout(page);
    expect(Object.keys(before.blocks).length).toBeGreaterThan(3);

    // An image below the slot loads (200px), and the preview is remeasured.
    await page.evaluate(
      (base) => (window as unknown as FakeHostWindow).FutoEditor.setImageBaseUrl(base),
      LATE_IMAGE_BASE,
    );
    await expect
      .poll(() =>
        page.evaluate(() => {
          const img = document.querySelector(
            '.futo-mobile-dnd-reflow-curtain img:not(.ProseMirror-separator)',
          );
          return img instanceof HTMLImageElement && img.complete ? img.naturalHeight : 0;
        }),
      )
      .toBe(200);
    await flushFrames(page);
    // Every clone starts its new slide from where it was drawn (the image's
    // own block grows, so only tops are compared).
    expectNoneMoved(before, await renderedLayout(page), { topOnly: true });

    await animationRate(cdp, 1);
    await expectDropMatchesPreview(page, () => lifted.release());
  },
);

/* After a release mid-slide the move is not committed until the neighbors
 * have finished their slide (`ReflowCurtain.land`): until then the curtain
 * shows the note as the move will leave it, and the real note under it is
 * untouched. Nothing may cut that slide short, and nothing may leave the
 * picture up over something it no longer shows. */

mobileDndTest(
  'opening another note while a drop lands shows the new note at once',
  async ({ page, cdp }) => {
    await page.setViewportSize({ width: 760, height: 1200 });
    await hostSetContent(page, SLIDE_NOTE);
    await clearMessages(page);

    const lifted = await liftAndStopMidSlide(page, cdp);
    await lifted.release();
    await flushFrames(page);
    expect(await curtainUp(page)).toBe(true);

    await hostSetContent(page, 'a different note\n\nwith its own text');
    expect(await curtainUp(page)).toBe(false);
    await animationRate(cdp, 1);
    await flushFrames(page);
    expect(await getContent(page)).toBe('a different note\n\nwith its own text');
  },
);

/* An edit that leaves the dropped block where it was (text typed into another
 * block) while the drop lands: the move commits at once, at its target mapped
 * through the edit, and both survive. */
mobileDndTest('an edit elsewhere while a drop lands commits both', async ({ page, cdp }) => {
  await page.setViewportSize({ width: 760, height: 1200 });
  await hostSetContent(page, SLIDE_NOTE);
  await clearMessages(page);

  const lifted = await liftAndStopMidSlide(page, cdp);
  await lifted.release();
  await flushFrames(page);
  expect(await curtainUp(page)).toBe(true);

  // "X" at the start of bravo, before the drop's target (after delta).
  await page.evaluate(() => {
    const view = (
      window as unknown as {
        __futoProseMirrorView: () => {
          state: {
            doc: { firstChild: { nodeSize: number } };
            tr: { insertText(t: string, p: number): unknown };
          };
          dispatch(tr: unknown): void;
        };
      }
    ).__futoProseMirrorView();
    view.dispatch(view.state.tr.insertText('X', view.state.doc.firstChild.nodeSize + 1));
  });
  expect(await curtainUp(page)).toBe(false);
  await animationRate(cdp, 1);
  await settleChangeDebounce(page);
  expect(await getContent(page)).toMatch(/^Xbravo\n\ncharlie\n\ndelta\n\nalpha\n\n/);
});

/* A layout change while the drop lands (a narrower window rewraps every
 * line; an image loads) commits the move at once and takes the picture down.
 * The change is itself a relayout of everything on screen, so nothing is seen
 * to jump because of the drop — and nothing jumps once the slide would have
 * ended, either: the picture is not left drawn with the old line breaks. */
for (const change of ['viewport', 'image'] as const) {
  mobileDndTest(
    `a ${change === 'viewport' ? 'narrower window' : 'loading image'} while a drop lands commits it, with nothing jumping after`,
    async ({ page, cdp }) => {
      await page.setViewportSize({ width: 760, height: 1200 });
      await page.route(`${LATE_IMAGE_BASE}**`, (route) =>
        route.fulfill({ contentType: 'image/svg+xml', body: LATE_IMAGE_SVG }),
      );
      const wide = `alpha ${'words that wrap differently on a narrower screen '.repeat(3).trim()}`;
      await hostSetContent(
        page,
        SLIDE_NOTE.replace('alpha', wide).replace(/bravo/, `bravo ${wide}`),
      );
      await clearMessages(page);

      const lifted = await liftAndStopMidSlide(page, cdp);
      await lifted.release();
      await flushFrames(page);
      expect(await curtainUp(page)).toBe(true);

      if (change === 'viewport') {
        await page.setViewportSize({ width: 520, height: 1200 });
      } else {
        await page.evaluate(
          (base) => (window as unknown as FakeHostWindow).FutoEditor.setImageBaseUrl(base),
          LATE_IMAGE_BASE,
        );
        await expect
          .poll(() =>
            page.evaluate(() => {
              const img = document.querySelector(
                '.ProseMirror[contenteditable] img:not(.ProseMirror-separator)',
              );
              return img instanceof HTMLImageElement && img.complete ? img.naturalHeight : 0;
            }),
          )
          .toBe(200);
      }
      await flushFrames(page);
      const changed = await renderedLayout(page);

      await animationRate(cdp, 1);
      await expect(page.locator('.futo-mobile-dnd-reflow-clip')).toHaveCount(0);
      await waitForMessages(page, 'change');
      await flushFrames(page);
      expectNoneMoved(changed, await dragLayout(page, false));
      expect((await realOrder(page)).slice(0, 4)).toEqual([
        expect.stringMatching(/^bravo/),
        'charlie',
        'delta',
        expect.stringMatching(/^alpha/),
      ]);
    },
  );
}

/* A second drag cannot start while a drop is landing: lifting the next block
 * would cut the first slide short, so the press is refused until the first
 * move has committed. */
for (const gesture of ['handle', 'long press'] as const) {
  const dragTest = gesture === 'handle' ? gutterHandleTest : mobileDndTest;
  dragTest(
    `a second drag cannot cut a landing drop's slide short (${gesture})`,
    async ({ page }) => {
      const cdp = await page.context().newCDPSession(page);
      await page.setViewportSize({ width: 760, height: 1200 });
      await hostSetContent(page, SLIDE_NOTE);
      await clearMessages(page);

      const first = await liftAndStopMidSlide(page, cdp, gesture === 'handle');
      await first.release();
      await flushFrames(page);
      const before = await renderedLayout(page);
      expect(await curtainUp(page)).toBe(true);

      // A whole second drag, lift to release, of the last block to the top.
      const count = await page.locator('.ProseMirror[contenteditable] > *').count();
      const last = await blockBoxAt(page, count - 1);
      const top = await blockBoxAt(page, 0);
      if (gesture === 'handle') {
        await page.mouse.move(last.left + 10, last.top + 4);
        await page.waitForTimeout(150);
        await page.mouse.move(last.left - 20, last.top + 4, { steps: 2 });
        await page.mouse.down();
        await page.mouse.move(last.left - 16, last.top - 20, { steps: 2 });
        await page.mouse.move(last.left - 16, top.top + 2, { steps: 4 });
        await page.mouse.up();
      } else {
        await touch(cdp, 'touchStart', last.x, last.top + 4);
        await page.waitForTimeout(DEFAULT_LONG_PRESS_MS + 110);
        await touch(cdp, 'touchMove', last.x, top.top + 2);
        await page.waitForTimeout(32);
        await touch(cdp, 'touchEnd', last.x, top.top + 2);
      }
      await flushFrames(page);
      // The first slide is where it was, still part-way.
      expectNoneMoved(before, await renderedLayout(page), { except: 'alpha' });

      // The first drop lands, and only it.
      await animationRate(cdp, 1);
      await expect(page.locator('.futo-mobile-dnd-reflow-clip')).toHaveCount(0);
      await waitForMessages(page, 'change');
      await settleChangeDebounce(page);
      expect(await getContent(page)).toMatch(/^bravo\n\ncharlie\n\ndelta\n\nalpha\n\n/);
    },
  );
}

/* The editor going away while a drop lands takes the picture, and everything
 * it was waiting on, with it. On desktop the ⠿ handle's drag is over by then
 * (the press ended at the release), so nothing of the gesture's own teardown
 * reaches the landing drop: the editor's plugin has to. */
for (const gesture of ['handle', 'long press'] as const) {
  const dragTest = gesture === 'handle' ? gutterHandleTest : mobileDndTest;
  dragTest(
    `destroying the editor while a drop lands takes the curtain down (${gesture})`,
    async ({ page }) => {
      const cdp = await page.context().newCDPSession(page);
      await page.setViewportSize({ width: 760, height: 1200 });
      await hostSetContent(page, SLIDE_NOTE);
      await clearMessages(page);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));

      const lifted = await liftAndStopMidSlide(page, cdp, gesture === 'handle');
      await lifted.release();
      await flushFrames(page);
      expect(await curtainUp(page)).toBe(true);

      await page.evaluate(() =>
        (window as unknown as { __futoProseMirrorView: () => { destroy(): void } })
          .__futoProseMirrorView()
          .destroy(),
      );
      expect(await curtainUp(page)).toBe(false);
      await animationRate(cdp, 1);
      await page.waitForTimeout(300);
      expect(await curtainUp(page)).toBe(false);
      expect(errors).toEqual([]);
    },
  );
}
