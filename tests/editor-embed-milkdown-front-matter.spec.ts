// Part of the futoBridge Milkdown suite: scope and input rules are in
// editor-embed-milkdown.spec.ts.

import { expect, type Page } from '@playwright/test';
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
import { caretAtEndOf, caretAtStartOf } from './lib/editorEmbedMilkdownInteractive';

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

// ProseMirror's gap cursor counted the doc start as a gap a paragraph could
// fill, because nothing it checks looks past the front matter that has to come
// first. ArrowUp (or ArrowLeft) from the top of the body put a gap cursor
// there, and the next keystroke went nowhere: a paragraph cannot sit above the
// metadata, so the insert was dropped and the file never changed.
for (const key of ['ArrowUp', 'ArrowLeft']) {
  test(`${key} from the top of the body keeps the caret in the body`, async ({ page }) => {
    await hostSetContent(page, FRONT_MATTER_NOTE);
    await caretAtStartOf(page, 'Body');
    await page.keyboard.press(key);
    await page.keyboard.type('X');
    await settleChangeDebounce(page);

    expect(await getContent(page)).toBe(FRONT_MATTER_NOTE.replace('# Body', '# XBody'));
    await expect(page.locator('.ProseMirror-gapcursor')).toHaveCount(0);
  });
}

test('ArrowUp from the empty body of a front-matter-only note keeps the caret there', async ({
  page,
}) => {
  await hostSetContent(page, '---\na: 1\n---\n');
  await page.locator('.ProseMirror > p').click();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.type('X');
  await settleChangeDebounce(page);

  expect(await getContent(page)).toBe('---\na: 1\n---\n\nX\n');
});

// The browser's own Ctrl+Home looks for the first caret position in the
// editable host and finds the `contenteditable="false"` metadata panel there,
// so it did nothing at all and the next keystroke landed where the caret was.
for (const key of ['Control+Home', 'Meta+ArrowUp']) {
  test(`${key} moves the caret to the top of the body`, async ({ page }) => {
    await hostSetContent(page, FRONT_MATTER_NOTE);
    await caretAtEndOf(page, 'Content after front matter.');
    await page.keyboard.press(key);
    await page.keyboard.type('X');
    await settleChangeDebounce(page);

    expect(await getContent(page)).toBe(FRONT_MATTER_NOTE.replace('# Body', '# XBody'));
  });
}

test('Ctrl+Shift+Home selects from the caret to the top of the body', async ({ page }) => {
  await hostSetContent(page, FRONT_MATTER_NOTE);
  await caretAtEndOf(page, 'Content after front matter.');
  await page.keyboard.press('Control+Shift+Home');
  await page.keyboard.type('X');
  await settleChangeDebounce(page);

  expect(await getContent(page)).toBe(
    '---\ntitle: Front Matter Test\ntags: [a, b]\ndate: 2026-09-01\n---\n\n# X\n',
  );
});

// A divider is a selectable leaf, so "the first place in the body" next to one
// is a NODE selection on it, and the next keystroke replaced it: Ctrl+Home, a
// click on the panel, or a click in the padding above it, then `X`, deleted the
// divider. The body start there is the gap in front of the divider, where
// typing makes a new paragraph — what Ctrl+Home does in a note without front
// matter.
const DIVIDER_FIRST_NOTE = '---\ntitle: T\ntags: [a, b]\n---\n\n***\n\npara\n';
const routesToBodyStart: [string, (page: Page) => Promise<void>][] = [
  [
    'Control+Home',
    async (page) => {
      await caretAtEndOf(page, 'para');
      await page.keyboard.press('Control+Home');
    },
  ],
  ['a click on the panel', (page) => page.locator('.futo-frontmatter').click()],
  [
    'a click in the padding above the panel',
    async (page) => {
      const box = await page.locator('.ProseMirror').boundingBox();
      if (!box) throw new Error('editor has no box');
      await page.mouse.click(box.x + 5, box.y + 1);
    },
  ],
];
for (const [route, reach] of routesToBodyStart) {
  test(`${route} in a note whose body opens with a divider keeps the divider`, async ({ page }) => {
    await hostSetContent(page, DIVIDER_FIRST_NOTE);
    await reach(page);
    await page.keyboard.type('X');
    await settleChangeDebounce(page);

    expect(await getContent(page)).toBe('---\ntitle: T\ntags: [a, b]\n---\n\nX\n\n---\n\npara\n');
  });
}

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
