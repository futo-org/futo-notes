import { expect, test as base, type CDPSession, type Page } from '@playwright/test';

import { DEFAULT_LONG_PRESS_MS } from '../src/features/editor/milkdown/mobileBlockDnd';
import { EDITOR_URL } from './editorEmbedBundle';
import {
  clearMessages,
  flushFrames,
  focusEditor,
  getContent,
  installFakeAndroidHost,
  messagesOfType,
  waitForMessages,
  type FakeHostWindow,
} from './lib/editorEmbedHost';

/**
 * futoBridge contract, Milkdown engine — executable.
 *
 * A bare `editor.html` mounts the Milkdown (ProseMirror) WYSIWYG editor while
 * the transition is in flight (docs/plan/milkdown-transition.md); `?cm` selects
 * the shipping CodeMirror editor, whose own contract lives in
 * `editor-embed-bridge.spec.ts`.
 *
 * SCOPE: the ENGINE-INDEPENDENT half of the bridge contract plus the two
 * invariants that are specific to a normalizing editor, both of them data
 * safety:
 *
 *   1. Opening a note NEVER rewrites it (ADR-0002's load-echo guard) — even
 *      markdown whose serialization Milkdown would normalize comes back
 *      byte-identical until the user actually edits.
 *   2. Undo can never reach across a host note switch — the host calls
 *      `resetHistory()` on every open, and a Milkdown undo stack that survived
 *      it would write the PREVIOUS note's text into the current note's file.
 *
 * Plus the two surfaces the Milkdown work added to the bridge: `formatState`
 * (native toolbar highlighting) and `haptic` (the iOS long-press block drag).
 *
 * NOT here, deliberately: toolbar command parity (#104), wikilinks (#101),
 * images (#103), tags/checkboxes/fences (#102). Those are open parity tickets
 * with their own acceptance criteria — the transition plan's §4 bucket 1 — and
 * writing failing assertions for them here would just be a second copy of the
 * backlog.
 *
 * Real user input only: Playwright keyboard/mouse, and CDP `Input.dispatch-
 * TouchEvent` for the long-press drag (a genuine browser touch stream, not DOM
 * `dispatchEvent` — AGENTS.md M21).
 */

/** @milkdown/plugin-listener debounces `markdownUpdated` by 200 ms (trailing). */
const CHANGE_DEBOUNCE_MS = 200;

/**
 * Bounded wait for "no message arrives". Asserting an ABSENCE needs a window,
 * and the only honest one is the debounce the editor actually runs on.
 */
async function settleChangeDebounce(page: Page): Promise<void> {
  await page.waitForTimeout(CHANGE_DEBOUNCE_MS + 80);
  await flushFrames(page);
}

const test = base.extend<{ page: Page }>({
  page: async ({ browser }, use) => {
    const context = await browser.newContext({ hasTouch: true });
    await context.addInitScript(installFakeAndroidHost);
    const page = await context.newPage();
    await page.goto(EDITOR_URL);
    await page.waitForFunction(() =>
      (window as unknown as FakeHostWindow).__msgs?.some((m) => m.type === 'ready'),
    );
    await use(page);
    await context.close();
  },
});

function hostConfig(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    bridgeVersion: 7,
    theme: 'light',
    content: '',
    nativeToolbar: true,
    contentPaddingInlinePx: 14,
    ...overrides,
  });
}

async function initialize(page: Page, configJson: string): Promise<void> {
  await page.evaluate(
    (json) => (window as unknown as FakeHostWindow).FutoEditor.initialize(json),
    configJson,
  );
  await flushFrames(page);
}

async function hostSetContent(page: Page, markdown: string): Promise<void> {
  await page.evaluate(
    (md) => (window as unknown as FakeHostWindow).FutoEditor.setContent(md),
    markdown,
  );
  await settleChangeDebounce(page);
}

// ============================================================
// Handshake and boot
// ============================================================

test('posts ready exactly once with bridge version 7', async ({ page }) => {
  const ready = await messagesOfType(page, 'ready');
  expect(ready).toHaveLength(1);
  expect(ready[0].version).toBe(7);
});

