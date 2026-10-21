// Part of the futoBridge Milkdown suite: scope and input rules are in
// editor-embed-milkdown.spec.ts.

import { expect } from '@playwright/test';
import { DEFAULT_LONG_PRESS_MS } from '../src/features/editor/milkdown/mobileBlockDnd';
import {
  clearMessages,
  flushFrames,
  focusEditor,
  getContent,
  messagesOfType,
  waitForMessages,
  type FakeHostWindow,
} from './lib/editorEmbedHost';
import { settleChangeDebounce, hostSetContent } from './lib/editorEmbedMilkdown';
import { touch, blockCenter, longPressDrag, mobileDndTest } from './lib/editorEmbedMilkdownDrag';

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
