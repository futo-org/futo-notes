/**
 * Editing-surface parity, Milkdown engine — tags, task checkboxes, and fenced
 * code highlighting, driven against the single-file `editor.html` the native
 * shells actually ship (issue #102, docs/plan/milkdown-transition.md §4
 * bucket 1).
 *
 * The bridge contract and the load-echo/undo data-safety invariants live in
 * `editor-embed-milkdown.spec.ts`; this file is the three editing surfaces and
 * nothing else.
 *
 * Real input only, and both kinds of it: Playwright mouse for the desktop
 * story and CDP `Input.dispatchTouchEvent` for the phone story. A DOM
 * `dispatchEvent` would sail past the very listeners under test (AGENTS.md
 * M21), and mouse-only coverage would have missed the thing that actually
 * matters on a phone — that tapping a checkbox does not raise the keyboard.
 */

import { expect, type Page } from '@playwright/test';
import { extractHeaderTagBlock, extractTags } from '../packages/editor/src/tags';
import { getContent, type FakeHostWindow } from './lib/editorEmbedHost';
import { test, CHANGE_DEBOUNCE_MS, open, typeAtEnd } from './lib/editorEmbedMilkdownParity';

// ============================================================
// Tags
// ============================================================

/*
 * The one that is data safety, not decoration. remark-stringify escaped any
 * line-leading `#`, so before the escape was narrowed (and later decided by a
 * parse, in the editor's own serializer) the first edit to a note turned its
 * header tag block `#alpha #beta` into `\#alpha #beta` — and `\#alpha` is a tag
 * to nothing: not to this app's rule, not to the desktop tag bar, not to
 * Obsidian. The tag was gone from the note.
 */
test('editing a note never escapes its tags away', async ({ page }) => {
  await open(page, '#alpha #beta\n\nBody text\n');

  await typeAtEnd(page);

  const saved = await getContent(page);
  expect(saved).toContain('#alpha #beta');
  expect(saved).not.toContain('\\#');
});

test('the tag rules still read every tag out of what Milkdown saved', async ({ page }) => {
  const original = '#alpha #beta\n\nBody with #inline and a #trailing.\n';
  await open(page, original);

  await typeAtEnd(page);
  const saved = await getContent(page);

  // The desktop tag bar is built from exactly these two rules, so this is what
  // "the tag bar behaves per spec" reduces to once the editor has re-saved.
  expect(extractTags(saved)).toEqual(extractTags(original));
  expect(extractHeaderTagBlock(saved).tags).toEqual(extractHeaderTagBlock(original).tags);
});

/*
 * The same class of loss, one character over: remark-stringify escaped EVERY
 * `_` in prose, so a keystroke anywhere rewrote `snake_case_word` and turned
 * `#dog_problems` into `#dog\_problems` — a tag to nothing, and on desktop the
 * tag bar (which commits through a full re-serialization) then dropped every
 * chip on the note. The editor's own serializer escapes a `_` only where a
 * parse says it would open emphasis.
 */
test('editing a note never escapes the underscore inside a word or a tag', async ({ page }) => {
  const original =
    '#dog_problems #alpha\n\nsnake_case_word and file_name.txt, but _real_ emphasis\n';
  await open(page, original);

  await typeAtEnd(page);
  const saved = await getContent(page);

  expect(saved).toContain('#dog_problems #alpha');
  expect(saved).toContain('snake_case_word and file_name.txt');
  expect(saved).not.toContain('\\_');
  // `_real_` is emphasis, and stays emphasis (Milkdown spells it `*real*`).
  expect(saved).toMatch(/but [*_]real[*_] emphasis/);
  expect(extractTags(saved)).toEqual(extractTags(original));
});

test('a line-leading `#` that IS a heading still round-trips as a heading', async ({ page }) => {
  await open(page, '# A real heading\n\nbody\n');
  await typeAtEnd(page);
  expect(await getContent(page)).toContain('# A real heading');
  await expect(page.locator('.ProseMirror h1')).toHaveText('A real heading');
});

test('an inline tag is decorated', async ({ page }) => {
  await open(page, 'Some #project work here\n');
  await expect(page.locator('.ProseMirror .futo-tag')).toHaveText('#project');
});

test('a tag inside inline code or a fence is not decorated', async ({ page }) => {
  await open(page, 'Text `#nope` here\n\n```\n#alsonope\n```\n\nand #yes\n');
  await expect(page.locator('.ProseMirror .futo-tag')).toHaveCount(1);
  await expect(page.locator('.ProseMirror .futo-tag')).toHaveText('#yes');
});

test('a `#` that is not a tag is left plain', async ({ page }) => {
  await open(page, 'C# and issue #5 and a#b\n');
  await expect(page.locator('.ProseMirror .futo-tag')).toHaveCount(0);
});

test('a tag is decorated as soon as it is typed', async ({ page }) => {
  await open(page, 'note:\n');
  await page.evaluate(() => (window as unknown as FakeHostWindow).FutoEditor.focus());
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' #later');
  await expect(page.locator('.ProseMirror .futo-tag')).toHaveText('#later');
});

