import { expect } from '@playwright/test';
import { BRIDGE_VERSION } from '@futo-notes/editor';
import {
  clearMessages,
  flushFrames,
  focusEditor,
  getContent,
  messagesOfType,
  waitForMessages,
  type FakeHostWindow,
} from './lib/editorEmbedHost';
import {
  settleChangeDebounce,
  test,
  hostConfig,
  initialize,
  hostSetContent,
  placeCaretInto,
} from './lib/editorEmbedMilkdown';

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
 *
 * The suite is split by surface: this file holds the handshake, content in and
 * out, focus and formatState; the rest live beside it as
 * `editor-embed-milkdown-<surface>.spec.ts` (front matter, undo, note switch,
 * the gutter-handle / long-press / drag-* block-drag files, progressive open,
 * parse cap, images, transport). They share the fixtures in
 * `tests/lib/editorEmbedMilkdown*.ts`, and this header is the scope for all of them.
 */

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

// docs/spec/editor.md "Markdown toolbar": dismissing the keyboard ends the
// editing session. A bare DOM blur kept the highlighted range (and, on a phone,
// its selection handles), and refocusing brought the whole range back.
test('blur() drops a highlighted range, and refocusing does not bring it back', async ({
  page,
}) => {
  await hostSetContent(page, 'alpha bravo charlie');
  const line = page.getByText('alpha bravo charlie');
  const box = await line.boundingBox();
  await line.dblclick({ position: { x: 4, y: box!.height / 2 } });
  // The precondition is "a non-collapsed range over the first word". Windows
  // Chromium's double-click also takes the trailing space ("alpha "), Linux and
  // macOS do not; both are the word, but "alpha bravo" or a caret are not.
  expect(await page.evaluate(() => document.getSelection()?.toString())).toMatch(/^alpha ?$/);

  await page.evaluate(() => (window as unknown as FakeHostWindow).FutoEditor.blur());
  await flushFrames(page);
  expect(await page.evaluate(() => document.getSelection()?.rangeCount)).toBe(0);

  await focusEditor(page);
  await flushFrames(page);
  expect(await page.evaluate(() => document.getSelection()?.isCollapsed)).toBe(true);
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
  await placeCaretInto(page, 3);
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
