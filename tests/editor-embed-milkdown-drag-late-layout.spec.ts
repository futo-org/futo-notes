// Part of the futoBridge Milkdown suite: scope and input rules are in
// editor-embed-milkdown.spec.ts.

import { expect } from '@playwright/test';
import {
  clearMessages,
  flushFrames,
  getContent,
  waitForMessages,
  type FakeHostWindow,
} from './lib/editorEmbedHost';
import { hostSetContent } from './lib/editorEmbedMilkdown';
import { blockBox, reflowGap, curtainUp, mobileDndTest } from './lib/editorEmbedMilkdownDrag';
import {
  scrollableNote,
  editorScroll,
  expectDropMatchesPreview,
  blockBoxAt,
  liftWithTouch,
  LATE_IMAGE_BASE,
  LATE_IMAGE_SVG,
} from './lib/editorEmbedMilkdownDropLayout';

// ---- the drop invariant when the layout changes under the drag -------------
//
// The preview caches every block's geometry for the drag, but a block's size
// can change with the document untouched: a vault image resolves and loads
// (vaultImageView.ts sets `src` when the host's URL lands), a web font swaps
// in, the viewport resizes. The preview must follow, or the clones and the
// drop slot are judged against a layout the drop will not produce.

const LATE_LAYOUT_CASES = [
  {
    name: 'an image below the slot loads',
    content: 'alpha\n\nbravo\n\ncharlie\n\ndelta\n\n![late image](late.svg)\n\necho\n\nfoxtrot',
    source: 0,
    change: 'image' as const,
  },
  {
    name: 'an image above the source loads',
    content: '![late image](late.svg)\n\nalpha\n\nbravo\n\ncharlie\n\ndelta\n\necho\n\nfoxtrot',
    source: 1,
    change: 'image' as const,
    // Everything moves 200px down under the still finger, which then holds
    // over the image (the source's own place: a no-op drop), so it follows
    // the target down, and the slot is judged against the new layout.
    followTarget: true,
  },
  {
    name: 'the viewport narrows',
    content: Array.from(
      { length: 6 },
      (_, i) => `Block ${i} ${'words that wrap on a narrow screen '.repeat(4).trim()}`,
    ).join('\n\n'),
    source: 0,
    change: 'viewport' as const,
  },
];

for (const c of LATE_LAYOUT_CASES) {
  mobileDndTest(
    `reflow drop matches its preview when ${c.name} mid-drag`,
    async ({ page, cdp }) => {
      await page.setViewportSize({ width: 760, height: 1200 });
      await page.route(`${LATE_IMAGE_BASE}**`, (route) =>
        route.fulfill({ contentType: 'image/svg+xml', body: LATE_IMAGE_SVG }),
      );
      await hostSetContent(page, c.content);
      await clearMessages(page);

      // The source down past the next two blocks.
      const target = await blockBoxAt(page, c.source + 2);
      const lifted = await liftWithTouch(page, cdp, c.source);
      await lifted.move(target.top + (target.bottom - target.top) * 0.75);
      await page.waitForTimeout(400);
      expect(await curtainUp(page)).toBe(true);

      if (c.change === 'image') {
        await page.evaluate(
          (base) => (window as unknown as FakeHostWindow).FutoEditor.setImageBaseUrl(base),
          LATE_IMAGE_BASE,
        );
        await expect
          .poll(() =>
            page.evaluate(() => {
              const img = document.querySelector('.ProseMirror[contenteditable] img');
              return img instanceof HTMLImageElement && img.complete ? img.naturalHeight : 0;
            }),
          )
          .toBe(200);
      } else {
        await page.setViewportSize({ width: 520, height: 1200 });
      }
      await flushFrames(page);
      if ('followTarget' in c) {
        const moved = await blockBoxAt(page, c.source + 2);
        expect(moved.top).toBeGreaterThan(target.top + 150);
        await lifted.move(moved.top + (moved.bottom - moved.top) * 0.75);
      }

      await expectDropMatchesPreview(page, () => lifted.release());
    },
  );
}

