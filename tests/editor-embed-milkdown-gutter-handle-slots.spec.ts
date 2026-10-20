// Part of the futoBridge Milkdown suite: scope and input rules are in
// editor-embed-milkdown.spec.ts.

import { expect } from '@playwright/test';
import { clearMessages, messagesOfType, waitForMessages } from './lib/editorEmbedHost';
import { hostSetContent } from './lib/editorEmbedMilkdown';
import {
  blockBox,
  gutterHandleTest,
  gutterHandleLineTest,
  reflowGap,
  drawnBox,
  startHandleDrag,
  dropIndicatorTop,
  surfaceHandle,
} from './lib/editorEmbedMilkdownDrag';

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
