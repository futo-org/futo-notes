// Part of the futoBridge Milkdown suite: scope and input rules are in
// editor-embed-milkdown.spec.ts.

import { expect } from '@playwright/test';
import { clearMessages, waitForMessages } from './lib/editorEmbedHost';
import { hostSetContent } from './lib/editorEmbedMilkdown';
import {
  blockBox,
  gutterHandleTest,
  gutterHandleLineTest,
  reflowGap,
  startHandleDrag,
  dropIndicatorTop,
  surfaceHandle,
  listOnly,
  domSelection,
  caretAtEndOf,
} from './lib/editorEmbedMilkdownDrag';

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
 * The handle's mousedown is now cancelled before the plugin sees it (the drag is
 * pointer-driven), so the user's own selection is never touched, and is carried
 * along with the block when it was inside the one that moved. */

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
 * the line a block STARTS on — floating-ui centred it on the whole block, which
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