test('a `#` typed straight onto a word is not a tag', async ({ page }) => {
  // The boundary half of the same rule: `note:#later` has no whitespace before
  // the `#`, so it is not a tag and must not be colored like one.
  await open(page, 'note:\n');
  await page.evaluate(() => (window as unknown as FakeHostWindow).FutoEditor.focus());
  await page.keyboard.press('Control+End');
  await page.keyboard.type('#later');
  await expect(page.locator('.ProseMirror .futo-tag')).toHaveCount(0);
});

/*
 * The CodeMirror editor hides a leading header tag block while the caret is
 * away; this editor deliberately does not — a ProseMirror node rendered
 * `display: none` cannot be reached by caret or click, so hiding it would make
 * the note's tags uneditable, and on the native shells (no tag bar) invisible
 * as well. Recorded as a gap in docs/spec/editor.md. This test is the lock on
 * the CURRENT behavior: the block is visible and its tags are decorated.
 */
test('a leading header tag block stays visible, with its tags decorated', async ({ page }) => {
  await open(page, '#alpha #beta\n\nBody text\n');
  const first = page.locator('.ProseMirror > p').first();
  await expect(first).toBeVisible();
  await expect(first.locator('.futo-tag')).toHaveCount(2);
});

// ============================================================
// Bare URLs — linked as they are typed, and saved as typed
// ============================================================

/* GFM autolink literals were recognized only when a note was PARSED: a typed
 * URL stayed plain text until the note was reopened (reported: "it should
 * become a hyperlink once i hit space or enter"). autolink.ts. */

/** The links in the document, as [text, href]. */
function links(page: Page): Promise<string[][]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('.ProseMirror a')].map((a) => [
      a.textContent ?? '',
      a.getAttribute('href') ?? '',
    ]),
  );
}

async function typeIntoEmptyNote(page: Page, text: string): Promise<void> {
  await open(page, '');
  await page.evaluate(() => (window as unknown as FakeHostWindow).FutoEditor.focus());
  await page.keyboard.type(text);
}

test('a typed URL becomes a link when Space ends it', async ({ page }) => {
  await typeIntoEmptyNote(page, 'see https://youtube.com');
  expect(await links(page)).toEqual([]);
  await page.keyboard.type(' ok');
  expect(await links(page)).toEqual([['https://youtube.com', 'https://youtube.com']]);
  await page.waitForTimeout(CHANGE_DEBOUNCE_MS + 120);
  // Saved as typed: bare, not `<https://youtube.com>`, and the text typed
  // after it is not part of the link.
  expect(await getContent(page)).toBe('see https://youtube.com ok\n');
});

test('a typed URL becomes a link when Enter ends it', async ({ page }) => {
  await typeIntoEmptyNote(page, 'https://youtube.com');
  await page.keyboard.press('Enter');
  await page.keyboard.type('next');
  expect(await links(page)).toEqual([['https://youtube.com', 'https://youtube.com']]);
  await page.waitForTimeout(CHANGE_DEBOUNCE_MS + 120);
  expect(await getContent(page)).toBe('https://youtube.com\nnext\n');
});

test('a typed link is exactly what reopening the note would link', async ({ page }) => {
  // The trailing period is GFM's to trim, `www.` gains its `http://`, and a
  // word that merely mentions a scheme is not a link.
  await typeIntoEmptyNote(page, 'go to www.example.com. or https://a.com/x_y, not https:// ');
  expect(await links(page)).toEqual([
    ['www.example.com', 'http://www.example.com'],
    ['https://a.com/x_y', 'https://a.com/x_y'],
  ]);
  await page.waitForTimeout(CHANGE_DEBOUNCE_MS + 120);
  // The plain-text `https://` needs no escape (a scheme with nothing after it
  // is not a literal), and the space the typing ended on is not written at the
  // line's end (docs/spec/editor.md "Markdown house style").
  expect(await getContent(page)).toBe(
    'go to www.example.com. or https://a.com/x_y, not https://\n',
  );
});

test('a URL typed inside inline code stays code', async ({ page }) => {
  await open(page, '`https://youtube.com`\n');
  await page.locator('.ProseMirror code').click();
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.type(' ');
  expect(await links(page)).toEqual([]);
});

/* The serializer half. mdast-util-to-markdown wrote a link whose text is its
 * URL as `<url>` and a `www.` literal as `[text](http://…)`, so ANY edit used to
 * rewrite every bare URL in the note. The house style writes such a link bare
 * whenever the bare text reads back as the same link. */
test('editing a note leaves its bare URLs bare', async ({ page }) => {
  const note = 'see https://youtube.com ok\n\nand www.example.com, or (https://a.com/b).\n';
  await open(page, note);
  await typeAtEnd(page, ' X');
  expect(await getContent(page)).toBe(note.replace(/\n$/, ' X\n'));
});

test('a URL that bare would not read back as the same link keeps its brackets', async ({
  page,
}) => {
  // Bare, `https://a.com` followed straight by `x` would read back as the
  // longer link `https://a.comx`.
  const note = '<https://a.com>x\n';
  await open(page, note);
  await typeAtEnd(page, ' X');
  expect(await getContent(page)).toBe('<https://a.com>x X\n');
});