test('one initialize applies the host config and reports initialized', async ({ page }) => {
  await clearMessages(page);

  await initialize(page, hostConfig({ theme: 'dark', content: '# booted' }));

  expect(await getContent(page)).toBe('# booted');
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
  expect(await messagesOfType(page, 'initialized')).toEqual([{ type: 'initialized', version: 7 }]);
});

test('re-initializing restores the open note (the renderer-death path)', async ({ page }) => {
  await initialize(page, hostConfig({ content: 'the open note' }));
  await hostSetContent(page, 'something else');
  await clearMessages(page);

  await initialize(page, hostConfig({ content: 'the open note' }));

  expect(await getContent(page)).toBe('the open note');
  expect(await messagesOfType(page, 'initialized')).toHaveLength(1);
});

// ============================================================
// Content in and out — the load-echo guard (ADR-0002)
// ============================================================

test('setContent then getContent round-trips the document', async ({ page }) => {
  await hostSetContent(page, 'Hello world');
  expect(await getContent(page)).toBe('Hello world');
});

test('a host-initiated setContent posts no change', async ({ page }) => {
  await clearMessages(page);
  await hostSetContent(page, 'Set by the host');
  expect(await messagesOfType(page, 'change')).toHaveLength(0);
});

// The whole point of ADR-0002's load-echo guard: Milkdown's serializer
// normalizes markdown (list markers, emphasis delimiters, escapes, trailing
// newline), so merely OPENING one of these notes must not report a change and
// must not hand the host different bytes than it gave us.
const NORMALIZED_BY_MILKDOWN = [
  ['a bullet marker Milkdown would rewrite', '* first\n* second'],
  ['emphasis delimiters Milkdown would rewrite', 'some *emphasis* here'],
  ['a note with no trailing newline', 'no trailing newline'],
  ['setext heading syntax', 'Title\n=====\n\nbody'],
  ['an indented ordered list', '1. one\n2. two'],
] as const;

for (const [label, markdown] of NORMALIZED_BY_MILKDOWN) {
  test(`opening ${label} returns the host's own bytes and posts no change`, async ({ page }) => {
    await clearMessages(page);
    await hostSetContent(page, markdown);

    expect(await getContent(page)).toBe(markdown);
    expect(await messagesOfType(page, 'change')).toHaveLength(0);
  });
}

// Normalize-once (ADR-0002 decision 4a): the FIRST real edit hands the host
// Milkdown's serialization, which — unlike the load echo above — is allowed to
// differ from the bytes on disk. The trailing newline is that normalization
// showing up in its smallest form; asserting it is how a future serializer
// change announces itself instead of quietly rewriting every note.
test('a real keystroke posts exactly one change carrying the normalized document', async ({
  page,
}) => {
  await hostSetContent(page, 'Hello world');
  await clearMessages(page);

  await focusEditor(page);
  await page.keyboard.press('End');
  await page.keyboard.type('X');

  const changes = await waitForMessages(page, 'change');
  expect(changes).toHaveLength(1);
  expect(changes[0].content).toBe('Hello worldX\n');
});

test('applyExternalContent adopts differing content without a change echo', async ({ page }) => {
  await hostSetContent(page, 'original');
  await clearMessages(page);

  await page.evaluate(() =>
    (window as unknown as FakeHostWindow).FutoEditor.applyExternalContent('adopted from a peer'),
  );
  await settleChangeDebounce(page);

  expect(await getContent(page)).toBe('adopted from a peer');
  expect(await messagesOfType(page, 'change')).toHaveLength(0);
});

/**
 * Clicks the caret `chars` characters into the first paragraph. The point comes
 * from a DOM Range over the text node — the paragraph's own box is the full
 * content column, so dividing its width by the character count aims far past
 * the end of a short line.
 */
async function clickCaretInto(page: Page, chars: number): Promise<void> {
  const point = await page.evaluate((offset) => {
    const text = document.querySelector('.ProseMirror > p')?.firstChild;
    if (!text) throw new Error('no paragraph text node');
    const range = document.createRange();
    range.setStart(text, offset);
    range.setEnd(text, offset);
    const rect = range.getBoundingClientRect();
    return { x: rect.left, y: rect.top + rect.height / 2 };
  }, chars);
  await page.mouse.click(point.x, point.y);
}