/* Only the blocks the preview has cloned (the window around the screen) are
 * watched for size changes. A block far above the window that grows moves the
 * whole window without resizing any of it; scroll anchoring keeps the screen
 * still by scrolling, and that scroll is what tells the preview to remeasure. */
mobileDndTest(
  'reflow drop matches its preview when an image far above the window loads mid-drag',
  async ({ page, cdp }) => {
    await page.setViewportSize({ width: 760, height: 720 });
    await page.route(`${LATE_IMAGE_BASE}**`, (route) =>
      route.fulfill({ contentType: 'image/svg+xml', body: LATE_IMAGE_SVG }),
    );
    await hostSetContent(page, `![late image](late.svg)\n\n${scrollableNote(150)}`);
    await clearMessages(page);
    // Line 100 at the top of the screen: the image is many viewports up.
    await page.evaluate(() => {
      const dom = document.querySelector('.ProseMirror') as HTMLElement;
      const line = [...dom.children].find((el) => el.textContent === 'Line 100') as HTMLElement;
      dom.scrollTop += line.getBoundingClientRect().top - dom.getBoundingClientRect().top;
    });
    await flushFrames(page);
    const before = (await editorScroll(page)).top;
    expect(before).toBeGreaterThan(3 * 720);

    const lineAt = async (n: number) => {
      const index = await page.evaluate(
        (text) =>
          [...document.querySelector('.ProseMirror')!.children].findIndex(
            (el) => el.textContent === text,
          ),
        `Line ${n}`,
      );
      return { index, box: await blockBoxAt(page, index) };
    };
    const source = await lineAt(102);
    const target = await lineAt(106);
    const lifted = await liftWithTouch(page, cdp, source.index);
    await lifted.move(target.box.top + (target.box.bottom - target.box.top) * 0.75);
    await page.waitForTimeout(400);
    expect(await curtainUp(page)).toBe(true);

    await page.evaluate(
      (base) => (window as unknown as FakeHostWindow).FutoEditor.setImageBaseUrl(base),
      LATE_IMAGE_BASE,
    );
    await expect
      .poll(() =>
        page.evaluate(() => {
          const img = document.querySelector('.ProseMirror[contenteditable] img');
          return img instanceof HTMLImageElement && img.complete ? img.naturalHeight : 0;
        }),
      )
      .toBe(200);
    await flushFrames(page);
    // Anchoring kept the screen still by scrolling past the grown image.
    expect((await editorScroll(page)).top).toBeGreaterThan(before + 150);

    await expectDropMatchesPreview(page, () => lifted.release());
  },
);

/* The preview clones the rest of its window in idle time and measures each new
 * block as it goes, while the blocks cloned before keep the positions measured
 * then. An idle slice that lands between a layout change above the window and
 * the scroll event that reports it (the next frame) measures the new blocks in
 * the new layout, and the scroll follow, which judges the layout by the
 * window's first block, finds that block where it now is: the clones from
 * before stay where the old layout had them, 200px off, until the release.
 * Held here so the slice runs in exactly that gap, every time. */
