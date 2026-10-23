// What a reflow drag draws and drops, measured: the layout probes and drop
// helpers shared by the editor-embed-milkdown drag-* specs.

import { expect, type CDPSession, type Page } from '@playwright/test';
import { DEFAULT_LONG_PRESS_MS } from '../../src/features/editor/milkdown/mobileBlockDnd';
import { flushFrames, messagesOfType, waitForMessages } from './editorEmbedHost';
import { touch, blockBox, startHandleDrag } from './editorEmbedMilkdownDrag';

/** Enough blocks to overflow the editor's own scroller several times over, and
 * numbered so the drop position is readable from the serialized note. Kept
 * under progressive open's 400-line threshold so this exercises the ordinary
 * whole-document load. */
export function scrollableNote(lines = 150): string {
  return Array.from({ length: lines }, (_, i) => `Line ${i}`).join('\n\n') + '\n';
}

/** `.ProseMirror` owns overflow-y here (MilkdownEditor.svelte), so it — not the
 * page — is the scroller edge auto-scroll drives. */
export function editorScroll(page: Page): Promise<{
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
export function dragLayout(
  page: Page,
  curtain: boolean,
): Promise<{ scrollTop: number; source: string | null; blocks: Record<string, LaidOutBlock> }> {
  return page.evaluate((fromCurtain) => {
    const editor = document.querySelector('.ProseMirror[contenteditable]') as HTMLElement;
    const root = fromCurtain
      ? (document.querySelector('.futo-mobile-dnd-reflow-curtain') as HTMLElement | null)
      : editor;
    const view = editor.getBoundingClientRect();
    // Not the first <img>: prosemirror-view 1.42.6+ puts an invisible
    // img.ProseMirror-separator in front of an inline image that starts a block.
    const keyOf = (el: Element) =>
      (el.textContent ?? '').replace(/\s+/g, ' ').trim() ||
      el.querySelector('img:not(.ProseMirror-separator)')?.getAttribute('alt') ||
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
      const drawn =
        block.querySelector('img:not(.ProseMirror-separator), hr')?.getBoundingClientRect() ?? box;
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
export async function expectDropMatchesPreview(page: Page, release: () => Promise<void>) {
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

/** The box of the top-level block at `index`. */
export async function blockBoxAt(
  page: Page,
  index: number,
): Promise<{ x: number; left: number; top: number; bottom: number }> {
  const box = await page.locator('.ProseMirror[contenteditable] > *').nth(index).boundingBox();
  if (!box) throw new Error(`no geometry for top-level block ${index}`);
  return { x: box.x + box.width / 2, left: box.x, top: box.y, bottom: box.y + box.height };
}

/** A lifted block, whichever gesture lifted it. */
export interface LiftedBlock {
  x: number;
  move(y: number): Promise<void>;
  release(): Promise<void>;
}

/** Lifts top-level block `index` off its ⠿ handle (desktop). */
export async function liftWithHandle(page: Page, index: number): Promise<LiftedBlock> {
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
export async function liftWithTouch(
  page: Page,
  cdp: CDPSession,
  index: number,
): Promise<LiftedBlock> {
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

/** A 200px-tall image, served for any vault filename once the base URL below
 * is registered — only then, so it can load in the middle of a drag. */
export const LATE_IMAGE_BASE = 'https://vault.futo-notes.test/';
export const LATE_IMAGE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#c84"/></svg>';

/** Runs the page's animations at `rate` (0 stops them). */
export async function animationRate(cdp: CDPSession, rate: number): Promise<void> {
  await cdp.send('Animation.enable');
  await cdp.send('Animation.setPlaybackRate', { playbackRate: rate });
}

/** Lifts alpha (by long press, or by its ⠿ handle with `handle`) and moves it
 * past charlie and delta, then catches the slide part-way: runs it at 5% speed
 * for a beat, then stops the clock. */
export async function liftAndStopMidSlide(
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

export const SLIDE_NOTE =
  'alpha\n\nbravo\n\ncharlie\n\ndelta\n\n![late image](late.svg)\n\necho\n\nfoxtrot';

/** The text of every block of the real note, in order. */
export function realOrder(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('.ProseMirror[contenteditable] > *')].map(
      (el) =>
        (el.textContent ?? '').trim() ||
        el.querySelector('img:not(.ProseMirror-separator)')?.alt ||
        el.tagName,
    ),
  );
}
