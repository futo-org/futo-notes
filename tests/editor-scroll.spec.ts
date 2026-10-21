import { expect, test } from '@playwright/test';

import { EDITOR, openNewNote, setEditorMarkdown } from './lib/desktopEditor';

/**
 * A long note has to scroll on the desktop shell.
 *
 * The desktop shell and the native editor embed use DIFFERENT scroll models
 * with the same stylesheet. In `editor.html` the page is pinned to the web view
 * and `.ProseMirror` is given a definite height, so the editable IS the
 * scroller (docs/spec/editor.md → "The editable element is the editor's own
 * scroll container"). In the desktop shell `.note-body` is the scroller — the
 * note title and tag bar scroll away with the text — and nothing in the height
 * chain above `.ProseMirror` is definite, so the editable grows to its full
 * content height and never scrolls.
 *
 * That left `.ProseMirror` a scroll container with nothing to scroll, covering
 * the whole note. `overscroll-behavior: contain` then stopped the wheel from
 * chaining out to `.note-body`, so a wheel anywhere over the text moved
 * nothing at all.
 *
 * The assertion is deliberately about what the reader sees — the first line
 * moving up the screen — not about which element carries `scrollTop`, so it
 * stays honest whichever element ends up owning the scroll.
 */

/** Long enough to overflow any plausible window, with a findable first line. */
const LONG_NOTE = [
  'FIRST LINE',
  ...Array.from(
    { length: 120 },
    (_, i) => `Paragraph ${i + 1} of a note that is much taller than the window.`,
  ),
].join('\n\n');

test.describe('long-note scrolling (desktop shell)', () => {
  test('a wheel over the note text scrolls the note', async ({ page }) => {
    await openNewNote(page);
    await setEditorMarkdown(page, LONG_NOTE);

    const firstLine = page.locator(EDITOR).locator('p', { hasText: 'FIRST LINE' }).first();
    await expect(firstLine).toBeVisible();
    // The note is appended in chunks over idle time (progressiveLoad.ts), so
    // wait until the whole thing is in the document — a wheel that arrives
    // while the note is still one screen tall has nothing to scroll, and would
    // pass this spec for the wrong reason.
    await expect(page.locator(EDITOR).locator('p', { hasText: 'Paragraph 120 of' })).toHaveCount(1);

    const before = await firstLine.boundingBox();
    expect(before).not.toBeNull();

    // Wheel over the middle of the note text, where a reader would scroll.
    const editorBox = await page.locator(EDITOR).boundingBox();
    expect(editorBox).not.toBeNull();
    await page.mouse.move(editorBox!.x + editorBox!.width / 2, 300);
    await page.mouse.wheel(0, 600);

    // The scroll is asynchronous; wait for the line to actually move rather
    // than sampling one frame later (AGENTS.md M15 — wait on the condition).
    await expect
      .poll(async () => (await firstLine.boundingBox())?.y ?? before!.y, { timeout: 5000 })
      .toBeLessThan(before!.y - 100);
  });

  test('the note can be scrolled to its end', async ({ page }) => {
    await openNewNote(page);
    await setEditorMarkdown(page, LONG_NOTE);

    const lastLine = page.locator(EDITOR).locator('p', { hasText: 'Paragraph 120 of' }).first();
    const editorBox = await page.locator(EDITOR).boundingBox();
    expect(editorBox).not.toBeNull();
    await page.mouse.move(editorBox!.x + editorBox!.width / 2, 300);

    for (let i = 0; i < 40; i += 1) await page.mouse.wheel(0, 600);

    await expect(lastLine).toBeInViewport({ timeout: 5000 });
  });
});

test.describe('block drag edge auto-scroll (desktop shell)', () => {
  // Issue #270: the auto-scroll zone was measured against `.ProseMirror`, which
  // on desktop is a plain box as tall as the note inside `.note-body`, so its
  // bottom edge was far below the window and holding a dragged block at the
  // window's bottom edge never scrolled the note.
  test('holding a dragged block at the bottom of the window scrolls the note', async ({ page }) => {
    await openNewNote(page);
    await setEditorMarkdown(page, LONG_NOTE);
    const firstLine = page.locator(EDITOR).locator('p', { hasText: 'FIRST LINE' }).first();
    await expect(page.locator(EDITOR).locator('p', { hasText: 'Paragraph 120 of' })).toHaveCount(1);

    const line = (await firstLine.boundingBox())!;
    await page.mouse.move(line.x + line.width / 2, line.y + line.height / 2);
    const handle = page.locator('.milkdown-block-handle[data-show="true"]');
    await handle.waitFor({ state: 'attached' });
    const grip = (await handle.boundingBox())!;

    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    const viewport = page.viewportSize()!;
    // Into the bottom edge zone, then hold still: no further events arrive,
    // so only the loop can scroll.
    await page.mouse.move(line.x + line.width / 2, viewport.height - 8, { steps: 8 });

    await expect
      .poll(async () => (await firstLine.boundingBox())?.y ?? line.y, { timeout: 5000 })
      .toBeLessThan(line.y - 300);

    await page.keyboard.press('Escape');
    await page.mouse.up();
  });
});
