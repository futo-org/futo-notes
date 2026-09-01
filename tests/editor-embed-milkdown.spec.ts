import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

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
  openEmbed,
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
 * Plus images (#103): vault-relative rendering and clipboard paste, which one
 * bundle settles for all three shells.
 *
 * NOT here, deliberately: toolbar command parity (#104). That is an open parity
 * ticket with its own acceptance criteria — the transition plan's §4 bucket 1 —
 * and writing failing assertions for it here would just be a second copy of the
 * backlog. Wikilinks (#101) and tags/task checkboxes/fence highlighting (#102)
 * have landed and have their own files,
 * `editor-embed-milkdown-wikilinks.spec.ts` and
 * `editor-embed-milkdown-parity.spec.ts`.
 *
 * Real user input only: Playwright keyboard/mouse, and CDP `Input.dispatch-
 * TouchEvent` for the long-press drag (a genuine browser touch stream, not DOM
 * `dispatchEvent` — AGENTS.md M21).
 *
 * The ONE exception is clipboard image paste, and it is a limit of the tool, not
 * a shortcut: nothing in Playwright or CDP can put an image on the OS clipboard,
 * so `Ctrl+V` has nothing to paste. A dispatched `ClipboardEvent` carrying a
 * real `DataTransfer` is as close to the real thing as this harness reaches, and
 * it still goes through ProseMirror's own paste handling rather than calling the
 * editor's handler directly. The CodeMirror suite has the same limit for the
 * same reason. What it therefore cannot prove is that a given WebView exposes
 * the bitmap on the event at all — that is what the `pasteClipboardImage`
 * fallback exists for, and it is a device check.
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

/**
 * Records whether the progressive-open affordance ever appeared, for the whole
 * life of the page. Installed as an init script rather than armed per test:
 * how long a tail takes to stream is a property of the machine, so polling for
 * it would be asserting that this box is slow, and a test that has to remember
 * to arm its own watch is a test that will one day forget.
 */
function installStreamingTailWatch(): void {
  const w = window as unknown as { __tail: { seen: boolean; role: string | null } };
  w.__tail = { seen: false, role: null };
  new MutationObserver(() => {
    const el = document.querySelector('.milkdown-stream-tail');
    if (!el) return;
    w.__tail.seen = true;
    w.__tail.role = el.getAttribute('role');
    // `document`, not `document.documentElement`: an init script runs before
    // the latter exists, and a MutationObserver takes the Document itself.
  }).observe(document, { childList: true, subtree: true });
}

function readTailWatch(page: Page): Promise<{ seen: boolean; role: string | null }> {
  return page.evaluate(
    () => (window as unknown as { __tail: { seen: boolean; role: string | null } }).__tail,
  );
}

const test = base.extend<{ page: Page }>({
  page: async ({ browser }, use) => {
    const context = await browser.newContext({ hasTouch: true });
    await context.addInitScript(installFakeAndroidHost);
    await context.addInitScript(installStreamingTailWatch);
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
// An EMPTY note is the case the guard above can miss: `setContent('')` matches
// the initial `liveMarkdown`, so the load never runs through `applyExternal`
// and never records a serialization to compare against. If `getContent()` then
// answers with Milkdown's own serialization of an empty document, opening a
// brand-new note and leaving it rewrites the file.
test('opening an empty note returns empty and posts no change', async ({ page }) => {
  await clearMessages(page);
  await hostSetContent(page, '');

  expect(await getContent(page)).toBe('');
  expect(await messagesOfType(page, 'change')).toHaveLength(0);
});

test('an empty note carried by the boot config stays empty', async ({ page }) => {
  await clearMessages(page);
  await initialize(page, hostConfig({ content: '' }));
  await settleChangeDebounce(page);

  expect(await getContent(page)).toBe('');
  expect(await messagesOfType(page, 'change')).toHaveLength(0);
});

// A note whose only content is whitespace has the same shape of risk: the host
// gave us bytes, and closing without an edit must hand back those bytes.
test('opening a whitespace-only note returns its own bytes', async ({ page }) => {
  await clearMessages(page);
  await hostSetContent(page, '\n\n');

  expect(await getContent(page)).toBe('\n\n');
  expect(await messagesOfType(page, 'change')).toHaveLength(0);
});

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

// ============================================================
// YAML front matter (the block the editor's schema owns but never edits)
// ============================================================

// Front matter is not markdown, and normalize-once used to rewrite it: with
// nothing in the parser recognising it, `---` was a thematic break and the
// metadata lines a setext heading, so ANY edit elsewhere in the note wrote back
// `***`, a 16-dash underline, and — the real harm — `tags: \[a, b]`, a changed
// metadata VALUE. ADR-0002 accepts re-spelt markdown; it does not accept losing
// constructs the schema does not own, and front matter is named there.
const FRONT_MATTER_NOTE =
  '---\n' +
  'title: Front Matter Test\n' +
  'tags: [a, b]\n' +
  'date: 2026-09-01\n' +
  '---\n' +
  '\n' +
  '# Body\n' +
  '\n' +
  'Content after front matter.\n';

test('an edit elsewhere leaves the front matter block byte-identical', async ({ page }) => {
  await hostSetContent(page, FRONT_MATTER_NOTE);
  await clearMessages(page);

  await focusEditor(page);
  await page.keyboard.press('Control+End');
  await page.keyboard.type('X');

  const changes = await waitForMessages(page, 'change');
  expect(changes).toHaveLength(1);
  expect(changes[0].content).toBe(FRONT_MATTER_NOTE.replace(/\.\n$/, '.X\n'));
});

test('typing and deleting one character puts the note back exactly', async ({ page }) => {
  // The reported repro, to the letter: any trivial edit, undone by hand.
  await hostSetContent(page, FRONT_MATTER_NOTE);
  await clearMessages(page);

  await focusEditor(page);
  await page.keyboard.press('Control+End');
  await page.keyboard.type('X');
  await page.keyboard.press('Backspace');
  await settleChangeDebounce(page);

  expect(await getContent(page)).toBe(FRONT_MATTER_NOTE);
});

test('the front matter block is rendered, and is not editable', async ({ page }) => {
  await hostSetContent(page, FRONT_MATTER_NOTE);

  const block = page.locator('.futo-frontmatter');
  await expect(block).toHaveCount(1);
  // Visible on purpose: hiding it would let a Backspace from the body delete
  // metadata the user cannot see. Inert on purpose: the editor has no YAML
  // model, so it must not offer a caret it would then have to serialize.
  await expect(block).toBeVisible();
  expect(await block.textContent()).toContain('tags: [a, b]');
  expect(await block.getAttribute('contenteditable')).toBe('false');
});

test('clicking the front matter block puts the caret at the top of the body', async ({ page }) => {
  // Two failures in one assertion, both measured.
  //
  // The block is atomic, so a click on a SELECTABLE one left a ProseMirror node
  // selection sitting on the metadata and the next character REPLACED it:
  // clicking and typing `zzz` left a note whose entire content was `zzz`.
  // `selectable: false` closes that — and on its own opens the second one: with
  // no caret to place, the tap focused the editor, raised the keyboard, and
  // swallowed the keystroke (measured on the iOS simulator). So the click is
  // handled explicitly and lands the caret after the block.
  await hostSetContent(page, FRONT_MATTER_NOTE);
  await page.locator('.futo-frontmatter').click();
  await page.keyboard.type('zzz');
  await settleChangeDebounce(page);

  expect(await getContent(page)).toBe(FRONT_MATTER_NOTE.replace('# Body', '# zzzBody'));
});

test('backspace at the top of the body cannot eat the front matter', async ({ page }) => {
  await hostSetContent(page, FRONT_MATTER_NOTE);
  await clearMessages(page);

  await focusEditor(page);
  // Home of the document proper — the first body block — then backspace, which
  // is where `joinBackward` would try to merge into whatever precedes it.
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('Backspace');
  await settleChangeDebounce(page);

  expect(await getContent(page)).toContain(
    '---\ntitle: Front Matter Test\ntags: [a, b]\ndate: 2026-09-01\n---\n',
  );
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
 *
 * Waits for `document.fonts.ready` first: the embed warms Barlow
 * asynchronously (`warmEditorFonts.ts`), and a swap landing between the
 * measurement and the click moves every character's x-position, so the click
 * lands on a different character. Observed as an intermittent red on
 * "applyExternalContent with unchanged content preserves the selection" —
 * 3 of 3 on a loaded machine, then 25 of 25 green.
 */
async function clickCaretInto(page: Page, chars: number): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
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

// A decoration whose block is DELETED has to go with it. Shift+Tab is the
// preset's own liftListItem binding, so this needs no toolbar: lifting a
// top-level task item clear of its list used to leave the mapped checkbox
// widget floating over the plain paragraph it became.
test('lifting a task item clear of its list takes its checkbox with it', async ({ page }) => {
  const checkboxes = page.locator('.ProseMirror input[type="checkbox"]');
  await hostSetContent(page, '- [ ] hello');
  await focusEditor(page);
  await expect(checkboxes).toHaveCount(1);

  await page.locator('.ProseMirror p').first().click();
  await page.keyboard.press('Shift+Tab');
  await settleChangeDebounce(page);

  expect((await getContent(page)).trimEnd()).toBe('hello');
  await expect(checkboxes).toHaveCount(0);
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

  // Into the paragraph: the heading is no longer active. Wait on the message
  // rather than a frame — the click has to land, move the selection, and post.
  await clickCaretInto(page, 3);
  expect((await waitForMessages(page, 'formatState')).at(-1)?.active).toEqual([]);

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

  // Wait for the SETTLED state, not the first message after the click: the
  // click path can post an intermediate formatState (mousedown selection)
  // before the one for the final caret position, and asserting `.at(-1)` the
  // moment the first arrives read that intermediate under load. The assertion
  // is unchanged — the latest state must become exactly ['bold'].
  await expect
    .poll(async () => (await messagesOfType(page, 'formatState')).at(-1)?.active)
    .toEqual(['bold']);
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
  'a long-press drag reorders the block and posts lift, a tick per boundary, then drop',
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

mobileDndTest(
  'releasing back at the source is a true no-op: no change, no drop haptic',
  async ({ page, cdp }) => {
    await hostSetContent(page, 'alpha\n\nbravo\n\ncharlie');
    await clearMessages(page);

    const alpha = await blockCenter(page, 'alpha');
    await longPressDrag(page, cdp, alpha, { x: alpha.x, y: alpha.y + 4 });
    await settleChangeDebounce(page);

    expect(await messagesOfType(page, 'change')).toHaveLength(0);
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
mobileDndTest('a cancelled drag reports the drag as over', async ({ page, cdp }) => {
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
  /* The finger travelled, so the indicator ticked on the way; what a cancel
   * must NOT produce is the landing haptic, because nothing landed. */
  const kinds = (await messagesOfType(page, 'haptic')).map((m) => m.kind);
  expect(kinds[0]).toBe('lift');
  expect(kinds).not.toContain('drop');
  expect(await messagesOfType(page, 'change')).toHaveLength(0);
  expect(await getContent(page)).toBe('alpha\n\nbravo\n\ncharlie');
});

mobileDndTest('the indicator ticks once per boundary, not once per move', async ({ page, cdp }) => {
  await hostSetContent(page, 'alpha\n\nbravo\n\ncharlie\n\ndelta');
  await clearMessages(page);

  const ticks = async () =>
    (await messagesOfType(page, 'haptic')).filter((m) => m.kind === 'move').length;

  const alpha = await blockCenter(page, 'alpha');
  const bravo = await blockCenter(page, 'bravo');
  const charlie = await blockCenter(page, 'charlie');

  await touch(cdp, 'touchStart', alpha.x, alpha.y);
  await page.waitForTimeout(DEFAULT_LONG_PRESS_MS + 110);
  // The hold itself is silent: the bar is where the block already is.
  expect(await ticks()).toBe(0);

  await touch(cdp, 'touchMove', bravo.x, bravo.y);
  await page.waitForTimeout(32);
  const afterFirstBoundary = await ticks();
  expect(afterFirstBoundary).toBe(1);

  // Two more moves that resolve to the SAME boundary — no thumb should feel
  // anything, because nothing moved as far as the eye is concerned.
  await touch(cdp, 'touchMove', bravo.x, bravo.y + 2);
  await page.waitForTimeout(32);
  await touch(cdp, 'touchMove', bravo.x, bravo.y + 3);
  await page.waitForTimeout(32);
  expect(await ticks()).toBe(afterFirstBoundary);

  await touch(cdp, 'touchMove', charlie.x, charlie.y);
  await page.waitForTimeout(32);
  expect(await ticks()).toBe(afterFirstBoundary + 1);

  await touch(cdp, 'touchEnd', charlie.x, charlie.y);
  await settleChangeDebounce(page);
});

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
mobileDndTest('a cancelled drag stops the auto-scroll', async ({ page, cdp }) => {
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

// ============================================================
// Progressive open — the large-note story (issue #105)
// ============================================================
//
// A large note opens viewport-first: the first chunk is parsed and mounted
// synchronously, the rest streams in idle slices
// (src/features/editor/milkdown/progressiveLoad.ts). The whole design turns on
// one guarantee — a partially loaded note can never be saved — because
// serializing a half-loaded document writes a TRUNCATED file, and the editor
// hands content to the host through exactly two doors: the `change` message and
// `getContent()`. Both are locked here.
//
// The chunked-parse-equals-whole-parse half of the proof is not here: it is a
// property of every note in a 31k-note corpus, which is
// `scripts/milkdown-chunk-census.mjs`, not a spec case.

/**
 * A note past the 400-line threshold, so it takes the progressive path. Kept
 * only as large as the assertion needs: mounting tens of thousands of blocks
 * per test leaves enough browser pressure to make the suite's mouse-click
 * tests miss, which is a flake this suite pays for and learns nothing from.
 */
function largeNote(paragraphs = 800): string {
  return (
    Array.from(
      { length: paragraphs },
      (_, i) => `## Section ${i}\n\nBody line ${i} with some **bold** and a [link](https://e.com).`,
    ).join('\n\n') + '\n'
  );
}

/**
 * Drives one `initialize` and reports what the editor looked like INSIDE the
 * same task — before any idle slice could run. That is what makes "mid-stream"
 * deterministic instead of a race: progressive open applies chunk 0 in the
 * calling task and schedules everything else.
 */
async function initializeAndPeekMidStream(page: Page, content: string) {
  return page.evaluate((json) => {
    const w = window as unknown as FakeHostWindow & { __msgs: { type: string }[] };
    w.__msgs.length = 0;
    w.FutoEditor.initialize(json);
    return {
      contentDuringStream: w.FutoEditor.getContent(),
      messageTypes: w.__msgs.map((m) => m.type),
      mountedBlocks: document.querySelectorAll('.ProseMirror > *').length,
    };
  }, hostConfig({ content }));
}

/**
 * Resolves once the streaming affordance has come and gone — and FAILS if it
 * never came.
 *
 * Waiting only for `detached` would resolve instantly for a note the chunk
 * planner declined, and every assertion after it would then pass while
 * exercising the ordinary whole-document load: a test going green having
 * checked nothing (AGENTS.md M11). The planner's decline conditions are
 * exactly the kind of thing a later change moves.
 */
async function waitForStreamComplete(page: Page): Promise<void> {
  await page.waitForSelector('.milkdown-stream-tail', { state: 'detached', timeout: 60000 });
  expect(
    (await readTailWatch(page)).seen,
    'this note never took the progressive path — the assertions below prove nothing',
  ).toBe(true);
  await settleChangeDebounce(page);
}

test('a large note mounts only its first chunk before the tail streams', async ({ page }) => {
  const note = largeNote();

  const peek = await initializeAndPeekMidStream(page, note);

  // The whole note is ~15k lines; the first chunk's budget is 80.
  expect(peek.mountedBlocks).toBeGreaterThan(0);
  expect(peek.mountedBlocks).toBeLessThan(200);

  await waitForStreamComplete(page);

  const mountedAfter = await page.evaluate(
    () => document.querySelectorAll('.ProseMirror > *').length,
  );
  // 800 sections, each a heading plus a body paragraph.
  expect(mountedAfter).toBeGreaterThan(1500);
});

test('the save lock holds: no change message while the tail is streaming', async ({ page }) => {
  const peek = await initializeAndPeekMidStream(page, largeNote());

  expect(peek.messageTypes).not.toContain('change');

  await waitForStreamComplete(page);

  // Still none: a clean open never reports a change, streamed or not.
  expect(await messagesOfType(page, 'change')).toEqual([]);
});

test('the save lock holds: getContent mid-stream returns the original bytes', async ({ page }) => {
  const note = largeNote();

  const peek = await initializeAndPeekMidStream(page, note);

  // Not a prefix of the note — the note itself.
  expect(peek.contentDuringStream).toBe(note);

  await waitForStreamComplete(page);
  expect(await getContent(page)).toBe(note);
});

test('opening and closing a large note leaves it byte-identical', async ({ page }) => {
  // The load-echo guard (ADR-0002) over the chunked path: Milkdown would
  // normalize this markdown on a real edit, and must not on an open.
  const note =
    Array.from({ length: 600 }, (_, i) => `*   item ${i}\n\nSome __bold__ text ${i}.`).join(
      '\n\n',
    ) + '\n';

  await initialize(page, hostConfig({ content: note }));
  await waitForStreamComplete(page);

  expect(await getContent(page)).toBe(note);
  expect(await messagesOfType(page, 'change')).toEqual([]);
});

test('a large note with front matter survives the chunked path and an edit', async ({ page }) => {
  // Progressive open parses each chunk as its own little document, and front
  // matter is a document-START construct — so a chunk that BEGAN with `---`
  // would parse a mid-note thematic break as front matter, which cannot be
  // appended past the document's first position. `markdownChunks.ts` refuses
  // those boundaries; this is the end-to-end proof, with the note also carrying
  // a `---` rule further down for the boundary the planner has to decline.
  const note =
    '---\ntitle: Big\ntags: [a, b]\n---\n\n' +
    Array.from({ length: 400 }, (_, i) => `## Section ${i}\n\nBody ${i}.`).join('\n\n') +
    '\n\n---\n\ntail paragraph.\n';

  await initialize(page, hostConfig({ content: note }));
  await waitForStreamComplete(page);

  // Opening changes nothing (the load-echo guard), front matter included.
  expect(await getContent(page)).toBe(note);
  expect(await messagesOfType(page, 'change')).toEqual([]);

  await clearMessages(page);
  await focusEditor(page);
  await page.keyboard.type('X');
  const changes = await waitForMessages(page, 'change');
  const written = changes[changes.length - 1].content as string;

  // WHERE the character lands is deliberately not asserted: on a note this
  // large the containment stylesheet makes the browser's own document-boundary
  // motion stop inside the rendered region, so no keyboard shortcut puts the
  // caret at a known offset. What matters is what the edit did to everything
  // ELSE, and that is pinned exactly.
  expect(written.startsWith('---\ntitle: Big\ntags: [a, b]\n---\n\n')).toBe(true);
  // Exactly two `---` lines in the whole note: the front matter's own fences.
  // A setext underline, or the block re-fenced anywhere, would break this.
  expect(written.match(/^---$/gm)).toHaveLength(2);
  // One character inserted, and otherwise only the normalization an unedited
  // large note already gets: the mid-document rule spelled `***`.
  const normalized = note.replace('\n\n---\n\ntail', '\n\n***\n\ntail');
  expect(written.replace('X', '')).toBe(normalized);
});

test('streamed appends are not undoable — Ctrl-Z after an open keeps the note', async ({
  page,
}) => {
  const note = largeNote(600);

  await initialize(page, hostConfig({ content: note }));
  await waitForStreamComplete(page);
  await focusEditor(page);

  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await settleChangeDebounce(page);

  // Undo neither un-loaded a chunk nor emptied the document.
  expect(await getContent(page)).toBe(note);
  expect(await messagesOfType(page, 'change')).toEqual([]);
});

test('an edit made while the tail streams is released against the COMPLETE note', async ({
  page,
}) => {
  const note = largeNote(600);

  // Type into the first viewport in the same task the load starts in, so the
  // keystroke provably lands before the tail has finished arriving.
  await page.evaluate(
    (json) => {
      const w = window as unknown as FakeHostWindow;
      w.__msgs.length = 0;
      w.FutoEditor.initialize(json);
      w.FutoEditor.focus();
    },
    hostConfig({ content: note }),
  );
  await page.keyboard.type('EDITED ');
  await waitForStreamComplete(page);

  const changes = await messagesOfType(page, 'change');
  expect(changes.length).toBeGreaterThan(0);
  const saved = changes[changes.length - 1].content as string;

  expect(saved).toContain('EDITED ');
  // The tail is all there: the last section of the note survived the edit.
  expect(saved).toContain('Section 599');
  expect(await getContent(page)).toBe(saved);
});

test('getContent mid-stream after an edit finishes the load rather than answering short', async ({
  page,
}) => {
  // The other half of the save lock. With nothing typed, `getContent` can
  // answer with the host's own bytes for free; once the user has edited, the
  // only answer carrying BOTH the edit and the tail costs the rest of the
  // parse, and this asserts it is paid rather than a prefix returned.
  // Big enough that the tail outlives the keystrokes below — the assertion on
  // `streaming` keeps that honest rather than assumed.
  const note = largeNote(4000);

  await page.evaluate(
    (json) => {
      const w = window as unknown as FakeHostWindow;
      w.__msgs.length = 0;
      w.FutoEditor.initialize(json);
      w.FutoEditor.focus();
    },
    hostConfig({ content: note }),
  );
  await page.keyboard.type('EDITED ');

  // Read while the tail is still arriving.
  const midStream = await page.evaluate(() => {
    const w = window as unknown as FakeHostWindow;
    return {
      streaming: document.querySelectorAll('.milkdown-stream-tail').length,
      content: w.FutoEditor.getContent(),
    };
  });

  expect(midStream.streaming).toBe(1);
  expect(midStream.content).toContain('EDITED ');
  // The tail, which had not been parsed when the read started.
  expect(midStream.content).toContain('Section 3999');
});

test('the streaming tail carries a loading affordance that clears on completion', async ({
  page,
}) => {
  await initialize(page, hostConfig({ content: largeNote() }));
  await waitForStreamComplete(page);

  // `waitForStreamComplete` already asserts it appeared; this pins its role.
  expect(await readTailWatch(page)).toEqual({ seen: true, role: 'status' });
  await expect(page.locator('.milkdown-stream-tail')).toHaveCount(0);
});

test('open records time-to-interactive-first-viewport, and it beats time-to-complete', async ({
  page,
}) => {
  await initialize(page, hostConfig({ content: largeNote() }));
  await waitForStreamComplete(page);

  const timings = await page.evaluate(() => ({
    interactive: performance.getEntriesByName('futo:editor-open-interactive')[0]?.duration ?? null,
    complete: performance.getEntriesByName('futo:editor-open-complete')[0]?.duration ?? null,
  }));

  expect(timings.interactive).not.toBeNull();
  expect(timings.complete).not.toBeNull();
  /* The assertion is the RATIO, not a wall-clock number. The product budget is
   * "first viewport interactive in under a second" on the low-end reference
   * PHONE (docs/plan/milkdown-transition.md §5 / D7), which is issue #106's to
   * enforce on the device; an absolute millisecond bound here would only be
   * measuring this box, and its next edit would be a bump (AGENTS.md M15).
   * Half is a bound sized to fail a first chunk that parsed the whole
   * document, whatever the machine: this note streams in 8 chunks. */
  expect(timings.interactive!).toBeLessThan(timings.complete! / 2);
});

/**
 * The read-only diagnostic global `src/editor-embed/main.ts` installs for the
 * gauntlet. Deliberately NOT part of `FakeHostWindow`, which mirrors the
 * futoBridge contract exactly (apps/ios BridgeCallSurfaceTests scans that
 * surface) — this is not a contract member.
 */
interface ProseMirrorDiagnosticWindow {
  __futoProseMirrorView: () => {
    state: {
      doc: { content: { size: number }; resolve(pos: number): unknown };
      tr: { setSelection(selection: unknown): { scrollIntoView(): unknown } };
      selection: { from: number; constructor: { near(pos: unknown): unknown } };
    };
    dispatch(tr: unknown): void;
    domAtPos(pos: number): { node: Node };
  };
}

/**
 * The containment stylesheet (docs/plan/milkdown-transition.md §2/§5, issue
 * #106): `.ProseMirror > *` children carry `content-visibility: auto` with a
 * `contain-intrinsic-size` estimate, so offscreen blocks cost no layout per
 * keystroke — the perf probe measured keystroke cost at 14k lines as 82%
 * browser layout without it. This locks the rule's presence and the behavior
 * it must not break: the caret can move into a region the browser has skipped,
 * and land on real, rendered content.
 */
test('offscreen blocks are containment-skipped and the caret can still reach them', async ({
  page,
}) => {
  await initialize(page, hostConfig({ content: largeNote() }));
  await waitForStreamComplete(page);

  const styles = await page.evaluate(() => {
    const blocks = document.querySelectorAll('.ProseMirror > *');
    const middle = blocks[Math.floor(blocks.length / 2)] as Element;
    const computed = getComputedStyle(middle);
    return {
      contentVisibility: computed.getPropertyValue('content-visibility'),
      containIntrinsicSize: computed.getPropertyValue('contain-intrinsic-size'),
      /* The rule is engine-gated: it only applies under this class, which
       * `blockContainment.ts` withholds on Apple WebKit (where a scrolled-in
       * block keeps its box and paints no text). Chromium — this project, and
       * the Android WebView the budgets were measured on — must carry it, so
       * assert the wiring and not just the computed value: a class renamed on
       * one side of the pair would otherwise turn containment off everywhere
       * and this test would still pass on the fallback.  */
      gated: !!document.querySelector('.futo-milkdown.block-containment'),
    };
  });
  expect(styles.gated).toBe(true);
  expect(styles.contentVisibility).toBe('auto');
  expect(styles.containIntrinsicSize).toContain('auto');

  // Caret into an offscreen region: place the selection at the document end
  // the way in-app navigation does (a scrolled dispatch), then type with the
  // real keyboard. If containment broke caret entry or scroll anchoring, the
  // keystroke would land elsewhere or nowhere.
  await focusEditor(page);
  const scrolled = await page.evaluate(() => {
    const view = (window as unknown as ProseMirrorDiagnosticWindow).__futoProseMirrorView();
    const scroller = document.querySelector('.ProseMirror') as HTMLElement;
    const before = scroller.scrollTop;
    /* `Selection.near` is a static, reached through the live selection's
     * constructor so this test needs no prosemirror import of its own — the
     * bundle under test owns the only copy of those classes. */
    const selection = view.state.selection.constructor.near(
      view.state.doc.resolve(view.state.doc.content.size),
    );
    view.dispatch(view.state.tr.setSelection(selection).scrollIntoView());
    return { before, after: scroller.scrollTop };
  });
  expect(scrolled.after).toBeGreaterThan(scrolled.before);

  await page.keyboard.type(' THE-END');
  await settleChangeDebounce(page);
  expect((await getContent(page)).trimEnd().endsWith('THE-END')).toBe(true);

  /* The block the CARET landed in is genuinely rendered, not a
   * `contain-intrinsic-size` estimate: its box sits inside the scroller's
   * viewport at its real laid-out size.
   *
   * The caret's block, not the document's last child — the preset keeps a
   * trailing placeholder paragraph after the content and ProseMirror scrolls
   * the CARET into view, so the final element legitimately stays below the
   * fold. Asserting on the last child passed here by luck and was outright
   * wrong on Android, where tests/android-editor-perf.mjs runs the same probe;
   * the two are deliberately kept in the same shape. */
  const landing = await page.evaluate(() => {
    const editor = document.querySelector('.ProseMirror') as HTMLElement;
    const view = (window as unknown as ProseMirrorDiagnosticWindow).__futoProseMirrorView();
    let block = view.domAtPos(view.state.selection.from).node as Node | null;
    if (block?.nodeType === Node.TEXT_NODE) block = block.parentElement;
    while (block && (block as HTMLElement).parentElement !== editor) {
      block = (block as HTMLElement).parentElement;
    }
    const rect = (block as HTMLElement).getBoundingClientRect();
    const viewport = editor.getBoundingClientRect();
    return { top: rect.top, height: rect.height, viewportBottom: viewport.bottom };
  });
  expect(landing.height).toBeGreaterThan(0);
  expect(landing.top).toBeLessThan(landing.viewportBottom);
});

/**
 * The one unacceptable failure, tested against a REAL FILE.
 *
 * The two tests above prove the editor never hands out a partial document. This
 * one closes the loop the way the product does: a host that autosaves whatever
 * the editor tells it, a note file on disk, and the app dying mid-stream. The
 * file must come back byte-for-byte.
 *
 * It runs its own browser context because the "kill" IS closing that context
 * while the tail is still arriving — there is no exit path, no flush, no
 * `getContent`, exactly as when an OS kills a backgrounded app.
 *
 * Red-proved: deleting either door of the save lock (the `progressive.loading`
 * early return in the change listener, or the one in `getContent`) turns this
 * test red.
 */
base('killing the app mid-stream leaves the note file byte-untouched', async ({ browser }) => {
  const SECTIONS = 4000;
  /* Heading + list + paragraph per section. Named, because the "still partial"
   * assertion below is about the note's own size: the absolute block count it
   * used to carry was tuned to a slower load, and dropping upstream's
   * `syncHeadingIdPlugin` — which re-stamped every heading id after every
   * appended chunk — made the stream fast enough to blow through it while the
   * load was still genuinely partial. */
  const TOP_LEVEL_BLOCKS = SECTIONS * 3;
  const note =
    Array.from(
      { length: SECTIONS },
      (_, i) => `## Section ${i}\n\n*   loose item ${i}\n\nBody __${i}__ text.`,
    ).join('\n\n') + '\n';

  const dir = mkdtempSync(path.join(tmpdir(), 'futo-progressive-'));
  const notePath = path.join(dir, 'note.md');
  writeFileSync(notePath, note, 'utf8');
  const originalBytes = readFileSync(notePath);

  const { context, page } = await openEmbed(browser, EDITOR_URL);
  try {
    // The host's autosave: every `change` the editor reports is written to the
    // note file, immediately, which is what makes a truncated `change` fatal.
    await page.exposeFunction('__futoHostAutosave', (content: string) => {
      writeFileSync(notePath, content, 'utf8');
    });
    await page.evaluate(() => {
      const w = window as unknown as FakeHostWindow & {
        futoBridge: { postMessage(json: string): void };
        __futoHostAutosave(content: string): void;
      };
      w.futoBridge = {
        postMessage: (json: string) => {
          const message = JSON.parse(json) as { type: string; content?: string };
          w.__msgs.push(message as never);
          if (message.type === 'change' && typeof message.content === 'string') {
            void w.__futoHostAutosave(message.content);
          }
        },
      };
    });

    await page.evaluate(
      (json) => (window as unknown as FakeHostWindow).FutoEditor.initialize(json),
      hostConfig({ content: note }),
    );

    await page.waitForSelector('.milkdown-stream-tail', { state: 'attached' });

    /* Sit here, mid-stream, for longer than the change listener's own 200 ms
     * debounce. This is what gives the test teeth: without it the context
     * closed within milliseconds of chunk 0, before any `change` could have
     * been delivered — so the file came back untouched whether or not the save
     * lock existed, and the test passed with the lock deleted. Inside this
     * window an unlocked editor DOES report a partial document (Milkdown's
     * listener serializes the doc from the transaction that started the
     * debounce, which mid-stream is a prefix), the fake host writes it, and the
     * byte comparison below fails. */
    await page.waitForTimeout(CHANGE_DEBOUNCE_MS * 3);

    // Still streaming: the plug is being pulled on a genuinely partial load.
    expect(await page.locator('.milkdown-stream-tail').count()).toBe(1);
    expect(
      await page.evaluate(() => document.querySelectorAll('.ProseMirror > *').length),
    ).toBeLessThan(TOP_LEVEL_BLOCKS);
  } finally {
    await context.close();
  }

  expect(readFileSync(notePath).equals(originalBytes)).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});

// ============================================================
// The parse cap — a note with one enormous block (the huge-note trap)
// ============================================================
//
// Progressive open streams a note in top-level blocks, so it has nothing to
// offer a note that IS one block. Measured against these exact bundle bytes in
// chromium (2026-09-01): the cost of a whole-document parse is driven not by
// the note's size but by the size of its largest INLINE CONTENT RUN, and it is
// superlinear in it — micromark's text tokenizer merges adjacent data tokens by
// splicing one events array, which is quadratic inside a single run.
//
// | fixture (same 1.26 MB either way)      | initialize |
// |---|---|
// | 1.26 MB in ONE line (one inline node)  | 107 ms     |
// | 20k lines, blank line every 200        | 667 ms     |
// | 20k lines, blank line every line       | 2,264 ms   |
// | 20k lines, NO blank line (one run)     | 7,796 ms   |
//
// A user's 50,000-line note with no blank line anywhere took 28 s here and
// minutes on a phone: the editor showed nothing, and because the iOS shell
// cannot read a document that never mounted, Back refused to leave. The editor's
// half of that fix is this cap — a note whose largest run is past what parses in
// bounded time mounts a BOUNDED, READ-ONLY preview and says so, instead of
// blocking the engine on a parse that may never finish.
//
// Read-only is what makes it safe rather than merely fast: the note is never
// serialized, so `getContent()` answers with the host's own bytes and no save
// can ever write the preview over the real file. A prefix the user could edit
// is the one trade this must not make (docs/plan/milkdown-transition.md §5).

/**
 * A note that is ONE paragraph: every line is a sentence and there is no blank
 * line anywhere, so `planMarkdownChunks` declines it (`no-boundary`) and the
 * whole document goes through a single parse.
 *
 * 20,000 lines rather than the reported 50,000 deliberately: it is the smallest
 * fixture that reproduces the block clearly (7.8 s in chromium against ~50 ms
 * after the cap), and a regression fails the timing assertion below instead of
 * blowing the spec timeout with no message.
 */
function oneParagraphNote(lines: number): string {
  return Array.from(
    { length: lines },
    (_, i) => `Line ${i + 1} of this note is an ordinary sentence about something.`,
  ).join('\n');
}

const OVER_CAP_LINES = 20_000;
/** Comfortably past the measured 7.8 s block, comfortably past the ~50 ms fix. */
const OPEN_BUDGET_MS = 2_000;

async function initializeTimed(page: Page, content: string): Promise<number> {
  return page.evaluate((json) => {
    const w = window as unknown as FakeHostWindow & { __msgs: { type: string }[] };
    w.__msgs.length = 0;
    const started = performance.now();
    w.FutoEditor.initialize(json);
    return performance.now() - started;
  }, hostConfig({ content }));
}

test('a note that is one enormous paragraph opens instead of blocking the engine', async ({
  page,
}) => {
  const note = oneParagraphNote(OVER_CAP_LINES);

  const elapsed = await initializeTimed(page, note);

  expect(elapsed).toBeLessThan(OPEN_BUDGET_MS);
  // It really did mount something the user can read, rather than "opening" by
  // rendering nothing at all.
  expect(await page.locator('.ProseMirror').innerText()).toContain('Line 1 of this note');
});

test('an over-cap note mounts a bounded preview, not the whole document', async ({ page }) => {
  const note = oneParagraphNote(OVER_CAP_LINES);

  await initializeTimed(page, note);

  const mounted = (await page.locator('.ProseMirror').innerText()).length;
  // Bounded, and bounded well under the note: the preview budget is a few
  // hundred lines against twenty thousand.
  expect(mounted).toBeGreaterThan(1_000);
  expect(mounted).toBeLessThan(note.length / 4);
});

test('an over-cap note tells the user it is read-only and why', async ({ page }) => {
  await initializeTimed(page, oneParagraphNote(OVER_CAP_LINES));

  const notice = page.locator('.milkdown-oversize-notice');
  await expect(notice).toHaveCount(1);
  // The two facts the user needs: nothing they do here is saved, and how much
  // of the note they are looking at.
  await expect(notice).toContainText(/read-only/i);
  await expect(notice).toContainText('20,000');
});

test('an over-cap note hands the host back its own bytes and posts no change', async ({ page }) => {
  const note = oneParagraphNote(OVER_CAP_LINES);

  await initializeTimed(page, note);
  await settleChangeDebounce(page);

  expect(await getContent(page)).toBe(note);
  expect(await messagesOfType(page, 'change')).toHaveLength(0);
});

test('typing into an over-cap note cannot change the note the host would save', async ({
  page,
}) => {
  const note = oneParagraphNote(OVER_CAP_LINES);
  await initializeTimed(page, note);
  await clearMessages(page);

  await page.locator('.ProseMirror').click();
  await page.keyboard.type('DESTROY');
  await settleChangeDebounce(page);

  expect(await getContent(page)).toBe(note);
  expect(await messagesOfType(page, 'change')).toHaveLength(0);
});

test('a one-paragraph note UNDER the cap still opens fully editable', async ({ page }) => {
  const note = oneParagraphNote(2_000);

  const elapsed = await initializeTimed(page, note);

  expect(elapsed).toBeLessThan(OPEN_BUDGET_MS);
  await expect(page.locator('.milkdown-oversize-notice')).toHaveCount(0);
  expect(await getContent(page)).toBe(note);

  await focusEditor(page);
  await page.keyboard.type('x');
  await settleChangeDebounce(page);

  const changes = await messagesOfType(page, 'change');
  expect(changes.length).toBeGreaterThan(0);
  expect(await getContent(page)).toContain('x');
});

// ============================================================
// Images (#103) — vault-relative rendering
// ============================================================

/** The `<img>` the node view rendered for a given on-disk reference. */
function imageFor(page: Page, reference: string) {
  return page.locator(`.ProseMirror img[data-futo-src="${reference}"]`);
}

test('a vault image renders against the base URL the host registered', async ({ page }) => {
  await initialize(page, hostConfig({ imageBaseUrl: 'file:///vault/', content: '![](pic.png)' }));

  await expect(imageFor(page, 'pic.png')).toHaveAttribute('src', 'file:///vault/pic.png');
});

/* CommonMark needs the pointy brackets for a destination containing a space,
 * and the app's own filenames never contain one (`createImageFilename`). This
 * covers the foreign-vault spelling. */
test('a filename with spaces is percent-encoded onto the base URL', async ({ page }) => {
  await initialize(page, hostConfig({ imageBaseUrl: 'file:///vault/' }));
  await hostSetContent(page, '![](<my photo.png>)');

  await expect(imageFor(page, 'my photo.png')).toHaveAttribute(
    'src',
    'file:///vault/my%20photo.png',
  );
});

test('an image alt text reaches the rendered element', async ({ page }) => {
  await initialize(page, hostConfig({ imageBaseUrl: 'file:///vault/' }));
  await hostSetContent(page, '![a cat](pic.png)');

  await expect(imageFor(page, 'pic.png')).toHaveAttribute('alt', 'a cat');
});

/* The host is free to register the base URL after the note. Nothing dispatches
 * a transaction when it does, so a renderer that only re-resolves on document
 * change leaves the image blank for the rest of the session. */
test('a base URL registered AFTER the content resolves the images already on screen', async ({
  page,
}) => {
  await hostSetContent(page, '![](late.png)');
  await expect(imageFor(page, 'late.png')).not.toHaveAttribute('src', /./);

  await page.evaluate(() =>
    (window as unknown as FakeHostWindow).FutoEditor.setImageBaseUrl('file:///vault/'),
  );

  await expect(imageFor(page, 'late.png')).toHaveAttribute('src', 'file:///vault/late.png');
});

test('an unresolvable image has no src at all, rather than a broken vault filename', async ({
  page,
}) => {
  await hostSetContent(page, '![](nobase.png)');

  expect(await imageFor(page, 'nobase.png').evaluate((el) => el.hasAttribute('src'))).toBe(false);
});

test('a remote image URL is rendered untouched', async ({ page }) => {
  await initialize(page, hostConfig({ imageBaseUrl: 'file:///vault/' }));
  await hostSetContent(page, '![](https://example.com/remote.png)');

  await expect(imageFor(page, 'https://example.com/remote.png')).toHaveAttribute(
    'src',
    'https://example.com/remote.png',
  );
});

/* CRITICAL: the resolved URL is a rendering detail and must never reach the
 * file. If it did, every device would rewrite every image reference to its own
 * shell's URL scheme on the first edit, and the note would stop resolving
 * anywhere else. */
test('the resolved URL never reaches the note — opening leaves the reference byte-identical', async ({
  page,
}) => {
  await initialize(page, hostConfig({ imageBaseUrl: 'file:///vault/' }));
  await hostSetContent(page, 'before\n\n![](pic.png)\n\nafter');

  await expect(imageFor(page, 'pic.png')).toHaveAttribute('src', 'file:///vault/pic.png');
  expect(await getContent(page)).toBe('before\n\n![](pic.png)\n\nafter');
});

test('the resolved URL never reaches the note — a real edit still serializes the vault filename', async ({
  page,
}) => {
  await initialize(page, hostConfig({ imageBaseUrl: 'file:///vault/' }));
  await hostSetContent(page, '![](pic.png)');
  await clearMessages(page);

  await focusEditor(page);
  await page.keyboard.press('End');
  await page.keyboard.type(' caption');

  const changes = await waitForMessages(page, 'change');
  const content = changes[changes.length - 1].content as string;
  expect(content).toContain('![](pic.png)');
  expect(content).not.toContain('file:///vault/');
});

test('insertImage puts the vault reference in the note and renders it resolved', async ({
  page,
}) => {
  await initialize(page, hostConfig({ imageBaseUrl: 'file:///vault/', content: 'note body' }));
  await focusEditor(page);
  await clearMessages(page);

  await page.evaluate(() =>
    (window as unknown as FakeHostWindow).FutoEditor.insertImage('image-1712.png'),
  );

  await expect(imageFor(page, 'image-1712.png')).toHaveAttribute(
    'src',
    'file:///vault/image-1712.png',
  );
  const changes = await waitForMessages(page, 'change');
  expect(changes[changes.length - 1].content as string).toContain('![](image-1712.png)');
});

// ============================================================
// Images (#103) — clipboard paste
// ============================================================

/**
 * Dispatches a `paste` on the ProseMirror surface. See the file header for why
 * a synthetic ClipboardEvent is the honest ceiling here.
 */
async function pasteClipboard(
  page: Page,
  build: 'imageFile' | 'hiddenBitmap' | 'plainText',
): Promise<void> {
  await page.evaluate((kind) => {
    const dt = new DataTransfer();
    if (kind === 'imageFile') {
      const bytes = Uint8Array.from(atob('iVBORw0KGgo='), (c) => c.charCodeAt(0));
      dt.items.add(new File([bytes], 'shot.png', { type: 'image/png' }));
    } else if (kind === 'plainText') {
      dt.setData('text/plain', 'just words');
    }
    document
      .querySelector('.ProseMirror')!
      .dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
      );
  }, build);
}

test('pasting an image file posts saveImageData with base64 bytes and extension', async ({
  page,
}) => {
  await hostSetContent(page, 'doc');
  await focusEditor(page);
  await clearMessages(page);

  await pasteClipboard(page, 'imageFile');

  // The bytes are read through an async FileReader — wait on the message, never
  // a fixed delay (M15).
  expect(await waitForMessages(page, 'saveImageData')).toEqual([
    { type: 'saveImageData', data: 'iVBORw0KGgo=', ext: 'png' },
  ]);
});

/* The host writes the file and calls `insertImage` back, so the editor must not
 * ALSO paste the clipboard as content — that is how a pasted screenshot ends up
 * as a stray blank paragraph or a base64 blob in the note. */
test('pasting an image file leaves the document alone until the host inserts', async ({ page }) => {
  await hostSetContent(page, 'doc');
  await focusEditor(page);
  await clearMessages(page);

  await pasteClipboard(page, 'imageFile');
  await waitForMessages(page, 'saveImageData');
  await settleChangeDebounce(page);

  expect(await messagesOfType(page, 'change')).toHaveLength(0);
  expect(await getContent(page)).toBe('doc');
});

/* iOS's WKWebView (and Linux/WebKitGTK on desktop) hide a screenshot from the
 * paste event entirely: no file, no text. The host reads it off the native
 * pasteboard instead (bridge contract v5). */
test('pasting a bitmap the event never exposed posts pasteClipboardImage', async ({ page }) => {
  await hostSetContent(page, 'doc');
  await focusEditor(page);
  await clearMessages(page);

  await pasteClipboard(page, 'hiddenBitmap');

  expect(await waitForMessages(page, 'pasteClipboardImage')).toEqual([
    { type: 'pasteClipboardImage' },
  ]);
});

test('pasting text is left to the editor and posts no image message', async ({ page }) => {
  await hostSetContent(page, 'doc');
  await focusEditor(page);
  await clearMessages(page);

  await pasteClipboard(page, 'plainText');
  await settleChangeDebounce(page);

  expect(await messagesOfType(page, 'saveImageData')).toHaveLength(0);
  expect(await messagesOfType(page, 'pasteClipboardImage')).toHaveLength(0);
  expect(await getContent(page)).toContain('just words');
});
