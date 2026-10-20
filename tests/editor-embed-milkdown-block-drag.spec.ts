import { expect, test as base, type CDPSession, type Page } from '@playwright/test';

import { LAND_CAP_MS } from '../src/features/editor/milkdown/blockDragCurtain';
import { GHOST_PAD_Y_PX } from '../src/features/editor/milkdown/blockDragSession';
import { DEFAULT_LONG_PRESS_MS } from '../src/features/editor/milkdown/mobileBlockDnd';
import { EDITOR_URL } from './editorEmbedBundle';
import {
  clearMessages,
  flushFrames,
  focusEditor,
  getContent,
  installFakeAndroidHost,
  messages,
  messagesOfType,
  waitForMessages,
  type FakeHostWindow,
} from './lib/editorEmbedHost';
import {
  hostConfig,
  hostSetContent,
  initialize,
  settleChangeDebounce,
} from './lib/editorEmbedSpec';

/**
 * The block drag, both gestures, against the bundle both native shells ship:
 * the long-press drag `editor.html` mounts (haptic + reorder) and the ⠿ gutter
 * handle's mouse drag (desktop). The rest of the bridge
 * contract is `editor-embed-milkdown.spec.ts`.
 *
 * Real user input only: Playwright mouse, and CDP `Input.dispatchTouchEvent` for
 * the long-press drag (a genuine browser touch stream, not DOM `dispatchEvent` —
 * AGENTS.md M21).
 */

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
async function touch(
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

async function blockBox(
  page: Page,
  text: string,
): Promise<{ x: number; top: number; bottom: number }> {
  const box = await page.locator('.ProseMirror > *', { hasText: text }).first().boundingBox();
  if (!box) throw new Error(`no geometry for the block containing "${text}"`);
  return { x: box.x + box.width / 2, top: box.y, bottom: box.y + box.height };
}

async function blockCenter(page: Page, text: string): Promise<{ x: number; y: number }> {
  const box = await blockBox(page, text);
  return { x: box.x, y: (box.top + box.bottom) / 2 };
}

/** Long-press `from`, drag to `to`, release. Mirrors a real finger. */
async function longPressDrag(
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
const gutterHandleTest = gutterHandleFixture('');
/** Same, with live reflow forced off: the drop LINE, which a doc that changes
 * shape mid-drag still falls back to. */
const gutterHandleLineTest = gutterHandleFixture('&blockDragReflow=off');

/**
 * Live-reflow state, read off the curtain's clones (their inline `top` plus
 * transform is where they are sliding to): the previewed target gap (0..n)
 * given the blocks' texts in document order and the dragged block's index, or
 * null when the curtain is absent or the source is where it started (its own
 * gaps). Read from the source's place in the previewed order, not from which
 * blocks shifted: a heading moved away from the top also nudges the blocks
 * after the gap, by the margins it takes with it.
 */
async function reflowGap(page: Page, order: string[], source: number): Promise<number | null> {
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
async function drawnBox(page: Page, text: string): Promise<{ top: number; bottom: number }> {
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
function curtainUp(page: Page): Promise<boolean> {
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
async function startHandleDrag(page: Page, from: { x: number; y: number }) {
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
function dropIndicatorTop(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const el = document.querySelector('.futo-mobile-dnd-indicator');
    if (!(el instanceof HTMLElement)) return null;
    if (!el.classList.contains('futo-mobile-dnd-indicator--visible')) return null;
    const top = Number.parseFloat(el.style.top);
    return Number.isFinite(top) ? top : null;
  });
}

/** Center of the ⠿ handle for the block containing `text`, surfaced by hover. */
async function surfaceHandle(page: Page, text: string): Promise<{ x: number; y: number }> {
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

gutterHandleTest('the ⠿ handle sits in the gutter, never over a list marker', async ({ page }) => {
  // The handle belongs in the editor's gutter, left of the text column, never
  // over a bullet. Hovering an item of a list, at any depth, surfaces the
  // handle for the whole list (a drag only lifts top-level blocks), beside the
  // list's first line.
  await hostSetContent(page, 'intro\n\n- first\n- outer\n  - nested\n  - inner\n');
  const contentLeft = await page.evaluate(() => {
    const pm = document.querySelector('.ProseMirror')!;
    return pm.getBoundingClientRect().left + parseFloat(getComputedStyle(pm).paddingLeft);
  });
  for (const [text, line] of [
    ['intro', 'intro'],
    ['outer', 'first'],
    ['inner', 'first'],
  ]) {
    // Over the TEXT, not the block's left edge.
    const textBox = (await page.getByText(text, { exact: true }).first().boundingBox())!;
    const lineBox = (await page.getByText(line, { exact: true }).first().boundingBox())!;
    await page.mouse.move(textBox.x + textBox.width / 2, textBox.y + textBox.height / 2, {
      steps: 4,
    });
    const handle = page.locator('.milkdown-block-handle[data-show="true"]');
    // The handle is repositioned asynchronously; wait until it is on its line.
    await expect
      .poll(
        async () => {
          const box = await handle.boundingBox();
          return box
            ? Math.abs(box.y + box.height / 2 - (lineBox.y + lineBox.height / 2))
            : Infinity;
        },
        { message: `${text}: handle beside "${line}"` },
      )
      .toBeLessThan(4);
    const box = (await handle.boundingBox())!;
    expect(box.x + box.width, `${text}: handle overlaps the text column`).toBeLessThanOrEqual(
      contentLeft + 0.5,
    );
    expect(box.x, `${text}: handle left the editor`).toBeGreaterThanOrEqual(0);
  }
});

/* A multi-line block has ONE handle, beside its first line. Hovering anywhere
 * in a list — a later item, a nested child — surfaces that same handle at the
 * list's top line; it is never drawn lower down, beside the item under the
 * pointer. */
gutterHandleTest(
  "the ⠿ handle stays beside a list's first line wherever the list is hovered",
  async ({ page }) => {
    await hostSetContent(
      page,
      'intro\n\n- List item D\n- List item E\n  - Child of E\n  - Another child of E\n- List item F\n\noutro',
    );
    const first = (await page.getByText('List item D', { exact: true }).boundingBox())!;
    const firstLine = first.y + first.height / 2;
    const handle = page.locator('.milkdown-block-handle[data-show="true"]');
    const handleY = async () => {
      const box = await handle.boundingBox();
      return box ? box.y + box.height / 2 : Number.NaN;
    };

    for (const text of ['List item D', 'Child of E', 'Another child of E', 'List item F']) {
      // Away from the handle first, so each hover is a fresh resolve.
      const intro = await blockCenter(page, 'intro');
      await page.mouse.move(intro.x, intro.y, { steps: 2 });
      await expect
        .poll(handleY, { message: `${text}: handle reached intro` })
        .toBeLessThan(first.y);

      const box = (await page.getByText(text, { exact: true }).boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
      await expect
        .poll(async () => Math.abs((await handleY()) - firstLine), {
          message: `hovering "${text}": handle beside the list's first line`,
        })
        .toBeLessThan(2);
    }
  },
);

gutterHandleTest('a mouse drag on the ⠿ handle reorders the block', async ({ page }) => {
  await hostSetContent(page, '# alpha\n\nbravo\n\ncharlie');
  await clearMessages(page);

  // Hover is what surfaces the handle for a block under a mouse.
  const alpha = await blockCenter(page, 'alpha');
  await page.mouse.move(alpha.x, alpha.y);
  const handle = page.locator('.milkdown-block-handle[data-show="true"]');
  await handle.waitFor({ state: 'attached' });

  // bravo's lower half, so the drop lands after bravo and above charlie — the
  // same rule the long-press path uses. Not charlie's top edge: the slot is
  // judged against the blocks as the preview draws them, and with alpha gone
  // from the top bravo slides up and charlie with it (its margin above
  // changes), so charlie's old top edge is in charlie's DRAWN lower half.
  const bravo = page.getByText('bravo', { exact: true }).first();
  const bravoHeight = (await bravo.boundingBox())!.height;
  await handle.dragTo(bravo, { targetPosition: { x: 4, y: bravoHeight - 3 } });

  const changes = await waitForMessages(page, 'change');
  const content = changes[changes.length - 1].content as string;
  // Moved off the top, and STILL A HEADING — a re-fitted slice would have
  // unwrapped it into the surrounding paragraph.
  expect(content).toBe('bravo\n\n# alpha\n\ncharlie\n');
});

/* The ⠿ handle's drag is POINTER-DRIVEN, the same ghost-card drag the native
 * shells use after a long press (blockDragSession.ts) — never the browser's own
 * HTML5 drag, whose OS-drawn drag image came out oversized on a fractionally
 * scaled WebKitGTK display and cannot be fixed from the page. Nothing here can
 * see an OS drag image, so the assertions are its absence (no `dragstart`, no
 * `setDragImage`) and the page-drawn ghost that replaces it. */
gutterHandleTest(
  'a ⠿ handle drag starts no HTML5 drag, draws the ghost card at the block size, and commits on drop',
  async ({ page }) => {
    // A column narrower than the viewport, so the card's own clamp to the screen
    // edges (a full-width block would hit it) cannot color the size check.
    await page.addStyleTag({ content: '.futo-milkdown { max-width: 600px; }' });
    await hostSetContent(page, 'alpha\n\nbravo\n\ncharlie');
    await clearMessages(page);
    await page.evaluate(() => {
      const probe = { dragstart: 0, setDragImage: 0 };
      (window as unknown as { __html5Drag: typeof probe }).__html5Drag = probe;
      document.addEventListener('dragstart', () => (probe.dragstart += 1), true);
      const original = DataTransfer.prototype.setDragImage;
      DataTransfer.prototype.setDragImage = function (...args) {
        probe.setDragImage += 1;
        return original.apply(this, args);
      };
    });

    const block = (await page
      .locator('.ProseMirror > *', { hasText: 'alpha' })
      .first()
      .boundingBox())!;
    const charlie = await blockBox(page, 'charlie');
    const handle = await surfaceHandle(page, 'alpha');
    // The first lift move and the second one below (startHandleDrag): the ghost
    // is drawn over the block at lift and then follows the pointer by the
    // delta since.
    const drag = await startHandleDrag(page, handle);
    const delta = { x: 4, y: 12 };

    const html5 = await page.evaluate(
      () =>
        (window as unknown as { __html5Drag: { dragstart: number; setDragImage: number } })
          .__html5Drag,
    );
    expect(html5, 'an HTML5 drag started: the OS would draw its own drag image').toEqual({
      dragstart: 0,
      setDragImage: 0,
    });

    // The card is the block plus its padding (12px a side, GHOST_PAD_Y_PX above
    // and below, 1px border) grown by the 1.04 lift scale. An OS drag image at a
    // fractional display scale was ~2x; this is the "not scaled up" check.
    const card = page.locator('.futo-mobile-dnd-ghost-card');
    await expect
      .poll(async () => (await card.boundingBox())?.width ?? 0, { message: 'ghost card width' })
      .toBeGreaterThan(0);
    const expectedWidth = (block.width + 24) * 1.04;
    const expectedHeight = (block.height + 2 * GHOST_PAD_Y_PX + 2) * 1.04;
    await expect
      .poll(async () => Math.abs(((await card.boundingBox())?.width ?? 0) - expectedWidth) < 3, {
        message: 'ghost card width never settled at the block width plus padding',
      })
      .toBe(true);
    const box = (await card.boundingBox())!;
    expect(Math.abs(box.height - expectedHeight)).toBeLessThan(3);
    expect(Math.abs(box.x + box.width / 2 - (block.x + block.width / 2 + delta.x))).toBeLessThan(3);
    expect(Math.abs(box.y + box.height / 2 - (block.y + block.height / 2 + delta.y))).toBeLessThan(
      6,
    );

    await drag.drop(charlie.x, charlie.bottom - 3);
    const changes = await waitForMessages(page, 'change');
    expect(changes[changes.length - 1].content).toBe('bravo\n\ncharlie\n\nalpha\n');
    await expect(page.locator('.futo-mobile-dnd-ghost')).toHaveCount(0);
  },
);

gutterHandleTest(
  'pressing and releasing the ⠿ handle without moving changes neither the document nor the selection',
  async ({ page }) => {
    await hostSetContent(page, 'alpha\n\nbravo');
    await caretAtEndOf(page, 'bravo');
    await clearMessages(page);
    const handle = await surfaceHandle(page, 'alpha');
    await page.mouse.move(handle.x, handle.y);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(50);

    expect(await getContent(page)).toBe('alpha\n\nbravo');
    expect(await messagesOfType(page, 'change')).toHaveLength(0);
    expect(await domSelection(page)).toEqual({ collapsed: true, text: '', block: 'bravo' });
    await expect(page.locator('.futo-mobile-dnd-ghost')).toHaveCount(0);
  },
);

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
    // The held block no longer exists, so the drop is canceled.
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

/* The DESKTOP half of "one boundary, one place to drop it".
 *
 * The indicator used to be @milkdown/kit/plugin/cursor's, which wraps
 * prosemirror-drop-indicator: its `getTargetsByView` pushes a target for every
 * block's TOP edge AND another for its BOTTOM edge, then picks the nearest
 * LINE. Block A's bottom and block B's top are one document position drawn at
 * two different y values, so every gap offered two visible slots that meant the
 * same thing. The handle drag now draws the shared session's line
 * (blockDragSession.ts), the one the long press draws. */
gutterHandleTest('the ⠿ handle previews ONE slot per gap, from either side', async ({ page }) => {
  await hostSetContent(page, '# alpha\n\nbravo\n\ncharlie');
  await clearMessages(page);

  const order = ['alpha', 'bravo', 'charlie'];
  const handle = await surfaceHandle(page, 'alpha');
  const bravo = await blockBox(page, 'bravo');
  const charlie = await blockBox(page, 'charlie');
  // Otherwise "between them" is not a region and the assertion is vacuous.
  expect(charlie.top).toBeGreaterThan(bravo.bottom);

  const drag = await startHandleDrag(page, handle);

  // bravo's lower half, then charlie's upper half: the same boundary, so the
  // same slot opens (bravo slid up, alpha parked after it). Charlie's upper
  // half as the preview DRAWS it: with alpha gone from the top, charlie is
  // drawn higher than it sat at the lift (`drawnBox`).
  await drag.over(bravo.x, bravo.bottom - 3);
  const fromAbove = await reflowGap(page, order, 0);
  const drawnCharlie = await drawnBox(page, 'charlie');
  expect(drawnCharlie.top).toBeLessThan(charlie.top);
  await drag.over(charlie.x, drawnCharlie.top + 3);
  const fromBelow = await reflowGap(page, order, 0);

  expect(fromAbove).toBe(2);
  expect(fromBelow).toBe(fromAbove);

  // And the drop commits where the slot was: alpha lands between them,
  // still a heading (a re-fitted slice would have unwrapped it).
  await drag.drop(charlie.x, drawnCharlie.top + 3);
  const changes = await waitForMessages(page, 'change');
  expect(changes[changes.length - 1].content).toBe('bravo\n\n# alpha\n\ncharlie\n');
});

/* "Above or below" follows the pointer against the blocks AS THE PREVIEW DRAWS
 * THEM. Judged against the lift-time layout instead, a long paragraph dragged
 * past a block flipped back the moment the pointer re-entered that block's OLD
 * upper half — a whole paragraph-height below where the block is drawn now,
 * inside the paragraph's own slot. */
gutterHandleTest(
  'the ⠿ handle flips a slot back only past the drawn middle of the block that passed it',
  async ({ page }) => {
    const long = `alpha ${'lorem ipsum dolor sit amet '.repeat(60).trim()}`;
    await hostSetContent(page, `${long}\n\nbravo\n\ncharlie`);
    await clearMessages(page);

    const order = [long, 'bravo', 'charlie'];
    const alpha = await blockBox(page, 'alpha');
    const bravo = await blockBox(page, 'bravo');
    // Taller than bravo by a lot, or bravo's old and drawn places overlap.
    expect(alpha.bottom - alpha.top).toBeGreaterThan(4 * (bravo.bottom - bravo.top));

    const drag = await startHandleDrag(page, await surfaceHandle(page, 'alpha'));
    await drag.over(bravo.x, bravo.bottom - 3);
    expect(await reflowGap(page, order, 0)).toBe(2);

    // bravo's lift-time upper half is now inside the drawn slot, well below
    // bravo (slid up to alpha's place): the slot stays.
    await drag.over(bravo.x, bravo.top + 3);
    expect(await reflowGap(page, order, 0)).toBe(2);

    // Above bravo's drawn middle, it flips back.
    await drag.over(bravo.x, alpha.top + 2);
    expect(await reflowGap(page, order, 0)).toBeNull();

    await drag.drop(bravo.x, alpha.top + 2);
    expect(await messagesOfType(page, 'edited')).toHaveLength(0);
  },
);

gutterHandleTest(
  'the ⠿ handle flips a slot back down only past the drawn middle of the block that passed it',
  async ({ page }) => {
    const long = `alpha ${'lorem ipsum dolor sit amet '.repeat(60).trim()}`;
    await hostSetContent(page, `bravo\n\ncharlie\n\n${long}`);
    await clearMessages(page);

    const order = ['bravo', 'charlie', long];
    const bravo = await blockBox(page, 'bravo');
    const alpha = await blockBox(page, 'alpha');
    expect(alpha.bottom - alpha.top).toBeGreaterThan(4 * (bravo.bottom - bravo.top));

    const drag = await startHandleDrag(page, await surfaceHandle(page, 'alpha'));
    await drag.over(bravo.x, bravo.top + 3);
    expect(await reflowGap(page, order, 2)).toBe(0);

    // bravo's lift-time lower half is inside the drawn slot, well above bravo
    // (pushed down by alpha's height): the slot stays at the top.
    await drag.over(bravo.x, bravo.bottom - 3);
    expect(await reflowGap(page, order, 2)).toBe(0);

    await drag.drop(bravo.x, bravo.bottom - 3);
    const changes = await waitForMessages(page, 'change');
    expect(changes[changes.length - 1].content).toBe(`${long}\n\nbravo\n\ncharlie\n`);
  },
);

gutterHandleLineTest(
  'the ⠿ handle draws ONE line per gap (drop line), in the gap, from either side',
  async ({ page }) => {
    await hostSetContent(page, '# alpha\n\nbravo\n\ncharlie');
    await clearMessages(page);

    const handle = await surfaceHandle(page, 'alpha');
    const bravo = await blockBox(page, 'bravo');
    const charlie = await blockBox(page, 'charlie');
    // Otherwise "between them" is not a region and the assertion is vacuous.
    expect(charlie.top).toBeGreaterThan(bravo.bottom);

    const drag = await startHandleDrag(page, handle);

    // bravo's lower half, then charlie's upper half: the same boundary.
    await drag.over(bravo.x, bravo.bottom - 3);
    const fromAbove = await dropIndicatorTop(page);
    await drag.over(charlie.x, charlie.top + 3);
    const fromBelow = await dropIndicatorTop(page);

    expect(fromAbove).not.toBeNull();
    expect(fromBelow).toBe(fromAbove);
    // Drawn IN the gap, not on either block's edge.
    expect(fromAbove as number).toBeGreaterThan(bravo.bottom);
    expect(fromAbove as number).toBeLessThan(charlie.top);

    // And the drop commits where the line was drawn: alpha lands between them,
    // still a heading (a re-fitted slice would have unwrapped it).
    await drag.drop(charlie.x, charlie.top + 3);
    const changes = await waitForMessages(page, 'change');
    expect(changes[changes.length - 1].content).toBe('bravo\n\n# alpha\n\ncharlie\n');
  },
);

// The desktop half of the same drop-line-over-the-ghost complaint the
// long-press test above covers: dragging over the block's own two boundaries
// must draw no line either, since the move already refuses to commit there
// (blockMove.ts isNoOpDrop).
gutterHandleTest(
  "the ⠿ handle's preview stays shut while dragging over the block's own gaps",
  async ({ page }) => {
    await hostSetContent(page, 'alpha\n\nbravo\n\ncharlie');
    await clearMessages(page);

    const order = ['alpha', 'bravo', 'charlie'];
    const alpha = await blockBox(page, 'alpha');
    const handle = await surfaceHandle(page, 'alpha');
    const bravo = await blockBox(page, 'bravo');

    const drag = await startHandleDrag(page, handle);

    // Still over "alpha" itself (its own upper boundary): nothing shifts.
    await drag.over(alpha.x, alpha.top + 2);
    expect(await reflowGap(page, order, 0)).toBeNull();

    // Its own lower boundary too (alpha's lower half is the gap after it).
    await drag.over(alpha.x, alpha.bottom - 2);
    expect(await reflowGap(page, order, 0)).toBeNull();

    // A genuinely different gap opens its slot.
    await drag.over(bravo.x, bravo.bottom - 3);
    expect(await reflowGap(page, order, 0)).toBe(2);

    // Back over the source: the slot closes again.
    await drag.over(alpha.x, alpha.top + 2);
    expect(await reflowGap(page, order, 0)).toBeNull();

    // Release back over the source: a no-op, not a commit.
    await drag.drop(alpha.x, alpha.top + 2);
    expect(await messagesOfType(page, 'edited')).toHaveLength(0);
  },
);

gutterHandleLineTest(
  "the ⠿ handle's line (drop line) hides while dragging over the block's own gaps",
  async ({ page }) => {
    await hostSetContent(page, 'alpha\n\nbravo\n\ncharlie');
    await clearMessages(page);

    const alpha = await blockBox(page, 'alpha');
    const handle = await surfaceHandle(page, 'alpha');
    const bravo = await blockBox(page, 'bravo');

    const drag = await startHandleDrag(page, handle);

    // Still over "alpha" itself (its own upper boundary): no line.
    await drag.over(alpha.x, alpha.top + 2);
    expect(await dropIndicatorTop(page)).toBeNull();

    // Its own lower boundary too.
    await drag.over(alpha.x, alpha.bottom - 2);
    expect(await dropIndicatorTop(page)).toBeNull();

    // A genuinely different gap draws the line as before.
    await drag.over(bravo.x, bravo.bottom - 3);
    expect(await dropIndicatorTop(page)).not.toBeNull();

    // Release back over the source: a no-op, not a commit.
    await drag.drop(alpha.x, alpha.top + 2);
    expect(await messagesOfType(page, 'edited')).toHaveLength(0);
  },
);

/** A list-final document with its trailing newlines collapsed to one:
 * @milkdown/kit/plugin/trailing keeps an empty paragraph after a list-final
 * document, which is upstream behavior and not what these assert. */
const listOnly = (markdown: string): string => markdown.replace(/\n+$/, '\n');

/* A drag only ever lifts a TOP-LEVEL block. The handle used to stand for the
 * list ITEM beside it, and a list item could not be previewed by the curtain,
 * so dragging flipped between the reflow preview and the drop line depending
 * on what was grabbed. Now the handle beside any item, at any depth, stands
 * for the whole list. */
gutterHandleTest(
  'the ⠿ handle beside a nested list item drags the whole list, with the reflow preview',
  async ({ page }) => {
    await hostSetContent(page, 'intro\n\n- one\n- two\n  - nested\n- three\n\noutro');
    await clearMessages(page);

    const order = ['intro', 'onetwonestedthree', 'outro'];
    // Hover the nested item's TEXT: before, that made the item the active block.
    const nested = (await page.getByText('nested', { exact: true }).boundingBox())!;
    await page.mouse.move(nested.x + nested.width / 2, nested.y + nested.height / 2, {
      steps: 4,
    });
    // The handle comes up beside the list's FIRST line, which is where the
    // block it stands for starts — not beside the hovered item.
    const one = (await page.getByText('one', { exact: true }).boundingBox())!;
    const shown = page.locator('.milkdown-block-handle[data-show="true"]');
    await expect
      .poll(async () => {
        const box = await shown.boundingBox();
        return box ? Math.abs(box.y + box.height / 2 - (one.y + one.height / 2)) : Infinity;
      })
      .toBeLessThan(4);
    const box = (await shown.boundingBox())!;
    const handle = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

    const outro = await blockBox(page, 'outro');
    const drag = await startHandleDrag(page, handle);
    await drag.over(outro.x, outro.bottom - 3);
    await expect(page.locator('.futo-mobile-dnd-source')).toHaveText(/one.*two.*nested.*three/s);
    expect(await reflowGap(page, order, 1)).toBe(3);
    expect(await dropIndicatorTop(page)).toBeNull();
    await drag.drop(outro.x, outro.bottom - 3);

    const changes = await waitForMessages(page, 'change');
    expect(listOnly(changes[changes.length - 1].content as string)).toBe(
      'intro\n\noutro\n\n- one\n- two\n  - nested\n- three\n',
    );
  },
);

/* Drops only land in top-level gaps: a paragraph dragged over the middle of a
 * list lands above or below the whole list, never between its items. */
gutterHandleTest(
  'a block dragged over a list lands beside it, never inside it',
  async ({ page }) => {
    await hostSetContent(page, 'alpha\n\n- one\n- two\n- three\n\nomega');
    await clearMessages(page);

    const handle = await surfaceHandle(page, 'alpha');
    const two = (await page.getByText('two', { exact: true }).boundingBox())!;
    const drag = await startHandleDrag(page, handle);
    // "two" sits in the list's lower half: the gap after the list.
    await drag.drop(two.x + two.width / 2, two.y + two.height - 2);

    const changes = await waitForMessages(page, 'change');
    expect(changes[changes.length - 1].content).toBe('- one\n- two\n- three\n\nalpha\n\nomega\n');
  },
);

/* USING THE ⠿ HANDLE NEVER SELECTS ANYTHING. @milkdown/plugin-block used to
 * dispatch a NodeSelection over the block on mousedown — it was what its HTML5
 * drag carried — and nothing ever took it back: a click that did not drag, a
 * drop back where the block started, or a drag released outside the note all
 * left the whole block selected, and ProseMirror hands that selection to the
 * browser as a native range over the block's text, so it painted as highlighted
 * text. Reported: "sometimes when I use it, text or other items get selected".
 * The handle's mousedown is now canceled before the plugin sees it (the drag is
 * pointer-driven), so the user's own selection is never touched, and is carried
 * along with the block when it was inside the one that moved. */

/** The DOM selection, reduced to what these tests assert on. */
function domSelection(page: Page): Promise<{ collapsed: boolean; text: string; block: string }> {
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
async function caretAtEndOf(page: Page, text: string): Promise<void> {
  const box = (await page.getByText(text, { exact: true }).first().boundingBox())!;
  await page.mouse.click(box.x + box.width - 1, box.y + box.height / 2);
  await expect.poll(() => domSelection(page)).toMatchObject({ collapsed: true, block: text });
}

gutterHandleTest('clicking the ⠿ handle leaves the caret where it was', async ({ page }) => {
  await hostSetContent(page, 'alpha\n\nbravo');
  await caretAtEndOf(page, 'bravo');

  const handle = await surfaceHandle(page, 'alpha');
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  await page.mouse.up();
  // The old plugin-block refocused the view a frame after mouseup; leave it
  // that long, so a regression of that kind shows.
  await page.waitForTimeout(50);

  expect(await domSelection(page)).toEqual({ collapsed: true, text: '', block: 'bravo' });
});

gutterHandleTest('a block moved with the ⠿ handle leaves nothing selected', async ({ page }) => {
  await hostSetContent(page, 'alpha\n\nbravo\n\ncharlie');
  await caretAtEndOf(page, 'charlie');
  await clearMessages(page);

  const handle = await surfaceHandle(page, 'alpha');
  const charlie = await blockBox(page, 'charlie');
  const drag = await startHandleDrag(page, handle);
  await drag.drop(charlie.x, charlie.top + 3);
  const changes = await waitForMessages(page, 'change');
  expect(changes[changes.length - 1].content).toBe('bravo\n\nalpha\n\ncharlie\n');

  await expect
    .poll(() => domSelection(page))
    .toEqual({ collapsed: true, text: '', block: 'charlie' });
});

gutterHandleTest('the caret travels with the block the ⠿ handle moved', async ({ page }) => {
  await hostSetContent(page, 'alpha\n\nbravo\n\ncharlie');
  await caretAtEndOf(page, 'alpha');
  await clearMessages(page);

  const handle = await surfaceHandle(page, 'alpha');
  const charlie = await blockBox(page, 'charlie');
  const drag = await startHandleDrag(page, handle);
  await drag.drop(charlie.x, charlie.bottom - 3);
  await waitForMessages(page, 'change');

  await expect
    .poll(() => domSelection(page))
    .toEqual({ collapsed: true, text: '', block: 'alpha' });
  // At the same offset it had: typing lands at the end of "alpha".
  await clearMessages(page);
  await page.keyboard.type('!');
  const changes = await waitForMessages(page, 'change');
  expect(changes[changes.length - 1].content).toBe('bravo\n\ncharlie\n\nalpha!\n');
});

gutterHandleTest(
  'a ⠿ drag released back over its own block leaves nothing selected',
  async ({ page }) => {
    await hostSetContent(page, 'alpha\n\nbravo\n\ncharlie');
    await caretAtEndOf(page, 'charlie');

    const alpha = await blockBox(page, 'alpha');
    const handle = await surfaceHandle(page, 'alpha');
    const drag = await startHandleDrag(page, handle);
    await drag.drop(alpha.x, alpha.top + 2);

    await expect
      .poll(() => domSelection(page))
      .toEqual({ collapsed: true, text: '', block: 'charlie' });
  },
);

gutterHandleTest(
  'pressing the ⠿ handle selects nothing and leaves the caret alone',
  async ({ page }) => {
    await hostSetContent(page, 'alpha\n\nbravo');
    await caretAtEndOf(page, 'bravo');
    const handle = await surfaceHandle(page, 'alpha');
    await page.mouse.move(handle.x, handle.y);
    await page.mouse.down();

    // Mid-press, before any release: the plugin's NodeSelection would be a range
    // over alpha's text by now.
    expect(await domSelection(page)).toEqual({ collapsed: true, text: '', block: 'bravo' });
    await page.mouse.up();
  },
);

/* The handle is a mouse target: big enough to hit without aiming, and beside
 * the line a block STARTS on — floating-ui centered it on the whole block, which
 * put it halfway down a long paragraph. */
gutterHandleTest('the ⠿ handle is a comfortable target on the first line', async ({ page }) => {
  const long = 'wrapping words '.repeat(60).trim();
  await hostSetContent(page, `${long}\n\nafter`);
  const block = await blockBox(page, 'wrapping');
  const handle = await surfaceHandle(page, 'wrapping');
  const firstLine = await page.evaluate(() => {
    const text = document.querySelector('.ProseMirror > p')!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 1);
    const rect = range.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom };
  });
  // Several lines, or this is not testing anything.
  expect(block.bottom - block.top).toBeGreaterThan(4 * (firstLine.bottom - firstLine.top));
  expect(Math.abs(handle.y - (firstLine.top + firstLine.bottom) / 2)).toBeLessThan(2);

  const box = (await page.locator('.milkdown-block-handle[data-show="true"]').boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(24);
  expect(box.height).toBeGreaterThanOrEqual(24);
});

gutterHandleTest(
  'a ⠿ drag down the whole note passes through one slot per boundary',
  async ({ page }) => {
    await hostSetContent(page, '# alpha\n\nbravo\n\ncharlie');
    await clearMessages(page);

    const handle = await surfaceHandle(page, 'alpha');
    const blocks = [
      await blockBox(page, 'alpha'),
      await blockBox(page, 'bravo'),
      await blockBox(page, 'charlie'),
    ];

    // Every region a pointer can be in, top to bottom: each block's upper
    // half, its lower half, and the margin between it and the next.
    const upper = (b: (typeof blocks)[number]) => b.top + (b.bottom - b.top) * 0.25;
    const lower = (b: (typeof blocks)[number]) => b.top + (b.bottom - b.top) * 0.75;
    const probes: number[] = [];
    blocks.forEach((block, i) => {
      probes.push(upper(block), lower(block));
      const next = blocks[i + 1];
      if (next) probes.push((block.bottom + next.top) / 2);
    });

    const drag = await startHandleDrag(page, handle);
    const order = ['alpha', 'bravo', 'charlie'];
    const gaps: number[] = [];
    for (const y of probes) {
      await drag.over(blocks[0].x, y);
      const gap = await reflowGap(page, order, 0);
      if (gap !== null && !gaps.includes(gap)) gaps.push(gap);
    }
    await drag.drop(blocks[0].x, (blocks[1].bottom + blocks[2].top) / 2);

    // "alpha" is the block being dragged, so its own two boundaries — the very
    // start of the document, and the alpha/bravo gap it already sits against —
    // are no-op drops and shift nothing (isNoOpDrop, blockMove.ts): alpha's own
    // halves, the margin right after it, and bravo's upper half (the SAME gap)
    // all resolved to null above. That leaves the two REAL boundaries — the
    // bravo/charlie gap (2) and the end of the document (3) — each opening
    // exactly one slot, in order, bravo's lower half flipping at its own
    // midpoint.
    expect(gaps).toEqual([2, 3]);
  },
);

gutterHandleLineTest(
  'a ⠿ drag down the whole note passes through one line per boundary (drop line)',
  async ({ page }) => {
    await hostSetContent(page, '# alpha\n\nbravo\n\ncharlie');
    await clearMessages(page);

    const handle = await surfaceHandle(page, 'alpha');
    const blocks = [
      await blockBox(page, 'alpha'),
      await blockBox(page, 'bravo'),
      await blockBox(page, 'charlie'),
    ];

    // Every region a pointer can be in, top to bottom: each block's upper
    // half, its lower half, and the margin between it and the next.
    const upper = (b: (typeof blocks)[number]) => b.top + (b.bottom - b.top) * 0.25;
    const lower = (b: (typeof blocks)[number]) => b.top + (b.bottom - b.top) * 0.75;
    const probes: number[] = [];
    blocks.forEach((block, i) => {
      probes.push(upper(block), lower(block));
      const next = blocks[i + 1];
      if (next) probes.push((block.bottom + next.top) / 2);
    });

    const drag = await startHandleDrag(page, handle);
    const tops: number[] = [];
    for (const y of probes) {
      await drag.over(blocks[0].x, y);
      const top = await dropIndicatorTop(page);
      if (top !== null && !tops.includes(top)) tops.push(top);
    }
    await drag.drop(blocks[0].x, (blocks[1].bottom + blocks[2].top) / 2);

    // "alpha" is the block being dragged, so its own two boundaries — the very
    // start of the document, and the alpha/bravo gap it already sits against —
    // are no-op drops and draw no line (isNoOpDrop, blockMove.ts): alpha's own
    // upper and lower halves, the margin right after it, and bravo's upper
    // half (the SAME alpha/bravo gap, approached from the other side) all
    // resolved to `null` above and are absent from `tops`. That leaves the
    // remaining two REAL boundaries — the bravo/charlie gap and the end of the
    // document — each drawing exactly one line, not the four the old
    // prosemirror-drop-indicator-based model drew for two gaps.
    expect(tops).toHaveLength(2);
    // `style.top` keeps six significant digits, so compare to the sub-pixel.
    expect(tops[0]).toBeCloseTo((blocks[1].bottom + blocks[2].top) / 2, 2);
    expect(tops[1]).toBeCloseTo(blocks[2].bottom, 2);
  },
);

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
const mobileDndTest = mobileDndFixture('');
/** Live reflow forced off: the long-press drag draws the drop line. */
const mobileDndLineTest = mobileDndFixture('&blockDragReflow=off');

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

// ---- edge auto-scroll (the off-screen half of the note) ------------------
//
// Without it, a block can only be moved to a boundary that is ALREADY on
// screen: the finger has to stay down, so it cannot scroll the note first. The
// original helper stepped `scrollTop` by 14px once per `pointermove`, which
// means a finger PARKED in the edge zone — the whole gesture — produced no
// events and therefore no scrolling at all. A device QA pass on a 250-block
// note held the bottom edge for 20-25 seconds, re-approaching it from several
// y positions, and the content never moved once.

/** Enough blocks to overflow the editor's own scroller several times over, and
 * numbered so the drop position is readable from the serialized note. Kept
 * under progressive open's 400-line threshold so this exercises the ordinary
 * whole-document load. */
function scrollableNote(lines = 150): string {
  return Array.from({ length: lines }, (_, i) => `Line ${i}`).join('\n\n') + '\n';
}

/** `.ProseMirror` owns overflow-y here (MilkdownEditor.svelte), so it — not the
 * page — is the scroller edge auto-scroll drives. */
function editorScroll(page: Page): Promise<{
  top: number;
  max: number;
  topEdge: number;
  bottomEdge: number;
}> {
  return page.evaluate(() => {
    const dom = document.querySelector('.ProseMirror') as HTMLElement;
    const rect = dom.getBoundingClientRect();
    return {
      top: dom.scrollTop,
      max: dom.scrollHeight - dom.clientHeight,
      topEdge: rect.top,
      bottomEdge: rect.bottom,
    };
  });
}

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

/** Where one block's content is drawn on screen, keyed (`dragLayout`) by what
 * it shows: the top of its first line, the bottom of its last, and its left
 * edge. Content, not the element's box: a preview clone's box legitimately
 * differs from the real block's by the margins its children collapse through. */
interface LaidOutBlock {
  top: number;
  bottom: number;
  left: number;
  index: number;
}

/** What the user sees during a reflow drag, or after it: the scroll position,
 * and every block's content keyed by its text (an image by its alt text, a
 * rule by its tag). `curtain` reads the preview's clones — only those on
 * screen, which is what the user is looking at — and names the lifted
 * block's; otherwise the real blocks, all of them. */
function dragLayout(
  page: Page,
  curtain: boolean,
): Promise<{ scrollTop: number; source: string | null; blocks: Record<string, LaidOutBlock> }> {
  return page.evaluate((fromCurtain) => {
    const editor = document.querySelector('.ProseMirror[contenteditable]') as HTMLElement;
    const root = fromCurtain
      ? (document.querySelector('.futo-mobile-dnd-reflow-curtain') as HTMLElement | null)
      : editor;
    const view = editor.getBoundingClientRect();
    const keyOf = (el: Element) =>
      (el.textContent ?? '').replace(/\s+/g, ' ').trim() ||
      el.querySelector('img')?.getAttribute('alt') ||
      el.tagName;
    const lineRects = (el: Element): DOMRect[] => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const rects: DOMRect[] = [];
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.textContent?.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        rects.push(...Array.from(range.getClientRects()).filter((r) => r.height > 0));
      }
      return rects;
    };
    const blocks: Record<string, { top: number; bottom: number; left: number; index: number }> = {};
    let source: string | null = null;
    Array.from(root?.children ?? []).forEach((block, index) => {
      const box = block.getBoundingClientRect();
      if (fromCurtain && (box.bottom <= view.top || box.top >= view.bottom)) return;
      const key = keyOf(block);
      if (block.classList.contains('futo-mobile-dnd-reflow-source')) source = key;
      const lines = lineRects(block);
      const drawn = block.querySelector('img, hr')?.getBoundingClientRect() ?? box;
      blocks[key] = lines.length
        ? {
            top: Math.min(...lines.map((r) => r.top)),
            bottom: Math.max(...lines.map((r) => r.bottom)),
            left: Math.min(...lines.map((r) => r.left)),
            index,
          }
        : { top: drawn.top, bottom: drawn.bottom, left: drawn.left, index };
    });
    return { scrollTop: editor.scrollTop, source, blocks };
  }, curtain);
}

/** Waits until the reflow preview is at rest: the finger's last move drawn,
 * and the slides it started finished. The handle draws a move once per frame
 * (`queueMove`), so on a loaded machine the last frames can come well after
 * the move was sent, and a slide runs in real time from the frame that starts
 * it: a fixed sleep read the clones mid-way, or before their last gap was
 * drawn at all. The frames first (callbacks run in the order they were asked
 * for, so ours follow the drag's), then the transitions on the curtain, until
 * none is left (a remeasure can start more). */
async function previewAtRest(page: Page): Promise<void> {
  await flushFrames(page);
  await page.evaluate(async () => {
    const running = () =>
      document
        .getAnimations()
        .filter(
          (a) =>
            a.playState === 'running' &&
            (a.effect as KeyframeEffect | null)?.target?.closest('.futo-mobile-dnd-reflow-curtain'),
        );
    for (let left = running(); left.length > 0; left = running()) {
      await Promise.allSettled(left.map((a) => a.finished));
    }
  });
  await flushFrames(page);
}

/** The drop invariant: releasing a reflow drag moves NOTHING on screen. Every
 * block the preview showed — the neighbors it slid out of the way and the
 * dimmed source in its landing slot — is exactly where the real block sits
 * once the move has committed, and the note did not scroll. `release` lets
 * go; the returned layout is the real one after the drop. */
async function expectDropMatchesPreview(page: Page, release: () => Promise<void>) {
  await previewAtRest(page);
  const preview = await dragLayout(page, true);
  // Otherwise the comparison below could pass on an empty preview (M11).
  expect(Object.keys(preview.blocks).length).toBeGreaterThan(3);
  expect(preview.source, 'the lifted block is not in its landing slot').not.toBeNull();

  await release();
  await waitForMessages(page, 'change');
  await flushFrames(page);
  await expect(page.locator('.futo-mobile-dnd-reflow-clip')).toHaveCount(0);

  const real = await dragLayout(page, false);
  const moved: string[] = [];
  for (const [key, shown] of Object.entries(preview.blocks)) {
    const now = real.blocks[key];
    const label = `"${key.slice(0, 32)}"${key === preview.source ? ' (dropped)' : ''}`;
    if (!now) moved.push(`${label} is gone`);
    else if (
      Math.abs(now.top - shown.top) > 1 ||
      Math.abs(now.bottom - shown.bottom) > 1 ||
      Math.abs(now.left - shown.left) > 1
    ) {
      moved.push(
        `${label} preview ${shown.top.toFixed(1)}..${shown.bottom.toFixed(1)} @${shown.left.toFixed(1)}` +
          ` -> real ${now.top.toFixed(1)}..${now.bottom.toFixed(1)} @${now.left.toFixed(1)}`,
      );
    }
  }
  expect(moved, 'blocks that moved on release').toEqual([]);
  expect(real.scrollTop, 'the note scrolled on release').toBe(preview.scrollTop);
  return real;
}

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

// ---- the drop invariant, across block kinds -------------------------------
//
// The same invariant over every top-level block kind, as the source and as the
// neighbors it slides past, up and down, near and far, on both drag gestures.
// The note is the one the user found the multi-line case with (desktop,
// 2026-10-08: dragging the two-line intro paragraph down past A and B moved
// the other blocks on release; one-line blocks did not). List items are not
// sources here: they drag with the drop line, not the reflow preview.

const DRAG_PLAYGROUND = `# Drag Playground

Short, distinct blocks so it's obvious where each one lands. Long-press (mobile) or use the handle (desktop) and move things around. #editor

Paragraph A — the first plain paragraph.

Paragraph B — the second plain paragraph.

## Heading C

- List item D
- List item E
  - Child of E (should travel with E)
  - Second child of E
- List item F

1. Ordered G
2. Ordered H
3. Ordered I

- [ ] Task J
- [x] Task K
- [ ] Task L

> Quote M

\`\`\`
Code block N
\`\`\`

| Table | O |
|-------|---|
| row | 1 |

---

Paragraph P — after the rule.

![Image Q](sample-image.png)

Paragraph R — the last block.
`;

/** The playground's top-level blocks, by index, as the matrix names them. */
const PLAYGROUND_BLOCKS = [
  'H1',
  'intro (two lines)',
  'Paragraph A',
  'Paragraph B',
  'Heading C',
  'bullet list',
  'ordered list',
  'task list',
  'quote',
  'code',
  'table',
  'rule',
  'Paragraph P',
  'image',
  'Paragraph R',
];

/** Narrow enough that the intro wraps to two lines, as on the user's desktop,
 * and tall enough that the whole note is on screen: no edge auto-scroll. */
const PLAYGROUND_VIEWPORT = { width: 760, height: 1600 };

/** The box of the top-level block at `index`. */
async function blockBoxAt(
  page: Page,
  index: number,
): Promise<{ x: number; left: number; top: number; bottom: number }> {
  const box = await page.locator('.ProseMirror[contenteditable] > *').nth(index).boundingBox();
  if (!box) throw new Error(`no geometry for top-level block ${index}`);
  return { x: box.x + box.width / 2, left: box.x, top: box.y, bottom: box.y + box.height };
}

/** A lifted block, whichever gesture lifted it. */
interface LiftedBlock {
  x: number;
  move(y: number): Promise<void>;
  release(): Promise<void>;
}

/** Lifts top-level block `index` off its ⠿ handle (desktop). */
async function liftWithHandle(page: Page, index: number): Promise<LiftedBlock> {
  const block = await blockBoxAt(page, index);
  // Over the block's first line at its left: the handle stands for the
  // outermost block the hovered node is a FIRST child of, so hovering a
  // table's second column would surface (and drag) that header cell instead.
  await page.mouse.move(block.left + 10, block.top + 4);
  const handle = page.locator('.milkdown-block-handle[data-show="true"]');
  await handle.waitFor({ state: 'attached' });
  await expect
    .poll(async () => {
      const box = await handle.boundingBox();
      const y = box ? box.y + box.height / 2 : -1;
      return y >= block.top - 8 && y <= block.bottom + 8;
    })
    .toBe(true);
  const box = (await handle.boundingBox())!;
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await startHandleDrag(page, at);
  let y = at.y + 20;
  return {
    x: at.x,
    move: async (to) => {
      for (let step = 1; step <= 4; step += 1) {
        await page.mouse.move(at.x, y + ((to - y) * step) / 4);
        await page.waitForTimeout(16);
      }
      y = to;
    },
    release: () => page.mouse.up(),
  };
}

/** Long-presses top-level block `index` (native shells). */
async function liftWithTouch(page: Page, cdp: CDPSession, index: number): Promise<LiftedBlock> {
  const block = await blockBoxAt(page, index);
  const x = block.x;
  let y = Math.min(block.top + 12, (block.top + block.bottom) / 2);
  await touch(cdp, 'touchStart', x, y);
  await page.waitForTimeout(DEFAULT_LONG_PRESS_MS + 110);
  expect((await messagesOfType(page, 'haptic')).map((m) => m.kind)).toContain('lift');
  return {
    x,
    move: async (to) => {
      for (let step = 1; step <= 4; step += 1) {
        await touch(cdp, 'touchMove', x, y + ((to - y) * step) / 4);
        await page.waitForTimeout(16);
      }
      y = to;
    },
    release: () => touch(cdp, 'touchEnd', x, y),
  };
}

interface DropCase {
  source: number;
  /** The block the drop lands beside: after it going down, before it going up. */
  target: number;
}

/** Sources × {up, down} × {near, far}, skipping drops off either end. */
const DROP_CASES: DropCase[] = [0, 1, 2, 4, 8, 9, 10, 11, 13, 14].flatMap((source) =>
  [-6, -2, 2, 6]
    .map((offset) => ({ source, target: source + offset }))
    .filter(({ target }) => target >= 0 && target < PLAYGROUND_BLOCKS.length),
);

function dropCaseName({ source, target }: DropCase): string {
  const dir = target > source ? 'down' : 'up';
  const far = Math.abs(target - source) > 2 ? 'far' : 'near';
  return `${PLAYGROUND_BLOCKS[source]} ${dir} ${far} ${target > source ? 'after' : 'before'} ${PLAYGROUND_BLOCKS[target]}`;
}

/** Drags the case's source to its target with `lift`, and holds the drop to
 * the invariant; also checks it landed beside the target. */
async function runDropCase(page: Page, c: DropCase, lift: () => Promise<LiftedBlock>) {
  const target = await blockBoxAt(page, c.target);
  const keys = Object.keys((await dragLayout(page, false)).blocks);
  const lifted = await lift();
  const down = c.target > c.source;
  // The lower quarter of the target is "after it", the upper quarter "before".
  await lifted.move(target.top + (target.bottom - target.top) * (down ? 0.75 : 0.25));
  const real = await expectDropMatchesPreview(page, () => lifted.release());
  // ...and it is the move the case asked for.
  const landed = real.blocks[keys[c.source]].index - real.blocks[keys[c.target]].index;
  expect(landed).toBe(down ? 1 : -1);
}

/** Sources that cannot be lifted at all — lifting gaps, not reflow ones. The
 * rule, by either gesture: a press resolves to the position BETWEEN blocks
 * around a top-level leaf, and its line is 1px tall. The table, by the ⠿
 * handle: the table's row grip (table/tableGrips.ts) is drawn over the handle
 * at its first row, so the press goes to the grip. */
const RULE = PLAYGROUND_BLOCKS.indexOf('rule');
const TABLE = PLAYGROUND_BLOCKS.indexOf('table');

for (const c of DROP_CASES) {
  gutterHandleTest(
    `reflow drop matches its preview (handle): ${dropCaseName(c)}`,
    async ({ page }) => {
      gutterHandleTest.fixme(c.source === RULE, 'a horizontal rule cannot be lifted');
      gutterHandleTest.fixme(c.source === TABLE, "the table's row grip covers its ⠿ handle");
      await page.setViewportSize(PLAYGROUND_VIEWPORT);
      await hostSetContent(page, DRAG_PLAYGROUND);
      await clearMessages(page);
      await runDropCase(page, c, () => liftWithHandle(page, c.source));
    },
  );
  mobileDndTest(
    `reflow drop matches its preview (long press): ${dropCaseName(c)}`,
    async ({ page, cdp }) => {
      mobileDndTest.fixme(c.source === RULE, 'a horizontal rule cannot be lifted');
      await page.setViewportSize(PLAYGROUND_VIEWPORT);
      await hostSetContent(page, DRAG_PLAYGROUND);
      await clearMessages(page);
      await runDropCase(page, c, () => liftWithTouch(page, cdp, c.source));
    },
  );
}

/** The playground with enough after it to scroll. */
const SCROLLING_PLAYGROUND = `${DRAG_PLAYGROUND}\n${scrollableNote(60)}`;

/** Lifts `index`, holds the pointer in the bottom (or top) edge zone until the
 * note has scrolled `distance` px, then parks it mid-screen and drops. */
async function runAutoScrollDrop(
  page: Page,
  lift: () => Promise<LiftedBlock>,
  direction: 'down' | 'up',
) {
  const start = await editorScroll(page);
  const lifted = await lift();
  await lifted.move(direction === 'down' ? start.bottomEdge - 12 : start.topEdge + 12);
  await expect
    .poll(async () => Math.abs((await editorScroll(page)).top - start.top), { timeout: 8000 })
    .toBeGreaterThan(700);
  await lifted.move((start.topEdge + start.bottomEdge) / 2);
  await expectDropMatchesPreview(page, () => lifted.release());
}

const AUTO_SCROLL_VIEWPORT = { width: 760, height: 720 };

/** The intro (two lines) going down, and a block from the end going up. */
const AUTO_SCROLL_CASES = [
  { name: 'intro (two lines) down', index: 1, direction: 'down' as const },
  { name: 'Paragraph A down', index: 2, direction: 'down' as const },
  { name: 'Line 55 up', index: PLAYGROUND_BLOCKS.length + 55, direction: 'up' as const },
];

for (const c of AUTO_SCROLL_CASES) {
  const setUp = async (page: Page) => {
    await page.setViewportSize(AUTO_SCROLL_VIEWPORT);
    await hostSetContent(page, SCROLLING_PLAYGROUND);
    await clearMessages(page);
    if (c.direction === 'up') {
      await page.evaluate(() => {
        const dom = document.querySelector('.ProseMirror') as HTMLElement;
        dom.scrollTop = dom.scrollHeight;
      });
      await flushFrames(page);
    }
  };
  gutterHandleTest(
    `reflow drop after auto-scroll matches its preview (handle): ${c.name}`,
    async ({ page }) => {
      await setUp(page);
      await runAutoScrollDrop(page, () => liftWithHandle(page, c.index), c.direction);
    },
  );
  mobileDndTest(
    `reflow drop after auto-scroll matches its preview (long press): ${c.name}`,
    async ({ page, cdp }) => {
      await setUp(page);
      await runAutoScrollDrop(page, () => liftWithTouch(page, cdp, c.index), c.direction);
    },
  );
}

// ---- the drop invariant when the layout changes under the drag -------------
//
// The preview caches every block's geometry for the drag, but a block's size
// can change with the document untouched: a vault image resolves and loads
// (vaultImageView.ts sets `src` when the host's URL lands), a web font swaps
// in, the viewport resizes. The preview must follow, or the clones and the
// drop slot are judged against a layout the drop will not produce.

/** A 200px-tall image, served for any vault filename once the base URL below
 * is registered — only then, so it can load in the middle of a drag. */
const LATE_IMAGE_BASE = 'https://vault.futo-notes.test/';
const LATE_IMAGE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#c84"/></svg>';

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

/** Runs the page's animations at `rate` (0 stops them). */
async function animationRate(cdp: CDPSession, rate: number): Promise<void> {
  await cdp.send('Animation.enable');
  await cdp.send('Animation.setPlaybackRate', { playbackRate: rate });
}

/** Lifts alpha (by long press, or by its ⠿ handle with `handle`) and moves it
 * past charlie and delta, then catches the slide part-way: runs it at 5% speed
 * for a beat, then stops the clock. */
async function liftAndStopMidSlide(
  page: Page,
  cdp: CDPSession,
  handle = false,
): Promise<LiftedBlock> {
  const delta = await blockBox(page, 'delta');
  // A release must go on landing for as long as the test looks at it: with the
  // wall-clock cap off, only the slides' end, or what the test does, lands it.
  await page.evaluate(() => {
    (window as unknown as { __futoBlockDragLandCap?: string }).__futoBlockDragLandCap = 'off';
  });
  const lifted = handle ? await liftWithHandle(page, 0) : await liftWithTouch(page, cdp, 0);
  // Let the curtain open on a still finger, so only the move below slides.
  await page.waitForTimeout(300);
  await animationRate(cdp, 0.05);
  await lifted.move(delta.top + (delta.bottom - delta.top) * 0.75);
  await page.waitForTimeout(600);
  await animationRate(cdp, 0);
  return lifted;
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

const SLIDE_NOTE =
  'alpha\n\nbravo\n\ncharlie\n\ndelta\n\n![late image](late.svg)\n\necho\n\nfoxtrot';

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
          const img = document.querySelector('.futo-mobile-dnd-reflow-curtain img');
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

/** The text of every block of the real note, in order. */
function realOrder(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('.ProseMirror[contenteditable] > *')].map(
      (el) => (el.textContent ?? '').trim() || el.querySelector('img')?.alt || el.tagName,
    ),
  );
}

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
              const img = document.querySelector('.ProseMirror[contenteditable] img');
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

mobileDndTest('a scroll gesture never lifts a block', async ({ page, cdp }) => {
  await hostSetContent(page, 'alpha\n\nbravo\n\ncharlie');
  await clearMessages(page);

  const alpha = await blockCenter(page, 'alpha');
  await touch(cdp, 'touchStart', alpha.x, alpha.y);
  // Moving immediately (before the 340 ms timer) is an ordinary scroll.
  for (let step = 1; step <= 6; step += 1) {
    await touch(cdp, 'touchMove', alpha.x, alpha.y - step * 12);
    await page.waitForTimeout(16);
  }
  await touch(cdp, 'touchEnd', alpha.x, alpha.y - 72);
  await settleChangeDebounce(page);

  expect(await messagesOfType(page, 'haptic')).toHaveLength(0);
  expect(await messagesOfType(page, 'change')).toHaveLength(0);
  /* And no drag was reported, so the shell never suspended its text
   * interaction: a tap and a scroll both have to leave selection alone. */
  expect(await messagesOfType(page, 'blockDrag')).toHaveLength(0);
  expect(await getContent(page)).toBe('alpha\n\nbravo\n\ncharlie');
});

/* ---- blockPress: the suspension the shell acts on, requested at TOUCH-DOWN --
 *
 * `blockDrag` can only be posted once the 340ms lift timer has fired, which made
 * the shell's protection conditional on the page winning a race it does not
 * control — and a press that produced no lift got the OS magnifier and a word
 * selection with nothing suspended at all (bridge.ts BlockPressMessage).
 *
 * The RACE itself is native and cannot be reproduced here: Chromium has no
 * UIKit text-interaction stack to lose to. What these lock is the mechanism —
 * that the request goes out at touch-down and BEFORE the lift, and that every
 * single arm is resolved, so no gesture can leave the shell suspended (which
 * would kill text selection for the rest of the session). */

mobileDndTest('the press is reported at touch-down, before any lift', async ({ page, cdp }) => {
  await hostSetContent(page, 'alpha\n\nbravo\n\ncharlie');
  await clearMessages(page);

  const alpha = await blockCenter(page, 'alpha');
  await touch(cdp, 'touchStart', alpha.x, alpha.y);
  // Deliberately sampled BEFORE the lift timer could have fired. This is the
  // window that used to be unprotected.
  await waitForMessages(page, 'blockPress');
  expect((await messagesOfType(page, 'blockPress')).map((m) => m.pressed)).toEqual([true]);
  expect(await messagesOfType(page, 'blockDrag')).toHaveLength(0);
  expect(await messagesOfType(page, 'haptic')).toHaveLength(0);

  await touch(cdp, 'touchEnd', alpha.x, alpha.y);
  await settleChangeDebounce(page);
  expect((await messagesOfType(page, 'blockPress')).map((m) => m.pressed)).toEqual([true, false]);
});

mobileDndTest('a committed drag brackets its blockDrag inside its press', async ({ page, cdp }) => {
  await hostSetContent(page, 'alpha\n\nbravo\n\ncharlie');
  await clearMessages(page);

  const charlie = await blockCenter(page, 'charlie');
  await longPressDrag(page, cdp, await blockCenter(page, 'alpha'), {
    x: charlie.x,
    y: charlie.y + 4,
  });
  await waitForMessages(page, 'change');
  await settleChangeDebounce(page);

  /* The shell steps up a level and back down; the press is the outer bracket,
   * so it is never asked to restore while a block is still airborne. */
  const order = (await messages(page))
    .filter((m) => m.type === 'blockPress' || m.type === 'blockDrag')
    .map((m) => `${m.type}:${m.type === 'blockPress' ? m.pressed : m.active}`);
  expect(order).toEqual([
    'blockPress:true',
    'blockDrag:true',
    'blockDrag:false',
    'blockPress:false',
  ]);
});

/* EVERY way a press can end has to release it. A shell told `pressed: true` and
 * never told otherwise has WKWebView's loupe gesture disabled for the rest of
 * the session. */
for (const [name, run] of [
  [
    'a plain tap',
    async (page: Page, cdp: CDPSession, alpha: { x: number; y: number }) => {
      await touch(cdp, 'touchStart', alpha.x, alpha.y);
      await page.waitForTimeout(40);
      await touch(cdp, 'touchEnd', alpha.x, alpha.y);
    },
  ],
  [
    'a short hold that never lifts',
    async (page: Page, cdp: CDPSession, alpha: { x: number; y: number }) => {
      await touch(cdp, 'touchStart', alpha.x, alpha.y);
      await page.waitForTimeout(DEFAULT_LONG_PRESS_MS - 140);
      await touch(cdp, 'touchEnd', alpha.x, alpha.y);
    },
  ],
  [
    'a scroll',
    async (page: Page, cdp: CDPSession, alpha: { x: number; y: number }) => {
      await touch(cdp, 'touchStart', alpha.x, alpha.y);
      for (let step = 1; step <= 6; step += 1) {
        await touch(cdp, 'touchMove', alpha.x, alpha.y - step * 12);
        await page.waitForTimeout(16);
      }
      await touch(cdp, 'touchEnd', alpha.x, alpha.y - 72);
    },
  ],
  [
    'a cancelled press',
    async (page: Page, cdp: CDPSession, alpha: { x: number; y: number }) => {
      await touch(cdp, 'touchStart', alpha.x, alpha.y);
      await page.waitForTimeout(40);
      await touch(cdp, 'touchCancel', alpha.x, alpha.y);
    },
  ],
  [
    'a drop back at the source',
    async (page: Page, cdp: CDPSession, alpha: { x: number; y: number }) => {
      await longPressDrag(page, cdp, alpha, { x: alpha.x, y: alpha.y + 4 });
    },
  ],
  [
    'a cancel while airborne',
    async (page: Page, cdp: CDPSession, alpha: { x: number; y: number }) => {
      await touch(cdp, 'touchStart', alpha.x, alpha.y);
      await page.waitForTimeout(DEFAULT_LONG_PRESS_MS + 110);
      await touch(cdp, 'touchMove', alpha.x, alpha.y + 40);
      await page.waitForTimeout(16);
      await touch(cdp, 'touchCancel', alpha.x, alpha.y + 40);
    },
  ],
] as const) {
  mobileDndTest(`${name} leaves the shell unsuspended`, async ({ page, cdp }) => {
    await hostSetContent(page, 'alpha\n\nbravo\n\ncharlie');
    await clearMessages(page);

    await run(page, cdp, await blockCenter(page, 'alpha'));
    await settleChangeDebounce(page);

    expect((await messagesOfType(page, 'blockPress')).map((m) => m.pressed)).toEqual([true, false]);
    /* And the drag half stays balanced too, whether or not it fired at all. */
    const drags = (await messagesOfType(page, 'blockDrag')).map((m) => m.active);
    expect(drags.filter((a) => a === true)).toHaveLength(drags.length / 2);
    expect(drags[drags.length - 1] ?? false).toBe(false);
  });
}

// A tester reported holding an empty line lifting it as a blank "phantom"
// card AND raising the keyboard, the two visibly colliding. Product decision:
// an empty paragraph is not liftable at all (module doc's "an empty
// paragraph cannot be lifted"). 'alpha\n\n\nbravo' has two blank lines
// between alpha and bravo, which load as one empty paragraph
// (docs/spec/editor.md's "N blank lines load as N-1 empty paragraphs").
mobileDndTest(
  'an empty paragraph cannot be lifted, but a real block right next to it still can',
  async ({ page, cdp }) => {
    await hostSetContent(page, 'alpha\n\n\nbravo');
    expect(await page.evaluate(() => document.querySelectorAll('.ProseMirror > *').length)).toBe(3);
    await clearMessages(page);

    // Installed BEFORE the press: a ghost created and removed again before an
    // after-the-fact query ran would otherwise look identical to no ghost.
    await page.evaluate(() => {
      (window as unknown as { __ghostSeen?: boolean }).__ghostSeen = false;
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of Array.from(mutation.addedNodes)) {
            if (node instanceof HTMLElement && node.classList.contains('futo-mobile-dnd-ghost')) {
              (window as unknown as { __ghostSeen?: boolean }).__ghostSeen = true;
            }
          }
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });

    const emptyBox = await page.locator('.ProseMirror > *').nth(1).boundingBox();
    if (!emptyBox) throw new Error('no geometry for the empty paragraph');
    const empty = { x: emptyBox.x + emptyBox.width / 2, y: emptyBox.y + emptyBox.height / 2 };

    await touch(cdp, 'touchStart', empty.x, empty.y);
    await page.waitForTimeout(DEFAULT_LONG_PRESS_MS + 150);
    await touch(cdp, 'touchEnd', empty.x, empty.y);
    await settleChangeDebounce(page);

    expect(
      await page.evaluate(() => (window as unknown as { __ghostSeen?: boolean }).__ghostSeen),
    ).toBe(false);
    expect(await messagesOfType(page, 'haptic')).toHaveLength(0);
    expect(await messagesOfType(page, 'blockDrag')).toHaveLength(0);
    // Still armed like any other block press — that's what stands the
    // platform's own long-press gestures down — just never liftable.
    expect((await messagesOfType(page, 'blockPress')).map((m) => m.pressed)).toEqual([true, false]);
    expect(await getContent(page)).toBe('alpha\n\n\nbravo');
    // The release's native click must not leave the editor focused: a focused
    // editor makes the next press below a text-selection gesture that never
    // arms, so the `haptic` wait timed out under load (RC-84: the one-frame
    // release guard had expired before the click's focus arrived).
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);

    // A real block right next to it is unaffected.
    await clearMessages(page);
    const alpha = await blockCenter(page, 'alpha');
    await touch(cdp, 'touchStart', alpha.x, alpha.y);
    // A fixed sleep then a single, non-retrying snapshot of the message list
    // raced the long-press timer under CI load (this exact assertion failed
    // once, on the runner's most contended sampled run — pipeline 36709 also
    // failed 3 OTHER unrelated tests that same run). Wait for the haptic
    // message to actually arrive instead of assuming it has by a fixed
    // deadline.
    const [haptic] = await waitForMessages(page, 'haptic');
    expect(haptic.kind).toBe('lift');
    await touch(cdp, 'touchEnd', alpha.x, alpha.y);
  },
);

// R10-FB20-1: the release focus guard exists to absorb the native click's focus
// and must never swallow the HOST's own focus() (quick-capture open, returning
// to a note): a host focus is intentional. Checked inside the guard's 1 s window.
mobileDndTest(
  'a host focus() right after a lifted drop focuses the editor',
  async ({ page, cdp }) => {
    await hostSetContent(page, 'alpha\n\nbravo\n\ncharlie');
    await clearMessages(page);
    const alpha = await blockCenter(page, 'alpha');
    const charlie = await blockCenter(page, 'charlie');
    await longPressDrag(page, cdp, alpha, { x: charlie.x, y: charlie.y + 4 });
    await page.waitForTimeout(100);

    await focusEditor(page);
    await flushFrames(page);
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
    await page.waitForTimeout(300); // and it stays focused
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
  },
);

mobileDndTest(
  'a host focus() right after an empty-paragraph release focuses the editor',
  async ({ page, cdp }) => {
    await hostSetContent(page, 'alpha\n\n\nbravo');
    await clearMessages(page);
    const emptyBox = await page.locator('.ProseMirror > *').nth(1).boundingBox();
    if (!emptyBox) throw new Error('no geometry for the empty paragraph');
    const empty = { x: emptyBox.x + emptyBox.width / 2, y: emptyBox.y + emptyBox.height / 2 };
    await touch(cdp, 'touchStart', empty.x, empty.y);
    await page.waitForTimeout(DEFAULT_LONG_PRESS_MS + 150);
    await touch(cdp, 'touchEnd', empty.x, empty.y);
    await page.waitForTimeout(100);

    await focusEditor(page);
    await flushFrames(page);
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
  },
);

// The other half of the same tester report: on Android, Chromium's own
// long-press forces focus onto the editable regardless of the page canceling
// selectstart/contextmenu/touchend (module doc's "a block press must never
// focus the editor"). Playwright's desktop Chromium does not reproduce that
// forced focus itself, so these simulate it mid-press with a direct .focus()
// call and assert the plugin undoes (or leaves alone) exactly as documented.
mobileDndTest(
  'a block press that began unfocused never focuses the editor or raises the keyboard',
  async ({ page, cdp }) => {
    await hostSetContent(page, 'alpha\n\nbravo\n\ncharlie');
    await page.evaluate(() => (window as unknown as FakeHostWindow).FutoEditor.blur());
    await flushFrames(page);
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
    await clearMessages(page);

    const alpha = await blockCenter(page, 'alpha');
    await touch(cdp, 'touchStart', alpha.x, alpha.y);
    await page.waitForTimeout(DEFAULT_LONG_PRESS_MS + 150);
    // Stands in for Chromium's own long-press focus (module doc: measured on
    // the pool emulator, not reproducible in Playwright's Chromium). Goes
    // through the SAME entry point a host's own focus() call would (the known,
    // accepted cost the module doc names), and sidesteps the ghost card
    // that lifting this real block also stamps with the `ProseMirror` class.
    await focusEditor(page);
    await flushFrames(page);
    await touch(cdp, 'touchEnd', alpha.x, alpha.y);
    await settleChangeDebounce(page);

    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
    expect((await messagesOfType(page, 'focus')).some((m) => m.focused === true)).toBe(false);
  },
);

mobileDndTest('a block press that began focused leaves focus alone', async ({ page, cdp }) => {
  await hostSetContent(page, 'alpha\n\nbravo\n\ncharlie');
  await focusEditor(page);
  await clearMessages(page);

  const alpha = await blockCenter(page, 'alpha');
  await touch(cdp, 'touchStart', alpha.x, alpha.y);
  await page.waitForTimeout(DEFAULT_LONG_PRESS_MS + 150);
  await focusEditor(page);
  await flushFrames(page);
  await touch(cdp, 'touchEnd', alpha.x, alpha.y);
  await settleChangeDebounce(page);

  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
});

// QA #001 (Zvonimir): block drag made text unselectable on Android because
// every long-press was read as "lift this block", focused or not. Focus now
// arbitrates the whole gesture (mobileBlockDnd.ts's "FOCUS ARBITRATES DRAG VS.
// SELECTION"): a press that begins focused must not arm a SINGLE lever of the
// drag machinery, so a long, stationary hold produces no lift, no ghost, and
// no press/drag suspension message — leaving the platform's own long-press
// text selection completely alone.
mobileDndTest(
  'a block press that began focused never arms the drag — no lift, no ghost, no suspension',
  async ({ page, cdp }) => {
    await hostSetContent(page, 'alpha\n\nbravo\n\ncharlie');
    await focusEditor(page);
    await clearMessages(page);

    const alpha = await blockCenter(page, 'alpha');
    await touch(cdp, 'touchStart', alpha.x, alpha.y);
    await page.waitForTimeout(DEFAULT_LONG_PRESS_MS + 150);
    await touch(cdp, 'touchEnd', alpha.x, alpha.y);
    await settleChangeDebounce(page);

    expect(await messagesOfType(page, 'haptic')).toHaveLength(0);
    expect(await messagesOfType(page, 'blockDrag')).toHaveLength(0);
    expect(await messagesOfType(page, 'blockPress')).toHaveLength(0);
    expect(
      await page.evaluate(() => document.querySelector('.futo-mobile-dnd-ghost') !== null),
    ).toBe(false);
    expect(await getContent(page)).toBe('alpha\n\nbravo\n\ncharlie');
  },
);

// A dropped block must land as a SIBLING at the top level, never be absorbed
// into whatever container it was released over — the failure this path's
// custom target resolution exists to prevent (a heading dropped onto a
// blockquote used to become part of the quote's text).
mobileDndTest(
  'a block dropped over a blockquote lands beside it, not inside',
  async ({ page, cdp }) => {
    await hostSetContent(page, '# heading\n\n> quoted line\n\ntail');
    await clearMessages(page);

    const heading = await blockCenter(page, 'heading');
    const quote = await blockCenter(page, 'quoted line');
    await longPressDrag(page, cdp, heading, { x: quote.x, y: quote.y + 2 });

    const changes = await waitForMessages(page, 'change');
    const content = changes[changes.length - 1].content as string;
    expect(content).toContain('# heading');
    expect(content.indexOf('> quoted line')).toBeLessThan(content.indexOf('# heading'));
  },
);

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