test('applyExternalContent with unchanged content preserves the selection', async ({ page }) => {
  await hostSetContent(page, 'abcdef');
  await focusEditor(page);
  await clickCaretInto(page, 3);
  await clearMessages(page);

  // No-op adopt (content identical): must not reset the caret to 0 or the end.
  await page.evaluate(() =>
    (window as unknown as FakeHostWindow).FutoEditor.applyExternalContent('abcdef'),
  );
  await flushFrames(page);
  await page.keyboard.type('Z');

  await waitForMessages(page, 'change');
  expect(await getContent(page)).toBe('abcZdef\n');
});

// ============================================================
// Undo history — must never cross a note boundary
// ============================================================

test('the note the boot config carries is not something undo can erase', async ({ page }) => {
  await initialize(page, hostConfig({ content: 'the note body' }));
  await focusEditor(page);
  await page.keyboard.press('ControlOrMeta+z');
  await settleChangeDebounce(page);

  expect(await getContent(page)).toBe('the note body');
  expect(await messagesOfType(page, 'change')).toHaveLength(0);
});

test('a host note switch clears undo even when the next note has identical text', async ({
  page,
}) => {
  await hostSetContent(page, 'draft');
  await focusEditor(page);
  await page.keyboard.press('End');
  await page.keyboard.type(' X');
  await waitForMessages(page, 'change');
  // Edited, so getContent now reports the serialization (normalize-once).
  expect(await getContent(page)).toBe('draft X\n');

  await hostSetContent(page, 'draft X');
  await focusEditor(page);
  await page.keyboard.press('ControlOrMeta+z');
  await settleChangeDebounce(page);

  expect(await getContent(page)).toBe('draft X');
});

test('undo inside one note still works', async ({ page }) => {
  await hostSetContent(page, 'keep');
  await focusEditor(page);
  await page.keyboard.press('End');
  await page.keyboard.type(' typed');
  await waitForMessages(page, 'change');

  await page.keyboard.press('ControlOrMeta+z');
  await settleChangeDebounce(page);

  expect(await getContent(page)).toBe('keep\n');
});

// ============================================================
// Focus and link routing
// ============================================================

test('focus() posts focus:true and blur() posts focus:false', async ({ page }) => {
  await clearMessages(page);
  await focusEditor(page);
  await page.evaluate(() => (window as unknown as FakeHostWindow).FutoEditor.blur());
  await flushFrames(page);

  const focusMessages = await messagesOfType(page, 'focus');
  expect(focusMessages.map((m) => m.focused)).toEqual([true, false]);
});

test('tapping an external link posts openUrl and never calls window.open', async ({ page }) => {
  await hostSetContent(page, '[docs](https://example.com/docs)');
  await clearMessages(page);

  await page.locator('a').first().click();
  await flushFrames(page);

  expect(await messagesOfType(page, 'openUrl')).toEqual([
    { type: 'openUrl', url: 'https://example.com/docs' },
  ]);
  expect(await page.evaluate(() => (window as unknown as FakeHostWindow).__openCalls)).toEqual([]);
});

// ============================================================
// formatState — the native toolbar's active-state highlight
// ============================================================

test('formatState reports the block kind at the caret, deduped', async ({ page }) => {
  // A load leaves the caret at the end of the document — inside the heading.
  await hostSetContent(page, 'plain paragraph\n\n## a heading');
  await focusEditor(page);
  expect((await messagesOfType(page, 'formatState')).at(-1)?.active).toEqual(['heading']);
  await clearMessages(page);

  // Into the paragraph: the heading is no longer active.
  await clickCaretInto(page, 3);
  await flushFrames(page);
  expect((await messagesOfType(page, 'formatState')).at(-1)?.active).toEqual([]);

  // Moving WITHIN the paragraph changes nothing, so nothing new is posted.
  const seen = (await messagesOfType(page, 'formatState')).length;
  await page.keyboard.press('ArrowRight');
  await flushFrames(page);
  expect(await messagesOfType(page, 'formatState')).toHaveLength(seen);
});

