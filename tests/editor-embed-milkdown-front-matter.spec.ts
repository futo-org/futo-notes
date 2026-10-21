// Part of the futoBridge Milkdown suite: scope and input rules are in
// editor-embed-milkdown.spec.ts.

import { expect } from '@playwright/test';
import { EDITOR_URL } from './editorEmbedBundle';
import {
  clearMessages,
  focusEditor,
  getContent,
  installFakeAndroidHost,
  waitForMessages,
  type FakeHostWindow,
} from './lib/editorEmbedHost';
import {
  settleChangeDebounce,
  test,
  hostSetContent,
  pasteClipboard,
} from './lib/editorEmbedMilkdown';

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
