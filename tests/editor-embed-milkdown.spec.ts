import { expect, type Page } from '@playwright/test';

import { BRIDGE_VERSION } from '@futo-notes/editor';

import { EDITOR_URL } from './editorEmbedBundle';
import {
  type BridgeMessage,
  clearMessages,
  flushFrames,
  focusEditor,
  getContent,
  installFakeAndroidHost,
  messages,
  messagesOfType,
  waitForMessages,
  withCaretObserved,
  type FakeHostWindow,
} from './lib/editorEmbedHost';
import {
  embedTest,
  hostConfig,
  hostSetContent,
  initialize,
  largeNote,
  settleChangeDebounce,
} from './lib/editorEmbedSpec';

/**
 * futoBridge contract, Milkdown engine — executable.
 *
 * `editor.html` mounts the Milkdown (ProseMirror) WYSIWYG editor both native
 * shells ship; this file is its bridge contract.
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
 * Plus `formatState` (native toolbar highlighting), a surface the Milkdown work
 * added to the bridge. The other, `haptic`, belongs to the block drag, which is
 * `editor-embed-milkdown-block-drag.spec.ts`; opening a large note
 * progressively is `editor-embed-milkdown-progressive.spec.ts`.
 *
 * Plus images (#103): vault-relative rendering and clipboard paste, which one
 * bundle settles for all three shells.
 *
 * NOT here: toolbar command parity (#104), wikilinks (#101) and tags/task
 * checkboxes/fence highlighting (#102) have their own files,
 * `editor-embed-milkdown-toolbar.spec.ts`,
 * `editor-embed-milkdown-wikilinks.spec.ts` and
 * `editor-embed-milkdown-parity.spec.ts`.
 *
 * Real user input only: Playwright keyboard/mouse, not DOM `dispatchEvent`
 * (AGENTS.md M21).
 *
 * The ONE exception is clipboard image paste, and it is a limit of the tool, not
 * a shortcut: nothing in Playwright or CDP can put an image on the OS clipboard,
 * so `Ctrl+V` has nothing to paste. A dispatched `ClipboardEvent` carrying a
 * real `DataTransfer` is as close to the real thing as this harness reaches, and
 * it still goes through ProseMirror's own paste handling rather than calling the
 * editor's handler directly. What it therefore cannot prove is that a given
 * WebView exposes the bitmap on the event at all — that is what the `pasteClipboardImage`
 * fallback exists for, and it is a device check.
 */

const test = embedTest;

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
// nothing in the parser recognizing it, `---` was a thematic break and the
// metadata lines a setext heading, so ANY edit elsewhere in the note wrote back
// `***`, a 16-dash underline, and — the real harm — `tags: \[a, b]`, a changed
// metadata VALUE. ADR-0002 accepts re-spelled markdown; it does not accept losing
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

test('a note that opens with an unclosed --- rule keeps its lists and quotes', async ({ page }) => {
  // With no closing fence the `---` is a thematic break (docs/spec/editor.md,
  // YAML front matter). The front matter construct used to hunt for the fence
  // to the end of the file and take every container with it, so the first
  // keystroke anywhere saved `\- milk` and `\> quoted`, nesting flattened.
  const note = '---\n\nShopping\n\n- milk\n  - skim\n\n> quoted\n\nend\n';
  await hostSetContent(page, note);
  await expect(page.locator('.ProseMirror ul li')).toHaveCount(2);
  await expect(page.locator('.ProseMirror blockquote')).toHaveCount(1);
  await clearMessages(page);

  await focusEditor(page);
  await page.keyboard.press('Control+End');
  await page.keyboard.type('X');

  const changes = await waitForMessages(page, 'change');
  expect(changes).toHaveLength(1);
  expect(changes[0].content).toBe('---\n\nShopping\n\n- milk\n  - skim\n\n> quoted\n\nendX\n');
});

