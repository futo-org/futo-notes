// Part of the futoBridge Milkdown suite: scope and input rules are in
// editor-embed-milkdown.spec.ts.

import { expect } from '@playwright/test';
import { GHOST_PAD_Y_PX } from '../src/features/editor/milkdown/blockDragSession';
import { clearMessages, getContent, messagesOfType, waitForMessages } from './lib/editorEmbedHost';
import { hostSetContent } from './lib/editorEmbedMilkdown';
import {
  blockBox,
  blockCenter,
  gutterHandleTest,
  startHandleDrag,
  surfaceHandle,
  domSelection,
  caretAtEndOf,
} from './lib/editorEmbedMilkdownDrag';

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
    // edges (a full-width block would hit it) cannot colour the size check.
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