mobileDndTest(
  'reflow preview follows a layout change that lands before its idle fill runs',
  async ({ page, cdp }) => {
    await page.setViewportSize({ width: 760, height: 720 });
    await hostSetContent(page, `![](late.svg)\n\n${scrollableNote(150)}`);
    await clearMessages(page);
    await page.evaluate(() => {
      const dom = document.querySelector('.ProseMirror') as HTMLElement;
      const line = [...dom.children].find((el) => el.textContent === 'Line 100') as HTMLElement;
      dom.scrollTop += line.getBoundingClientRect().top - dom.getBoundingClientRect().top;
    });
    await flushFrames(page);

    const lineAt = async (n: number) => {
      const index = await page.evaluate(
        (text) =>
          [...document.querySelector('.ProseMirror')!.children].findIndex(
            (el) => el.textContent === text,
          ),
        `Line ${n}`,
      );
      return { index, box: await blockBoxAt(page, index) };
    };
    const source = await lineAt(102);
    const target = await lineAt(106);
    // Idle work is held from the lift on, and run by the test: the fill that
    // the scroll below asks for then waits for it.
    await page.evaluate(() => {
      const w = window as unknown as {
        __idle: Array<() => void>;
        requestIdleCallback: (cb: (d: unknown) => void) => number;
      };
      w.__idle = [];
      w.requestIdleCallback = (cb) => {
        w.__idle.push(() => cb({ didTimeout: false, timeRemaining: () => 50 }));
        return w.__idle.length;
      };
    });
    const runIdle = () =>
      page.evaluate(() => {
        const w = window as unknown as { __idle: Array<() => void> };
        const held = w.__idle.splice(0);
        for (const run of held) run();
        return held.length;
      });
    const lifted = await liftWithTouch(page, cdp, source.index);
    await lifted.move(target.box.top + (target.box.bottom - target.box.top) * 0.75);
    // The curtain opens (in idle time, if the machine has none to spare).
    await expect
      .poll(async () => {
        if (await curtainUp(page)) return true;
        await runIdle();
        return curtainUp(page);
      })
      .toBe(true);
    // Opening the curtain asked for the fill of its window, which is held.
    expect(
      await page.evaluate(() => (window as unknown as { __idle: unknown[] }).__idle.length),
    ).toBeGreaterThan(0);

    const before = (await editorScroll(page)).top;
    // The image above grows 200px, the browser's layout pins the screen by
    // scrolling (both in the one forced layout), and the idle fill runs
    // before the frame that would deliver the scroll event.
    await page.evaluate(() => {
      const w = window as unknown as { __idle: Array<() => void> };
      const dom = document.querySelector('.ProseMirror') as HTMLElement;
      const img = dom.querySelector('img') as HTMLElement;
      img.style.width = '200px';
      img.style.height = '200px';
      void dom.scrollHeight;
      const held = w.__idle.splice(0);
      for (const run of held) run();
    });
    expect((await editorScroll(page)).top).toBeGreaterThan(before + 150);
    await expectDropMatchesPreview(page, () => lifted.release());
  },
);

/* The layout can change in the very task that releases the drag, before the
 * ResizeObserver has reported it: the release must judge the slot against the
 * layout as it is then, not the one measured. Here an image above the slot
 * grows by 200px as the finger lifts (in a capturing listener that runs before
 * the drag's own), so the finger is over that image, not over delta. */
mobileDndTest(
  'a release judges the slot against a layout that changed in the release itself',
  async ({ page, cdp }) => {
    await page.setViewportSize({ width: 760, height: 1200 });
    await hostSetContent(page, 'alpha\n\nbravo\n\n![](late.svg)\n\ncharlie\n\ndelta\n\necho');
    await clearMessages(page);

    const delta = await blockBox(page, 'delta');
    const lifted = await liftWithTouch(page, cdp, 0);
    await lifted.move(delta.top + (delta.bottom - delta.top) * 0.75);
    await page.waitForTimeout(400);
    // Previewed after delta.
    expect(await reflowGap(page, ['alpha', 'bravo', '', 'charlie', 'delta', 'echo'], 0)).toBe(5);

    await page.evaluate(() => {
      const grow = () => {
        const img = document.querySelector('.ProseMirror[contenteditable] img') as HTMLElement;
        img.style.width = '200px';
        img.style.height = '200px';
      };
      window.addEventListener('pointerup', grow, { capture: true, once: true });
    });
    await lifted.release();
    await waitForMessages(page, 'change');

    const imgHeight = await page.evaluate(
      () =>
        document.querySelector('.ProseMirror[contenteditable] img')!.getBoundingClientRect().height,
    );
    expect(imgHeight).toBe(200);
    // The finger was over the grown image: alpha lands beside it, not after
    // delta, which the image pushed 200px below the finger.
    const content = await getContent(page);
    expect(content.indexOf('alpha')).toBeGreaterThan(content.indexOf('bravo'));
    expect(content.indexOf('alpha')).toBeLessThan(content.indexOf('charlie'));
  },
);