test('formatState reports bold for a caret inside bold text', async ({ page }) => {
  await hostSetContent(page, 'aaa **bold** zzz');
  await focusEditor(page);
  await clearMessages(page);

  // Click into the middle of the bold run.
  const strong = page.locator('.ProseMirror strong').first();
  const box = await strong.boundingBox();
  if (!box) throw new Error('no <strong> geometry');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await flushFrames(page);

  expect((await messagesOfType(page, 'formatState')).at(-1)?.active).toEqual(['bold']);
});

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
  type: 'touchStart' | 'touchMove' | 'touchEnd',
  x: number,
  y: number,
): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }],
  });
}

async function blockCenter(page: Page, text: string): Promise<{ x: number; y: number }> {
  const box = await page.locator('.ProseMirror > *', { hasText: text }).first().boundingBox();
  if (!box) throw new Error(`no geometry for the block containing "${text}"`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
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
// The ⠿ gutter handle's touch drag (desktop browser + Android)
// ============================================================

// The other drag path. It shares `blockDragGeometry.ts` and `blockMove.ts`
// with the long-press one, and this is the case that proves the sharing: the
// handle path used to trust positions captured at pointerdown and insert a
// re-fitted slice, so a heading dropped where it did not fit was silently
// unwrapped into the surrounding paragraph.
test('a touch drag on the ⠿ handle reorders the block', async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  await hostSetContent(page, '# alpha\n\nbravo\n\ncharlie');
  await clearMessages(page);

  // No hover on touch: a tap is what surfaces the handle for a block.
  const alpha = await blockCenter(page, 'alpha');
  await page.touchscreen.tap(alpha.x, alpha.y);
  const handle = page.locator('.milkdown-block-handle[data-show="true"]');
  await handle.waitFor({ state: 'attached' });
  const handleBox = await handle.boundingBox();
  if (!handleBox) throw new Error('no handle geometry');

  const charlie = await blockCenter(page, 'charlie');
  const from = { x: handleBox.x + handleBox.width / 2, y: handleBox.y + handleBox.height / 2 };
  await touch(cdp, 'touchStart', from.x, from.y);
  for (let step = 1; step <= 4; step += 1) {
    await touch(
      cdp,
      'touchMove',
      from.x + ((charlie.x - from.x) * step) / 4,
      from.y + ((charlie.y + 4 - from.y) * step) / 4,
    );
    await page.waitForTimeout(16);
  }
  await touch(cdp, 'touchEnd', charlie.x, charlie.y + 4);

  const changes = await waitForMessages(page, 'change');
  const content = changes[changes.length - 1].content as string;
  // Still a heading, and now last.
  expect(content).toBe('bravo\n\ncharlie\n\n# alpha\n');
  await cdp.detach();
});

// The long-press path is gated to the native iOS shell; `?forceMobileDnd` is
// the test-only way in (headless Chromium can never be sniffed as iOS).
const mobileDndTest = base.extend<{ page: Page; cdp: CDPSession }>({
  page: async ({ browser }, use) => {
    const context = await browser.newContext({ hasTouch: true });
    await context.addInitScript(installFakeAndroidHost);
    const page = await context.newPage();
    await page.goto(`${EDITOR_URL}?forceMobileDnd`);
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

mobileDndTest(
  'a long-press drag reorders the block and posts lift then drop haptics',
  async ({ page, cdp }) => {
    await hostSetContent(page, 'alpha\n\nbravo\n\ncharlie');
    await clearMessages(page);

    // Released in the LOWER half of "charlie", which resolves to the boundary
    // AFTER it (resolveTopLevelTarget picks by which half of the block's rect
    // the release point falls in).
    const charlie = await blockCenter(page, 'charlie');
    await longPressDrag(page, cdp, await blockCenter(page, 'alpha'), {
      x: charlie.x,
      y: charlie.y + 4,
    });

    const changes = await waitForMessages(page, 'change');
    expect(changes[changes.length - 1].content).toBe('bravo\n\ncharlie\n\nalpha\n');
    expect((await messagesOfType(page, 'haptic')).map((m) => m.kind)).toEqual(['lift', 'drop']);
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

    expect(await messagesOfType(page, 'change')).toHaveLength(0);
    expect((await messagesOfType(page, 'haptic')).map((m) => m.kind)).toEqual(['lift']);
    expect(await getContent(page)).toBe('alpha\n\nbravo\n\ncharlie');
  },
);

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
  expect(await getContent(page)).toBe('alpha\n\nbravo\n\ncharlie');
});

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