// A paste reaches the document through the DOM: our own copy writes the block
// as `<pre data-frontmatter>`, and a plain-text paste is parsed as markdown and
// then serialized to DOM and parsed back (Milkdown's clipboard plugin). The
// preset's code block claims every `<pre>`, so either way the metadata used to
// land as a fenced code block.
test('cutting a whole note and pasting it back keeps its front matter', async ({ browser }) => {
  const context = await browser.newContext({
    hasTouch: true,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  await context.addInitScript(installFakeAndroidHost);
  const page = await context.newPage();
  await page.goto(EDITOR_URL);
  await page.waitForFunction(() =>
    (window as unknown as FakeHostWindow).__msgs?.some((m) => m.type === 'ready'),
  );
  await hostSetContent(page, FRONT_MATTER_NOTE);
  await focusEditor(page);
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('ControlOrMeta+x');
  await page.keyboard.press('ControlOrMeta+v');
  await settleChangeDebounce(page);

  expect(await getContent(page)).toBe(FRONT_MATTER_NOTE);
  await expect(page.locator('.futo-frontmatter')).toHaveCount(1);
  await context.close();
});

test('pasting a note with front matter as plain text keeps the front matter', async ({ page }) => {
  await hostSetContent(page, '');
  await focusEditor(page);
  await pasteClipboard(page, { 'text/plain': FRONT_MATTER_NOTE });
  await settleChangeDebounce(page);

  await expect(page.locator('.futo-frontmatter')).toHaveCount(1);
  expect(await getContent(page)).toBe(FRONT_MATTER_NOTE);
});

test('front matter pasted where it cannot live keeps its text', async ({ page }) => {
  // Front matter can only open a note, and a paste drops a block that fits
  // nowhere — so once the block's parse rule won, mid-note front matter would
  // have vanished. It lands as a code block of the same text instead.
  await hostSetContent(page, 'one\n\ntwo\n');
  await focusEditor(page);
  await page.keyboard.press('Control+End');
  await pasteClipboard(page, { 'text/plain': '---\na: 1\n---\n\nbody\n' });
  await pasteClipboard(page, {
    'text/html': '<pre data-frontmatter="">b: 2</pre><p>more</p>',
    'text/plain': 'b: 2',
  });
  await settleChangeDebounce(page);

  expect(await getContent(page)).toBe(
    'one\n\ntwo\n\n```\na: 1\n```\n\nbody\n\n```\nb: 2\n```\n\nmore\n',
  );
});

test('an edit keeps a link definition nothing references', async ({ page }) => {
  // The preset deleted every definition on the first save; one that no link
  // used took its URL and title with it (RC-41).
  const note = 'Some text here.\n\n[docs]: https://example.com/docs "Docs"\n';
  await hostSetContent(page, note);
  await clearMessages(page);

  await page.locator('.ProseMirror p').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type('!');

  const changes = await waitForMessages(page, 'change');
  expect(changes).toHaveLength(1);
  expect(changes[0].content).toBe(note.replace('here.', 'here.!'));
});

test('an edit beside a table with a wide row keeps every value in its column', async ({ page }) => {
  // One trailing `| |` made fixTables pad every row above it at the START, and
  // the edit elsewhere saved `apple` under no header at all (RC-42).
  await hostSetContent(
    page,
    'Prices\n\n| item | price |\n| - | - |\n| apple | 3 |\n| pear | 4 | |\n\nend\n',
  );
  await clearMessages(page);

  await page.locator('.ProseMirror p').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type('!');

  const changes = await waitForMessages(page, 'change');
  expect(changes).toHaveLength(1);
  expect(changes[0].content).toBe(
    'Prices!\n\n| item | price |  |\n| --- | --- | --- |\n| apple | 3 |  |\n| pear | 4 |  |\n\nend\n',
  );
});

test('an edit to a note that ends in a list adds no trailing blank line', async ({ page }) => {
  // The `trailing` plugin parks an empty paragraph below a last list, quote,
  // table, fence or rule, and the first edit used to write it as `\n\n` at the
  // end of the file (RC-22). The spec drops a trailing empty paragraph on save.
  for (const [note, edited] of [
    ['- a\n- b\n', '- aX\n- b\n'],
    ['> a\n', '> aX\n'],
    ['| a | b |\n| --- | --- |\n| 1 | 2 |\n', '| aX | b |\n| --- | --- |\n| 1 | 2 |\n'],
  ] as const) {
    await hostSetContent(page, note);
    await clearMessages(page);
    await page.locator('.ProseMirror :is(li, blockquote, th) p').first().click();
    await page.keyboard.press('End');
    await page.keyboard.type('X');
    const changes = await waitForMessages(page, 'change');
    expect(changes[changes.length - 1].content).toBe(edited);
  }
});

test('a table pasted as plain text is written the way an opened one is', async ({ page }) => {
  // A paste goes through the DOM, where the gfm preset read a cell with no
  // alignment back as `left`: the pasted table saved `| :- |`, the same table
  // opened and edited saved `| -- |` (RC-59). Into an empty note the paste
  // takes the empty line: Milkdown's plain-text route used to keep it, saving a
  // blank line above the table.
  const table = '| a | b |\n| --- | --- |\n| 1 | 2 |\n';
  for (const [note, expected] of [
    ['one\n', `one\n\n${table}`],
    ['', table],
  ] as const) {
    await hostSetContent(page, note);
    await focusEditor(page);
    await page.keyboard.press('Control+End');
    await pasteClipboard(page, { 'text/plain': table });
    await settleChangeDebounce(page);

    expect(await getContent(page)).toBe(expected);
  }
});

test('applyExternalContent adopts differing content without a change echo', async ({ page }) => {
  await hostSetContent(page, 'original');
  await clearMessages(page);

  await page.evaluate(() =>
    (window as unknown as FakeHostWindow).FutoEditor.applyExternalContent(
      'test-note',
      'adopted from a peer',
      (window as unknown as FakeHostWindow).__futoTest.documentRef().generation,
    ),
  );
  await settleChangeDebounce(page);

  expect(await getContent(page)).toBe('adopted from a peer');
  expect(await messagesOfType(page, 'change')).toHaveLength(0);
});

/**
 * Puts the caret `chars` characters into the first paragraph, and returns once
 * the EDITOR has read it (`withCaretObserved`).
 *
 * The caret is set on the DOM selection, not clicked at a pixel measured from
 * a Range: where a click lands depends on the glyph advances at that instant,
 * and the embed's fonts are swapped in asynchronously (`warmEditorFonts.ts`),
 * which `document.fonts.ready` did not make the measurement safe from. The
 * callers are about what the host does to a caret that is somewhere in the
 * text, not about where a click maps. Observed as an intermittent red on
 * "applyExternalContent with unchanged content preserves the selection" (CI,
 * test:e2e:editor-embed 2/3): "abcdefZ" for "abcZdef", the caret still at the
 * end where `focus()` left it. Not reproducible locally in 300 loaded runs,
 * so a click that missed the text is the likely cause, not a proven one; the
 * product's identical-content path never touches the selection.
 */
async function placeCaretInto(page: Page, chars: number): Promise<void> {
  await withCaretObserved(page, () =>
    page.evaluate((offset) => {
      const text = document.querySelector('.ProseMirror > p')?.firstChild;
      if (!text) throw new Error('no paragraph text node');
      window.getSelection()!.collapse(text, offset);
    }, chars),
  );
}

test('applyExternalContent with unchanged content preserves the selection', async ({ page }) => {
  await hostSetContent(page, 'abcdef');
  await focusEditor(page);
  await placeCaretInto(page, 3);
  await clearMessages(page);

  // No-op adopt (content identical): must not reset the caret to 0 or the end.
  await page.evaluate(() =>
    (window as unknown as FakeHostWindow).FutoEditor.applyExternalContent(
      'test-note',
      'abcdef',
      (window as unknown as FakeHostWindow).__futoTest.documentRef().generation,
    ),
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
 * RC-60 (L3-5): an undo that brings a divider back is not the user creating a
 * divider. `dividerCaret` used to read the restored `hr` as new and append an
 * empty paragraph after it, so undoing "type over a selected divider" left the
 * note one blank line longer than it was opened. Real input only: a mouse click
 * on the rule is how a user selects a divider (a click on a block atom is a
 * NodeSelection; ArrowDown steps natively PAST the rule), then typed letters
 * replace it.
 */
test('undoing a keystroke typed over a selected divider restores the note exactly', async ({
  page,
}) => {
  // The house style's spelling of the rule, so an exact restore is the same bytes.
  const note = 'first\n\n---\n\nlast\n';
  await hostSetContent(page, note);
  await page.locator('.ProseMirror hr').click();
  await page.keyboard.type('hello');
  await waitForMessages(page, 'change');
  expect(await getContent(page)).toContain('hello');
  expect(await getContent(page)).not.toContain('---');

  for (let i = 0; i < 20; i++) await page.keyboard.press('ControlOrMeta+z');
  await settleChangeDebounce(page);

  expect(await getContent(page)).toBe(note);

  // Redo puts the edit back, and undoing it again is exact once more.
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await settleChangeDebounce(page);
  expect(await getContent(page)).toContain('h');
  expect(await getContent(page)).not.toContain('---');
  for (let i = 0; i < 20; i++) await page.keyboard.press('ControlOrMeta+z');
  await settleChangeDebounce(page);
  expect(await getContent(page)).toBe(note);
});

/*
 * RC-54 (L3-6): Ctrl-Z after an adopt threw `RangeError: Position N out of range`.
 * The adopt was incidental. An undo that restores a divider ran `dividerCaret`,
 * whose `appendTransaction` added an empty paragraph to the replay; that
 * paragraph is in no history event, so every OLDER event that sat below it in
 * the document was now two positions off, its inverse steps no longer fitted
 * ("Inconsistent open depths"), and resolving its selection bookmark ran past the
 * end of the document. It needs the divider event to have an earlier event
 * below it, which is why a lone undo (RC-60's case above) never showed it.
 */
test('undoing everything after an adopt, a later edit and a keystroke over a divider is exact', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // The house style's spelling of the rule, so an exact undo is the same bytes.
  await hostSetContent(page, 'first\n\n---\n\nlast\n');
  await page.evaluate(() =>
    (window as unknown as FakeHostWindow).FutoEditor.applyExternalContent(
      'test-note',
      'first peer\n\n---\n\nlast\n',
      (window as unknown as FakeHostWindow).__futoTest.documentRef().generation,
    ),
  );
  await flushFrames(page);
  const adopted = 'first peer\n\n---\n\nlast\n';

  // An edit BELOW the divider, then one over it.
  await page.getByText('last', { exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' one');
  await page.locator('.ProseMirror hr').click();
  await page.keyboard.type('hello');
  await settleChangeDebounce(page);
  expect(await getContent(page)).toContain('hello');

  for (let i = 0; i < 30; i++) await page.keyboard.press('ControlOrMeta+z');
  await settleChangeDebounce(page);

  expect(errors).toEqual([]);
  expect(await getContent(page)).toBe(adopted);
});

test('undo and redo of a typed `---` leave the divider note byte-stable', async ({ page }) => {
  await hostSetContent(page, 'above\n\n');
  await focusEditor(page);
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('---');
  await settleChangeDebounce(page);
  const made = await getContent(page);
  // A rule, written `---`; typed text that stayed text would be `\---`.
  expect(made).toMatch(/^---$/m);

  await page.keyboard.press('ControlOrMeta+z');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await settleChangeDebounce(page);

  expect(await getContent(page)).toBe(made);
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
    (window as unknown as FakeHostWindow).FutoEditor.applyExternalContent(
      'test-note',
      'theirs\n',
      (window as unknown as FakeHostWindow).__futoTest.documentRef().generation,
    ),
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
// Note switch — the outgoing note's edit belongs to the outgoing note
// ============================================================
//
// Both shells share ONE WebView between notes, and a `change` carries no note
// identity: whichever note the shell has bound when it ARRIVES is the note it
// is saved into. So the shell reads the outgoing note (`blur(); getContent()`)
// before the next note's push — Android in its exit before it navigates, iOS
// also inside the attach that rebinds its callbacks (EditorWebView.swift
// `attach`, which then holds back any `change` until that read answers).
// Everything below is the bundle's half of that contract: the read is the
// outgoing note's last word — whatever it still had to report goes out inside
// the read, nothing after it — and the switch itself posts nothing.
// `__switch` in the message log marks the point from which the shell is
// listening for the NEXT note.
// → docs/qa/wikilink-pop-large-edited-note.md

const LINKING_NOTE = 'Parent note body\n\n[[Child]]\n';
const LINKED_NOTE = 'Child note body\n';

/** Every `change` posted after the `__switch` marker. */
async function changesAfterSwitch(page: Page): Promise<string[]> {
  const log = await messages(page);
  const at = log.findIndex((m) => m.type === '__switch');
  expect(at, 'the test never marked the switch').toBeGreaterThanOrEqual(0);
  return log
    .slice(at + 1)
    .filter((m) => m.type === 'change')
    .map((m) => m.content as string);
}

/** The shell's exit read of the outgoing note, after which it listens for the next one. */
async function flushOutgoingNote(page: Page): Promise<{ body: string; streaming: boolean }> {
  return page.evaluate(() => {
    const w = window as unknown as FakeHostWindow;
    const streaming = document.querySelector('.milkdown-stream-tail') !== null;
    w.FutoEditor.blur();
    w.FutoEditor.flush('exit');
    const body = String(w.__msgs.filter((m) => m.type === 'change').at(-1)?.content);
    w.__msgs.push({ type: '__switch' });
    return { body, streaming };
  });
}

/**
 * Follow a link from the linking note to `linked` (a host push) and type into
 * it. A large note is typed into at the caret `focus()` leaves, straight away,
 * so the keystrokes land while its tail is still streaming.
 */
async function openLinkedNoteAndType(page: Page, linked: string, typed: string): Promise<void> {
  await initialize(page, hostConfig({ content: LINKING_NOTE }));
  await page.evaluate((md) => {
    const w = window as unknown as FakeHostWindow;
    w.FutoEditor.setContent('test-note', md);
    w.__msgs.length = 0;
    w.FutoEditor.focus();
  }, linked);
  if (linked === LINKED_NOTE) await page.keyboard.press('End');
  await page.keyboard.type(typed);
}

const STILL_STREAMING = 'the linked note must still be streaming for this case to mean anything';

test('switching notes reports the edited streaming document under its outgoing identity', async ({
  page,
}) => {
  // RC-04: the switch's own "is this already on screen?" read used to settle
  // the stream and post the linked note's whole body INSIDE the push of the
  // linking note, which iOS had already rebound its callbacks to — the parent
  // file was overwritten with the child's body.
  await openLinkedNoteAndType(page, largeNote(4000), 'EDITED ');

  const streaming = await page.evaluate((md) => {
    const w = window as unknown as FakeHostWindow;
    const tail = document.querySelector('.milkdown-stream-tail') !== null;
    w.__msgs.push({ type: '__switch' });
    w.FutoEditor.setContent('parent', md);
    return tail;
  }, LINKING_NOTE);
  await settleChangeDebounce(page);

  expect(streaming, STILL_STREAMING).toBe(true);
  expect((await messagesOfType(page, 'change')).at(-1)).toEqual(
    // `EDITED`, not `EDITED `: the caret ends a paragraph, and a save writes no
    // whitespace at a line's end (docs/spec/editor.md "Markdown house style").
    expect.objectContaining({ noteId: 'test-note', content: expect.stringContaining('EDITED') }),
  );
  expect(await getContent(page)).toBe(LINKING_NOTE);
});

test('an exit flush reports the complete edited streaming document', async ({ page }) => {
  await openLinkedNoteAndType(page, largeNote(4000), 'EDITED ');

  const captured = await flushOutgoingNote(page);
  await hostSetContent(page, LINKING_NOTE);

  expect(captured.streaming, STILL_STREAMING).toBe(true);
  // No trailing space: a save writes no whitespace at a line's end.
  expect(captured.body).toContain('EDITED');
  expect(captured.body).toContain('Section 3999');
  // A `change` for the edit now would reach the next note's binding.
  expect(await changesAfterSwitch(page)).toEqual([]);
  expect(await getContent(page)).toBe(LINKING_NOTE);
});

test('an exit flush reports the pending change once before the switch', async ({ page }) => {
  // RC-09 / L6c-3: typing, then leaving inside the change debounce. The read
  // carries the typed words, and so does a report posted INSIDE it, to the
  // binding that is still the outgoing note's. The debounce armed by the last
  // keystroke must not fire afterwards, however late the next note's push.
  await openLinkedNoteAndType(page, LINKED_NOTE, ' plus typed words');

  const captured = await flushOutgoingNote(page);
  await settleChangeDebounce(page);
  await hostSetContent(page, LINKING_NOTE);

  expect(captured.body).toContain('plus typed words');
  const log = await messages(page);
  const beforeSwitch = log
    .slice(
      0,
      log.findIndex((m) => m.type === '__switch'),
    )
    .filter((m) => m.type === 'change')
    .map((m) => m.content);
  expect(beforeSwitch).toEqual([captured.body, captured.body]);
  expect(await changesAfterSwitch(page)).toEqual([]);
  expect(await getContent(page)).toBe(LINKING_NOTE);
});

test('a switch inside the change debounce shows the next note, even with the same bytes', async ({
  page,
}) => {
  // L6a-1: two new, empty notes. The switch used to be compared against what
  // the host last loaded ('') instead of the live document, so it was
  // swallowed: the first note's text stayed on screen and was then posted as
  // the second note's change.
  await initialize(page, hostConfig({ content: '' }));
  await focusEditor(page);
  await page.keyboard.type('typed into the first note');

  const changesBeforeSwitch = await page.evaluate(() => {
    const w = window as unknown as FakeHostWindow;
    const before = w.__msgs.filter((m) => m.type === 'change').length;
    w.__msgs.push({ type: '__switch' });
    w.FutoEditor.setContent('next-note', '');
    return before;
  });
  expect(changesBeforeSwitch, 'the switch must land inside the debounce').toBe(0);
  await settleChangeDebounce(page);

  expect(await getContent(page)).toBe('');
  expect((await messagesOfType(page, 'change')).at(-1)).toEqual(
    expect.objectContaining({
      noteId: 'test-note',
      content: expect.stringContaining('typed into the first note'),
    }),
  );
});

test('a host re-sending the note on screen leaves the caret where it was', async ({ page }) => {
  await hostSetContent(page, 'abcdef');
  await focusEditor(page);
  await placeCaretInto(page, 3);

  await page.evaluate(() =>
    (window as unknown as FakeHostWindow).FutoEditor.setContent('test-note', 'abcdef'),
  );
  await flushFrames(page);
  await page.keyboard.type('Z');

  await waitForMessages(page, 'change');
  expect(await getContent(page)).toBe('abcZdef\n');
});

test('a switch to an empty note drops the blank paragraphs the last note was left with', async ({
  page,
}) => {
  // RC-22 regression: trailing empty paragraphs are not written, so a note the
  // user pressed Enter in serializes like a note without them, and the switch
  // was skipped as "already on screen" with the blanks still there.
  await initialize(page, hostConfig({ content: '' }));
  await focusEditor(page);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await settleChangeDebounce(page);

  await hostSetContent(page, '');
  await focusEditor(page);
  await page.keyboard.type('shopping');
  await settleChangeDebounce(page);

  expect(await getContent(page)).toBe('shopping\n');
});

test('a switch to the same text drops the blank paragraphs stacked under it', async ({ page }) => {
  await hostSetContent(page, 'hello\n');
  await focusEditor(page);
  await page.keyboard.press('ControlOrMeta+End');
  // The first Enter is a newline; each one after it is a paragraph.
  for (let i = 0; i < 4; i++) await page.keyboard.press('Enter');
  await settleChangeDebounce(page);
  expect(await page.locator('.ProseMirror > p').count()).toBe(4);

  await hostSetContent(page, 'hello\n');

  expect(await page.locator('.ProseMirror > p').count()).toBe(1);
  expect(await getContent(page)).toBe('hello\n');
});

test('a switch to the same text drops an empty line typed at the end of the note', async ({
  page,
}) => {
  // A newline at the very end of a paragraph is not written either, so the
  // document serializes like the note without it.
  await hostSetContent(page, 'hello\n');
  await focusEditor(page);
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await settleChangeDebounce(page);
  expect(await page.locator('.ProseMirror > p').first().innerText()).toBe('hello\n\n');

  await hostSetContent(page, 'hello\n');

  expect(await page.locator('.ProseMirror > p').first().innerText()).toBe('hello');
  expect(await getContent(page)).toBe('hello\n');
});

test('a push equal to an out-of-date serialization still replaces the document', async ({
  page,
}) => {
  // L6a-1, second shape: the last REPORTED text is not the live document once
  // the user has typed past it.
  await hostSetContent(page, 'seed');
  await focusEditor(page);
  await page.keyboard.press('End');
  await page.keyboard.type(' one');
  await waitForMessages(page, 'change');
  await page.keyboard.type(' two');

  await hostSetContent(page, 'seed one\n');

  expect(await getContent(page)).toBe('seed one\n');
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
 * and the app's own filenames never contain one (`image_commands::write_image`). This
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

test('an image with no title still passes the schema validator', async ({ page }) => {
  // mdast gives `![a](b.png)` `title: null`; the image attr validates as a
  // string, so `doc.check()` and `nodeFromJSON()` threw on ordinary notes (RC-31).
  await initialize(page, hostConfig({ content: '![a](b.png)\n\n![c](d.png "cap")\n' }));
  await flushFrames(page);
  const result = await page.evaluate(() => {
    const view = (
      window as unknown as {
        __futoProseMirrorView: () => {
          state: {
            doc: { check(): void; toJSON(): unknown };
            schema: { nodeFromJSON(json: unknown): { check(): void } };
          };
        };
      }
    ).__futoProseMirrorView();
    const errors: string[] = [];
    try {
      view.state.doc.check();
    } catch (e) {
      errors.push(`check: ${(e as Error).message}`);
    }
    try {
      view.state.schema.nodeFromJSON(view.state.doc.toJSON()).check();
    } catch (e) {
      errors.push(`nodeFromJSON: ${(e as Error).message}`);
    }
    return errors;
  });
  expect(result).toEqual([]);
  // ...and the title survives where there is one, and is not invented where not.
  expect(await getContent(page)).toBe('![a](b.png)\n\n![c](d.png "cap")\n');
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
  build: 'imageFile' | 'hiddenBitmap' | 'plainText' | Record<string, string>,
): Promise<void> {
  await page.evaluate((kind) => {
    const dt = new DataTransfer();
    if (typeof kind === 'object') {
      for (const [format, data] of Object.entries(kind)) dt.setData(format, data);
    } else if (kind === 'imageFile') {
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
// Engine-independent halves of the bridge contract. They assert `bridge.ts`'s
// wiring, not any editor's behavior, and are the only place that asserts it.
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
