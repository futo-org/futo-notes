import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test as base, type CDPSession, type Page } from '@playwright/test';

import { BRIDGE_VERSION } from '@futo-notes/editor';

import {
  DEFAULT_LONG_PRESS_MS,
  GHOST_PAD_Y_PX,
} from '../src/features/editor/milkdown/mobileBlockDnd';
import { EDITOR_URL } from './editorEmbedBundle';
import { PERFORMANCE_BUDGET } from './editor-gauntlet/performanceFloor';
import {
  type BridgeMessage,
  clearMessages,
  flushFrames,
  focusEditor,
  getContent,
  installFakeAndroidHost,
  messages,
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
    bridgeVersion: BRIDGE_VERSION,
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

test('posts ready exactly once with the bundle bridge version', async ({ page }) => {
  const ready = await messagesOfType(page, 'ready');
  expect(ready).toHaveLength(1);
  expect(ready[0].version).toBe(BRIDGE_VERSION);
});

test('one initialize applies the host config and reports initialized', async ({ page }) => {
  await clearMessages(page);

  await initialize(page, hostConfig({ theme: 'dark', content: '# booted' }));

  expect(await getContent(page)).toBe('# booted');
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
  expect(await messagesOfType(page, 'initialized')).toEqual([
    { type: 'initialized', version: BRIDGE_VERSION },
  ]);
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

/**
 * An empty note must be typeable, and the whole surface must be the editor.
 *
 * The desktop shell shipped a build where an empty note's editable box was
 * sized to its (nonexistent) content in both axes, leaving a note that could
 * not be clicked into anywhere but a narrow strip. The embed sizes itself
 * differently — `editor.html` carries a definite height and the editable is the
 * scroller — so this is the guard that the SAME empty document is typeable in
 * the bundle both native shells ship, whatever the host's layout does.
 * → docs/spec/editor.md "Blank editor surface"
 */
test('an empty note can be clicked into and typed in', async ({ page }) => {
  await hostSetContent(page, '');
  await clearMessages(page);

  const box = await page.locator('.ProseMirror').boundingBox();
  expect(box).not.toBeNull();
  // The editable must actually cover the web view, not collapse to its content.
  const viewport = page.viewportSize();
  expect(box!.width).toBeGreaterThan((viewport?.width ?? 0) * 0.5);

  // Press in the blank tail well below the first line, then type.
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height - 24);
  await page.keyboard.type('hello');
  await flushFrames(page);

  expect(await getContent(page)).toBe('hello\n');
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

/*
 * Data safety: a version that arrives from OUTSIDE the editor is not an edit,
 * so it cannot be undone. `applyExternalContent` is the sync-adopt path, and it
 * deliberately does NOT reset the undo stack (the user's own edits stay
 * undoable), which is exactly what made this a hole: as an ordinary transaction
 * the adopt sat on top of the stack, and one Ctrl-Z revived the superseded
 * version and handed it to autosave. → docs/spec/editor.md "Saving & rename"
 */
test('a version adopted from outside the editor is not something undo can revive', async ({
  page,
}) => {
  await hostSetContent(page, 'mine');
  await focusEditor(page);
  await page.keyboard.press('End');
  await page.keyboard.type(' typed');
  await waitForMessages(page, 'change');

  await page.evaluate(() =>
    (window as unknown as FakeHostWindow).FutoEditor.applyExternalContent('theirs\n'),
  );
  await settleChangeDebounce(page);
  expect(await getContent(page)).toBe('theirs\n');

  await focusEditor(page);
  await page.keyboard.press('ControlOrMeta+z');
  await page.keyboard.press('ControlOrMeta+z');
  await settleChangeDebounce(page);

  expect(await getContent(page)).toBe('theirs\n');
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
  expect((await messagesOfType(page, 'formatState')).at(-1)?.active).toEqual(['heading-2']);
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
// The drag itself is @milkdown/plugin-block's own HTML5 drag; nothing in this
// repo implements it. This case exists because that is easy to break from the
// outside without noticing: the handle is OUR element, positioned by OUR
// getOffset, surfaced by OUR synthetic pointermove. Until 2026-09-02 a
// 253-line touch/pen fallback (handleBlockDrag.ts) sat on the same handle and
// owned the only test of this mode; when it went, the mouse drag it left
// behind had no coverage at all. This is that coverage.
const gutterHandleTest = base.extend<{ page: Page }>({
  page: async ({ browser }, use) => {
    const context = await browser.newContext();
    await context.addInitScript(installFakeAndroidHost);
    const page = await context.newPage();
    await page.goto(`${EDITOR_URL}?blockDragMode=gutter-handle`);
    await page.waitForFunction(() =>
      (window as unknown as FakeHostWindow).__msgs?.some((m) => m.type === 'ready'),
    );
    await use(page);
    await context.close();
  },
});

/**
 * A genuine HTML5 drag off the ⠿ handle, driven ONE `dragover` at a time.
 *
 * `locator.dragTo()` cannot do this job: it moves the pointer to the target in
 * two hops, so a drag that must be SAMPLED at several y positions inside one
 * gap never reports the intermediate ones — the indicator only appears to move
 * once the pointer has already reached a different gap, which is exactly the
 * bug hiding itself.
 *
 * Individual `page.mouse.move` calls do report them, and the interception is a
 * real one over CDP: Playwright's own `DragManager` (playwright-core
 * `server/chromium/crDragDrop.js`) turns the first post-mousedown move into
 * `Input.setInterceptDrags` plus a real `dragstart` in the page — which is
 * where @milkdown/plugin-block sets `view.dragging` — and from then on EVERY
 * `mouse.move` is dispatched as an `Input.dispatchDragEvent` of type
 * `dragOver` at exactly that point, with `mouse.up()` dispatching `drop`.
 * Opening a second CDP session to drive this by hand does NOT work: Playwright
 * has already consumed `Input.dragIntercepted` and turned interception back
 * off before another listener could see it.
 */
async function startHandleDrag(page: Page, from: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // Past the browser's own drag threshold. The FIRST move is the one that
  // starts the drag, so it is spent here rather than on a boundary we assert.
  await page.mouse.move(from.x + 4, from.y + 8);
  await page.mouse.move(from.x + 8, from.y + 20);

  /** The dragover handler writes the indicator synchronously; a frame is
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
    const el = document.querySelector('.milkdown-drop-indicator');
    if (!(el instanceof HTMLElement)) return null;
    if (!el.classList.contains('milkdown-drop-indicator--visible')) return null;
    const top = Number.parseFloat(el.style.top);
    return Number.isFinite(top) ? top : null;
  });
}

/** Box of the LIST ITEM containing `text` (blockBox answers with the whole
 * list for any text inside one). */
async function itemBox(
  page: Page,
  text: string,
): Promise<{ x: number; top: number; bottom: number }> {
  const box = await page.locator('.ProseMirror li', { hasText: text }).first().boundingBox();
  if (!box) throw new Error(`no geometry for the list item containing "${text}"`);
  return { x: box.x + box.width / 2, top: box.y, bottom: box.y + box.height };
}

/** Centre of the ⠿ handle for the block containing `text`, surfaced by hover
 * — or for the list item containing it, with `{ item: true }`. */
async function surfaceHandle(
  page: Page,
  text: string,
  options: { item?: boolean } = {},
): Promise<{ x: number; y: number }> {
  const block = options.item
    ? await itemBox(page, text).then((box) => ({ x: box.x, y: (box.top + box.bottom) / 2 }))
    : await blockCenter(page, text);
  await page.mouse.move(block.x, block.y);
  const handle = page.locator('.milkdown-block-handle[data-show="true"]');
  await handle.waitFor({ state: 'attached' });
  const box = await handle.boundingBox();
  if (!box) throw new Error('the ⠿ handle has no geometry');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

gutterHandleTest('the ⠿ handle sits in the gutter, never over a list marker', async ({ page }) => {
  // A list item's box starts at its text; its bullet hangs in the list's
  // padding to the left. An offset measured from that box put the handle on
  // top of the bullet, and over the parent's text for a nested item. The
  // handle belongs in the editor's gutter, left of the text column, at every
  // depth.
  // Second items, deliberately: plugin-block resolves a FIRST item to its
  // parent list, whose box does start at the text column, so first items never
  // showed the bug.
  await hostSetContent(page, 'intro\n\n- first\n- outer\n  - nested\n  - inner\n');
  const contentLeft = await page.evaluate(() => {
    const pm = document.querySelector('.ProseMirror')!;
    return pm.getBoundingClientRect().left + parseFloat(getComputedStyle(pm).paddingLeft);
  });
  for (const text of ['intro', 'outer', 'inner']) {
    // Over the TEXT, not the block's left edge: hovering a list item's text
    // makes the item itself the active block, which is the case that put the
    // handle on the bullet.
    const textBox = (await page.getByText(text, { exact: true }).first().boundingBox())!;
    await page.mouse.move(textBox.x + textBox.width / 2, textBox.y + textBox.height / 2, {
      steps: 4,
    });
    const handle = page.locator('.milkdown-block-handle[data-show="true"]');
    // The handle is repositioned asynchronously; wait until it is on THIS line.
    await expect
      .poll(async () => (await handle.boundingBox())?.y ?? -1, { message: `${text}: handle` })
      .toBeGreaterThanOrEqual(textBox.y - 4);
    const box = (await handle.boundingBox())!;
    expect(box.x + box.width, `${text}: handle overlaps the text column`).toBeLessThanOrEqual(
      contentLeft + 0.5,
    );
    expect(box.x, `${text}: handle left the editor`).toBeGreaterThanOrEqual(0);
  }
});

gutterHandleTest('a mouse drag on the ⠿ handle reorders the block', async ({ page }) => {
  await hostSetContent(page, '# alpha\n\nbravo\n\ncharlie');
  await clearMessages(page);

  // Hover is what surfaces the handle for a block under a mouse.
  const alpha = await blockCenter(page, 'alpha');
  await page.mouse.move(alpha.x, alpha.y);
  const handle = page.locator('.milkdown-block-handle[data-show="true"]');
  await handle.waitFor({ state: 'attached' });

  // plugin-block marks its own content draggable; if that ever stops being
  // true the drag below is a no-op rather than a failure, so assert it.
  await expect(handle).toHaveAttribute('draggable', 'true');

  // y=4 is charlie's UPPER half, so the drop lands above charlie rather than
  // after it — the same half-block rule the long-press path uses.
  const charlie = page.getByText('charlie', { exact: true }).first();
  await handle.dragTo(charlie, { targetPosition: { x: 4, y: 4 } });

  const changes = await waitForMessages(page, 'change');
  const content = changes[changes.length - 1].content as string;
  // Moved off the top, and STILL A HEADING — a re-fitted slice would have
  // unwrapped it into the surrounding paragraph.
  expect(content).toBe('bravo\n\n# alpha\n\ncharlie\n');
});

/* The DESKTOP half of "one boundary, one place to drop it".
 *
 * The indicator used to be @milkdown/kit/plugin/cursor's, which wraps
 * prosemirror-drop-indicator: its `getTargetsByView` pushes a target for every
 * block's TOP edge AND another for its BOTTOM edge, then picks the nearest
 * LINE. Block A's bottom and block B's top are one document position drawn at
 * two different y values, so every gap offered two visible slots that meant the
 * same thing. `blockDropIndicator.ts` replaced it with the resolver the
 * long-press path already used. */
gutterHandleTest(
  'the ⠿ handle draws ONE line per gap, in the gap, from either side',
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
// must draw no line either, since `handleDrop` already refuses to commit
// there (blockMove.ts isNoOpDrop).
gutterHandleTest(
  "the ⠿ handle's line hides while dragging over the block's own gaps",
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
    expect(await messagesOfType(page, 'change')).toHaveLength(0);
  },
);

/** A list-final document with its trailing newlines collapsed to one (see the
 * first list test below for why). */
const listOnly = (markdown: string): string => markdown.replace(/\n+$/, '\n');

/* Reordering INSIDE a list. The resolver used to know only top-level gaps, so
 * a list item — which lives one level down — drew no line at all, and the drop
 * fell through to ProseMirror's default, which re-fit the item as a second list
 * beside the first ("a break in between"). */
gutterHandleTest('the ⠿ handle moves a bullet to the end of its own list', async ({ page }) => {
  await hostSetContent(page, '- alpha\n- bravo\n- charlie');
  await clearMessages(page);

  // The SECOND item, whose handle plugin-block resolves to the item itself.
  const handle = await surfaceHandle(page, 'bravo', { item: true });
  const charlie = await itemBox(page, 'charlie');
  const drag = await startHandleDrag(page, handle);

  // charlie's lower half is the boundary after it: the list's end, drawn on
  // charlie's bottom edge — a line, where before there was none.
  await drag.over(charlie.x, charlie.bottom - 3);
  const line = await dropIndicatorTop(page);
  expect(line).not.toBeNull();
  expect(Math.abs((line as number) - charlie.bottom)).toBeLessThan(2);

  await drag.drop(charlie.x, charlie.bottom - 3);
  const changes = await waitForMessages(page, 'change');
  // ONE list, reordered — not two lists with a break between them. Trailing
  // newlines are normalized: @milkdown/kit/plugin/trailing keeps an empty
  // paragraph after a list-final document, which is upstream behaviour and
  // not what this asserts.
  expect(listOnly(changes[changes.length - 1].content as string)).toBe(
    '- alpha\n- charlie\n- bravo\n',
  );
});

/* plugin-block resolves a list's FIRST item to the list itself (the same rule
 * the gutter test above leans on), so the handle beside the first bullet
 * dragged every bullet. listItemHandleDrag.ts re-targets that drag to the
 * item under the handle. */
gutterHandleTest(
  'the ⠿ handle on the FIRST bullet drags that bullet, not the whole list',
  async ({ page }) => {
    await hostSetContent(page, '- alpha\n- bravo\n- charlie');
    await clearMessages(page);

    const handle = await surfaceHandle(page, 'alpha', { item: true });
    const charlie = await itemBox(page, 'charlie');
    const drag = await startHandleDrag(page, handle);

    await drag.over(charlie.x, charlie.bottom - 3);
    expect(await dropIndicatorTop(page)).not.toBeNull();
    await drag.drop(charlie.x, charlie.bottom - 3);

    const changes = await waitForMessages(page, 'change');
    expect(listOnly(changes[changes.length - 1].content as string)).toBe(
      '- bravo\n- charlie\n- alpha\n',
    );
  },
);

/* Leaving a list. Just below the list is still the list (two adjacent lists
 * are one list in markdown); past the next block is out. */
gutterHandleTest(
  'a bullet dragged just below its list joins its end; past the next block it leaves',
  async ({ page }) => {
    await hostSetContent(page, '- alpha\n- bravo\n\ncharlie');
    await clearMessages(page);

    let handle = await surfaceHandle(page, 'alpha', { item: true });
    const charlie = await blockBox(page, 'charlie');
    let drag = await startHandleDrag(page, handle);
    await drag.drop(charlie.x, charlie.top + 3);
    let changes = await waitForMessages(page, 'change');
    expect(changes[changes.length - 1].content).toBe('- bravo\n- alpha\n\ncharlie\n');

    await clearMessages(page);
    handle = await surfaceHandle(page, 'alpha', { item: true });
    drag = await startHandleDrag(page, handle);
    await drag.drop(charlie.x, charlie.bottom - 3);
    changes = await waitForMessages(page, 'change');
    expect(listOnly(changes[changes.length - 1].content as string)).toBe(
      '- bravo\n\ncharlie\n\n- alpha\n',
    );
  },
);

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
const mobileDndTest = base.extend<{ page: Page; cdp: CDPSession }>({
  page: async ({ browser }, use) => {
    const context = await browser.newContext({ hasTouch: true });
    await context.addInitScript(installFakeAndroidHost);
    const page = await context.newPage();
    await page.goto(EDITOR_URL);
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
});

// A tester reported the orange drop-indicator line showing through the ghost
// card while still holding a block over itself, which looked wrong on an
// empty paragraph (a blank rounded card with a line running through it). Two
// causes: the line drew for a drop that does nothing (either of the dragged
// block's own two boundaries), and the card and line raced for the same
// z-index. isNoOpDrop (blockMove.ts) fixes the first; the second is fixed by
// drawing the card OVER the line with a translucent background, so the line
// (and the dimmed source block) still read through it (mobileBlockDnd.ts).
mobileDndTest(
  "the drop line hides over the dragged block's own boundaries, and reads through the card",
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

// The other half of the same tester report: on Android, Chromium's own
// long-press forces focus onto the editable regardless of the page cancelling
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
  // large the browser's own document-boundary motion depends on scroll and
  // layout timing, so no keyboard shortcut puts the caret at a known offset. What matters is what the edit did to everything
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

/** The top-level block shapes of the live document, `p:empty` for an empty paragraph. */
async function topLevelShapes(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelector('.ProseMirror')?.children ?? []).map((el) => {
      const tag = el.tagName.toLowerCase();
      return tag === 'p' && el.textContent === '' ? 'p:empty' : tag;
    }),
  );
}

test('progressive open keeps the blank lines the author typed across a chunk seam', async ({
  page,
}) => {
  // An empty paragraph saves as an extra blank line (packages/editor/src/
  // milkdown-compat/emptyLine.ts). The planner cuts after blank runs and leaves
  // the run at the END of a chunk, where a standalone parse cannot see it, so
  // the loader has to re-insert those paragraphs itself. Two extra blank lines
  // deep inside a large note: exactly two empty paragraphs, at that spot.
  const halves = largeNote(400).split('## Section 200\n');
  const note = `${halves[0]}\n\n## Section 200\n${halves[1]}`;

  await initialize(page, hostConfig({ content: note }));
  await waitForStreamComplete(page);

  const shapes = await topLevelShapes(page);
  const empties = shapes.map((shape, i) => (shape === 'p:empty' ? i : -1)).filter((i) => i >= 0);
  expect(empties).toHaveLength(2);
  // Directly before the heading they precede.
  expect(shapes[empties[1] + 1]).toBe('h2');
  // textContent, not innerText: this asserts what the document holds, not
  // what happens to be laid out.
  expect(
    await page.evaluate(() => document.querySelectorAll('.ProseMirror h2')[200]?.textContent),
  ).toBe('Section 200');
});

test('progressive open does not grow a front-matter note by a blank line', async ({ page }) => {
  // Chunk 0 of such a note is the front matter alone, and the schema pads it
  // with an empty paragraph to satisfy `block+`. That paragraph is the schema's,
  // not the chunk's, and the whole-document parse never has it — four corpus
  // notes opened one blank line longer chunked than whole before this was told
  // apart from a chunk that really does end in an empty paragraph.
  const note = `---\ntitle: x\n---\n\n${largeNote()}`;

  await initialize(page, hostConfig({ content: note }));
  await waitForStreamComplete(page);

  const shapes = await topLevelShapes(page);
  expect(shapes[1]).toBe('h2');
  expect(shapes).not.toContain('p:empty');
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
 * Every top-level block is rendered eagerly: the editor applies no
 * `content-visibility` containment to its blocks. One ran on Chromium from
 * #106 until 2026-09-05, when eager rendering measured better on the low-end
 * Android reference phone on every axis — above all the FIRST focus of a large
 * note, which the skipped blocks stalled quadratically (12 s at 1,000 blocks; a
 * real tap froze the app). docs/plan/milkdown-transition.md §5 "Containment
 * retired" has the table. This locks the rule's ABSENCE, and the behavior a
 * large note must keep either way: the caret can move to the far end of the
 * document and land on real, rendered content.
 */
test('every block renders eagerly, and the caret can reach the far end of a large note', async ({
  page,
}) => {
  await initialize(page, hostConfig({ content: largeNote() }));
  await waitForStreamComplete(page);

  const styles = await page.evaluate(() => {
    const blocks = document.querySelectorAll('.ProseMirror > *');
    const middle = blocks[Math.floor(blocks.length / 2)] as Element;
    return {
      blocks: blocks.length,
      contentVisibility: getComputedStyle(middle).getPropertyValue('content-visibility'),
    };
  });
  expect(styles.blocks).toBeGreaterThan(400);
  expect(styles.contentVisibility).toBe('visible');

  // Caret into the far end of the document: place the selection there the way
  // in-app navigation does (a scrolled dispatch), then type with the real
  // keyboard. If caret entry or scroll anchoring broke, the keystroke would
  // land elsewhere or nowhere.
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

  /* The block the CARET landed in is genuinely rendered: its box sits inside
   * the scroller's viewport at its real laid-out size.
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
// half of that fix is parse SPEED. The cost was never the note's size: it was
// micromark's text resolver merging adjacent data events with one `splice` per
// run, which is quadratic in the number of runs — and a paragraph of
// single-newline lines produces one run per line. Patched to compact in one
// pass (patches/micromark@4.0.2.patch): 20,000 lines went 4.8 s -> 1.6 s and
// 50,000 went 18.1 s -> 0.9 s, linear in the note.
//
// There is deliberately NO cap and no read-only mode. An earlier attempt
// mounted a bounded read-only preview with a notice, and it was the wrong
// answer to the right measurement: a 4,280-line note is an ordinary pasted
// transcript, and telling its owner the editor cannot open it is a capitulation
// (docs/plan/milkdown-transition.md §5).

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

const HUGE_PARAGRAPH_LINES = 20_000;
/** Reference size for the CI-throughput calibration below: same generator,
 * same declined-chunking (`no-boundary`) code path, an order of magnitude
 * smaller so its own cost stays dominated by fixed per-open overhead rather
 * than the parse this test is actually guarding. */
const REFERENCE_LINES = 1_000;
/** A regression to the quadratic resolver blows straight through this. */
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
  // CI-2026-09: pipelines 35760-36709 measured THIS test between 2.5 s and
  // 12.7 s elapsed with no code change in between, while a local desktop
  // chromium run does the same 20,000-line open in ~0.5 s. That swing tracks
  // CI runner load, not the product — a fixed CI-only budget would chase a
  // moving target and need re-bumping every time contention shifts (M15).
  // Calibrate instead against a note built by the
  // SAME generator, an order of magnitude smaller, opened moments earlier in
  // this same page/runner: the per-line cost ratio rides out the runner's
  // throughput swings while still failing hard on the actual regression class
  // this test guards against — the quadratic resolver, which does not make
  // per-line cost a little worse, it makes per-line cost balloon with N.
  const referenceElapsed = await initializeTimed(page, oneParagraphNote(REFERENCE_LINES));
  const referencePerLine = referenceElapsed / REFERENCE_LINES;

  const note = oneParagraphNote(HUGE_PARAGRAPH_LINES);
  const elapsed = await initializeTimed(page, note);
  const perLine = elapsed / HUGE_PARAGRAPH_LINES;

  // Healthy (linear) parsing amortizes fixed overhead, so perLine at 20,000
  // lines is normally CHEAPER than at 1,000 (~0.64x locally) — reusing the
  // gauntlet's own cliff factor keeps one definition of "how much worse
  // before it's a cliff, not noise" instead of a second unaudited constant.
  expect(perLine).toBeLessThan(referencePerLine * PERFORMANCE_BUDGET.openCliffFactor);
  // Absolute backstop, not the primary gate: refuse a pathologically slow
  // open even if contention or GC pressure hit only the larger doc and hid
  // it from the ratio above. 15 s clears the worst runner contention seen in
  // the 2026-09 CI history (12.7 s) with margin, well under the job's 90 s
  // Playwright timeout, so this fires as a clear assertion instead of an
  // ambiguous suite timeout.
  expect(elapsed).toBeLessThan(15_000);
  // It really did mount something the user can read, rather than "opening" by
  // rendering nothing at all.
  expect(await page.locator('.ProseMirror').innerText()).toContain('Line 1 of this note');
});

test('a one-paragraph note of ordinary size opens fully editable', async ({ page }) => {
  const note = oneParagraphNote(2_000);

  const elapsed = await initializeTimed(page, note);

  expect(elapsed).toBeLessThan(OPEN_BUDGET_MS);
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

// ============================================================
// Transport, host config and theming
//
// Engine-independent halves of the bridge contract, moved here verbatim when
// `editor-embed-bridge.spec.ts` (the CodeMirror engine's copy) was deleted at
// the swap. They assert `bridge.ts`'s wiring, not any editor's behaviour, and
// were the only place that asserted it.
// ============================================================

test('prefers the iOS webkit transport when both hosts are present', async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true });
  await context.addInitScript(() => {
    const w = window as unknown as {
      __ios: BridgeMessage[];
      __android: BridgeMessage[];
      webkit: { messageHandlers: { futoBridge: { postMessage(m: BridgeMessage): void } } };
      futoBridge: { postMessage(json: string): void };
    };
    w.__ios = [];
    w.__android = [];
    w.webkit = { messageHandlers: { futoBridge: { postMessage: (m) => w.__ios.push(m) } } };
    w.futoBridge = { postMessage: (json) => w.__android.push(JSON.parse(json) as BridgeMessage) };
  });
  const page = await context.newPage();
  await page.goto(EDITOR_URL);
  await page.waitForFunction(() =>
    (window as unknown as { __ios: BridgeMessage[] }).__ios.some((m) => m.type === 'ready'),
  );

  const ios = await page.evaluate(() => (window as unknown as { __ios: BridgeMessage[] }).__ios);
  const android = await page.evaluate(
    () => (window as unknown as { __android: BridgeMessage[] }).__android,
  );
  expect(ios.filter((m) => m.type === 'ready')).toHaveLength(1);
  expect(ios[0].version).toBe(BRIDGE_VERSION);
  expect(android).toHaveLength(0);

  await context.close();
});

test('a stale host still gets a working editor, plus a version-mismatch report', async ({
  page,
}) => {
  // Refusing to boot would turn a build-hygiene mistake into a permanently
  // blank editor — see BridgeVersionMismatchMessage in bridge.ts.
  await clearMessages(page);

  await initialize(page, hostConfig({ bridgeVersion: 6, content: 'still editable' }));

  expect(await getContent(page)).toBe('still editable');
  expect(await messagesOfType(page, 'bridgeVersionMismatch')).toEqual([
    { type: 'bridgeVersionMismatch', hostVersion: 6, bundleVersion: BRIDGE_VERSION },
  ]);
  expect(await messagesOfType(page, 'initialized')).toHaveLength(1);
});

test('initialize suppresses the web toolbar for a shell that renders its own', async ({ page }) => {
  await initialize(page, hostConfig({ nativeToolbar: true }));
  expect(
    await page.evaluate(() => document.documentElement.classList.contains('futo-native')),
  ).toBe(true);

  await initialize(page, hostConfig({ nativeToolbar: false }));
  expect(
    await page.evaluate(() => document.documentElement.classList.contains('futo-native')),
  ).toBe(false);
});

test('setNativeToolbar(true) hides the embed web toolbar shown on focus', async ({ page }) => {
  await initialize(page, hostConfig({ nativeToolbar: false, content: 'doc' }));
  await page.evaluate(() => (window as unknown as FakeHostWindow).FutoEditor.focus());
  await flushFrames(page);
  // Default (no native toolbar): focusing the editor shows the web toolbar.
  await expect(page.locator('.markdown-toolbar')).toHaveCount(1);

  await page.evaluate(() =>
    (window as unknown as FakeHostWindow).FutoEditor.setNativeToolbar(true),
  );
  await flushFrames(page);
  await expect(page.locator('.markdown-toolbar')).toHaveCount(0);
  expect(
    await page.evaluate(() => document.documentElement.classList.contains('futo-native')),
  ).toBe(true);
});

test('setTheme flips the documentElement theme attribute', async ({ page }) => {
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');

  await page.evaluate(() => (window as unknown as FakeHostWindow).FutoEditor.setTheme('dark'));
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');

  await page.evaluate(() => (window as unknown as FakeHostWindow).FutoEditor.setTheme('light'));
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
});
