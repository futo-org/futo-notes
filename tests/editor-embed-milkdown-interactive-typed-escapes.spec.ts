// Part of the interactive-element parity suite: scope and input rules are in
// editor-embed-milkdown-interactive.spec.ts.

import { expect, type Page } from '@playwright/test';
import { getContent, withCaretObserved } from './lib/editorEmbedHost';
import {
  test,
  open,
  caretAtEndOf,
  settled,
  reopen,
  SMALL_TABLE,
  paragraphLines,
  openAtEnd,
} from './lib/editorEmbedMilkdownInteractive';

// ============================================================
// Typed text saves with the escapes it needs (hardening L6e-1/13/14). Each
// case types, saves, re-opens what was saved, and checks the note still MEANS
// what was typed — the serializer's escaping is only visible on the reopen.
// ============================================================

/** The cell texts of table row `index` (0 = header) in the rendered document. */
function renderedRow(page: Page, index: number): Promise<string[]> {
  return page.locator('.ProseMirror tr').nth(index).locator('td, th').allTextContents();
}

test('a pipe typed in a table cell before bold stays in its cell', async ({ page }) => {
  // Milkdown writes a text run that ends in whitespace raw, so the run before
  // a mark lost its `\|` and the next open split the row.
  await open(page, SMALL_TABLE);
  await caretAtEndOf(page, 'c');
  await page.keyboard.type(' x | y ');
  await page.keyboard.press('ControlOrMeta+b');
  await page.keyboard.type('bold');
  await settled(page);
  const saved = await getContent(page);
  await reopen(page, saved);
  expect(await renderedRow(page, 1), saved).toEqual(['c x | y bold', 'd']);
});

test('a pipe typed in a table cell survives a pause after a trailing space', async ({ page }) => {
  // No mark at all: the cell's last run ends in a space, which is what the
  // autosave sees whenever the user pauses after one.
  await open(page, SMALL_TABLE);
  await caretAtEndOf(page, 'c');
  await page.keyboard.type(' x | y ');
  await settled(page);
  const saved = await getContent(page);
  await reopen(page, saved);
  expect(
    (await renderedRow(page, 1)).map((cell) => cell.trim()),
    saved,
  ).toEqual(['c x | y', 'd']);
});

test('a line of a paragraph that starts with an escaped "# " stays in the paragraph', async ({
  page,
}) => {
  // Typing `# ` at the start of a line makes a heading (the line-start
  // shortcut), so the line comes from the file, escaped as text.
  await openAtEnd(page, 'Notes\n\\# not a heading');
  await page.keyboard.type(' ');
  await page.keyboard.press('ControlOrMeta+b');
  await page.keyboard.type('bold');
  await settled(page);
  const saved = await getContent(page);
  await reopen(page, saved);
  expect(await page.locator('.ProseMirror h1').count(), saved).toBe(0);
  expect(await paragraphLines(page), saved).toEqual(['Notes\n# not a heading bold']);
});

test('"&amp;" typed before bold is still "&amp;" after a reopen', async ({ page }) => {
  await open(page, 'Notes');
  await caretAtEndOf(page, 'Notes');
  await page.keyboard.type(' write &amp; for & ');
  await page.keyboard.press('ControlOrMeta+b');
  await page.keyboard.type('bold');
  await settled(page);
  const saved = await getContent(page);
  await reopen(page, saved);
  expect(await page.locator('.ProseMirror p').first().textContent(), saved).toBe(
    'Notes write &amp; for & bold',
  );
});

test('Shift+Enter at the end of a heading starts a paragraph, as Enter does', async ({ page }) => {
  // It used to insert a hard break in the heading, written `\` + newline,
  // which ended the heading and left a stray backslash.
  await open(page, '#### Plan');
  await caretAtEndOf(page, 'Plan');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('next');
  await settled(page);
  const saved = await getContent(page);
  expect(saved).toBe('#### Plan\n\nnext\n');
});

// remark-stringify would not end a line in front of an inline HTML node (it
// could open an HTML block, syntax-tree/mdast-util-to-markdown#15) and wrote a
// space instead, so the newline was lost. `<kbd>` cannot open a block that
// interrupts a paragraph, and the editor's own serializer (#266) writes the
// newline. The space before it is not written: whitespace at a line's end
// never is.
test('Enter directly before inline HTML keeps the newline and adds no backslash', async ({
  page,
}) => {
  await open(page, 'Press <kbd>Ctrl</kbd> now');
  // Only the caret is placed through the DOM (directly before the `<kbd>`
  // atom, which no click can target); the break itself is a real Shift+Enter.
  await withCaretObserved(page, () =>
    page.evaluate(() => {
      const text = document.querySelector('.ProseMirror p')?.firstChild;
      if (!text) throw new Error('no text node');
      const range = document.createRange();
      range.setStart(text, 'Press '.length);
      range.collapse(true);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
    }),
  );
  await page.keyboard.press('Enter');
  await settled(page);
  expect(await getContent(page)).toBe('Press\n<kbd>Ctrl</kbd> now\n');
});

/** Select the first `length` characters of the first paragraph, as a mouse drag would. */
async function selectParagraphStart(page: Page, length: number): Promise<void> {
  await page.locator('.ProseMirror p').first().click();
  await withCaretObserved(page, () =>
    page.evaluate((selected) => {
      const text = document.querySelector('.ProseMirror p')?.firstChild;
      if (!text) throw new Error('no text node');
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, selected);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
    }, length),
  );
}

for (const [name, text, length, key, tag] of [
  ['Mod+B on "Note:" before a letter', 'Note:bar', 5, 'b', 'strong'],
  ['Mod+I on "Note:" before a letter', 'Note:bar', 5, 'i', 'em'],
  ['Mod+Alt+X on "Note:" before a letter', 'Note:bar', 5, 'Alt+x', 'del'],
  // CJK: bold on a phrase ending in a full-width colon, before the next ideograph.
  ['Mod+B on a CJK phrase ending in a full-width colon', '重要：这是', 3, 'b', 'strong'],
] as const) {
  test(`${name} is still formatted after a reopen`, async ({ page }) => {
    await open(page, text);
    await selectParagraphStart(page, length);
    await page.keyboard.press(`ControlOrMeta+${key}`);
    await settled(page);
    const saved = await getContent(page);
    await reopen(page, saved);
    expect(await page.locator(`.ProseMirror p ${tag}`).allTextContents(), saved).toEqual([
      text.slice(0, length),
    ]);
  });
}

test('a letter typed before an underscore emphasis followed by a `*` run keeps both italic', async ({
  page,
}) => {
  // FB-4a round 2: the dropped `_` to `*` re-spelling saved `a Z*b**c*`, which
  // reopens with two literal `**` in the text.
  await open(page, 'a _b_*c*');
  await withCaretObserved(page, () =>
    page.evaluate(() => {
      const text = document.querySelector('.ProseMirror p')?.firstChild;
      if (!text) throw new Error('no text node');
      const range = document.createRange();
      range.setStart(text, 'a '.length);
      range.collapse(true);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
    }),
  );
  await page.keyboard.type('Z');
  await settled(page);
  const saved = await getContent(page);
  expect(saved).not.toContain('**');
  await reopen(page, saved);
  // Both letters stay italic. The two touching runs, `_` then `*`, are written
  // as one (docs/spec/editor.md "Markdown house style").
  expect(await page.locator('.ProseMirror p em').allTextContents(), saved).toEqual(['bc']);
});

// ============================================================
// A nested list made by typing saves TIGHT (RC-102). Items the editor creates
// used to carry `spread: true`, so the moment Tab gave one a child list the item
// text and the list were separated by a blank line — where the same list opened
// from a tight file and edited stayed tight. Two spellings of one list, and the
// loose one reads as a different document to any other Markdown renderer.
// ============================================================

/** Presses `Enter` / `Tab` for those exact entries and types everything else. */
async function typeAndPress(page: Page, steps: string[]): Promise<void> {
  for (const step of steps) {
    if (step === 'Enter' || step === 'Tab') await page.keyboard.press(step);
    else await page.keyboard.type(step);
  }
}

test('a bullet list nested by typing Enter then Tab saves tight', async ({ page }) => {
  await open(page, '');
  await page.locator('.ProseMirror').click();
  await typeAndPress(page, ['- item a', 'Enter', 'item b', 'Enter', 'Tab', 'nested c']);
  await settled(page);
  expect(await getContent(page)).toBe('- item a\n- item b\n  - nested c\n');
});

test('an ordered list nested by typing Enter then Tab saves tight', async ({ page }) => {
  await open(page, '');
  await page.locator('.ProseMirror').click();
  await typeAndPress(page, ['1. one', 'Enter', 'two', 'Enter', 'Tab', 'nested']);
  await settled(page);
  expect(await getContent(page)).toBe('1. one\n2. two\n   1. nested\n');
});

test('the same list opened from a tight file and edited saves the same bytes', async ({ page }) => {
  await open(page, '- item a\n- item b\n  - nested c\n');
  await caretAtEndOf(page, 'nested c');
  await page.keyboard.type('!');
  await settled(page);
  expect(await getContent(page)).toBe('- item a\n- item b\n  - nested c!\n');
});

test('a LOOSE file keeps its blank lines after the same edit', async ({ page }) => {
  await open(page, '- item a\n\n- item b\n\n  - nested c\n');
  await caretAtEndOf(page, 'nested c');
  await page.keyboard.type('!');
  await settled(page);
  expect(await getContent(page)).toBe('- item a\n\n- item b\n\n  - nested c!\n');
});

// ============================================================
// Seven or more `#` are not a heading (CommonMark; markdown-house-style.md
// "Headings are ATX: one to six #"). The preset's rule made a level-7 heading
// node, rendered `<h7>`, that saved as six hashes — a different line.
// ============================================================

/** Opens an empty note, types `keys`, and waits for the save. */
async function typeIntoEmpty(page: Page, keys: string): Promise<string> {
  await openAtEnd(page, '');
  await page.keyboard.type(keys);
  await settled(page);
  return getContent(page);
}

test('typing seven hashes and a space stays paragraph text', async ({ page }) => {
  expect(await typeIntoEmpty(page, '####### seven')).toBe('####### seven\n');
  expect(await page.locator('.ProseMirror :is(h1, h2, h3, h4, h5, h6, h7)').count()).toBe(0);
});

test('typing seven hashes and a space on a later line stays paragraph text', async ({ page }) => {
  await openAtEnd(page, 'Hello');
  await page.keyboard.press('Enter');
  await page.keyboard.type('####### seven');
  await settled(page);
  expect(await getContent(page)).toBe('Hello\n####### seven\n');
  expect(await page.locator('.ProseMirror :is(h1, h2, h3, h4, h5, h6, h7)').count()).toBe(0);
});

test('typing six hashes and a space still makes a level-6 heading', async ({ page }) => {
  expect(await typeIntoEmpty(page, '###### six')).toBe('###### six\n');
  expect(await page.locator('.ProseMirror h6').allTextContents()).toEqual(['six']);
});

// ============================================================
// Typed delimiters follow CommonMark (spec: interactive-elements.md "convert
// as you type"; markdown-house-style.md "Text and escaping"). The preset's
// emphasis, strong and strikethrough rules took a run padded with spaces as
// formatting, and every mark rule read a backslash-escaped opener as a real
// one, so typing what a file reads as plain text changed it: `2 * 3 * 4` saved
// as `2 *&#x20;3&#x20;* 4`, `** not bold **` as `**not bold**`, `\*not italic*`
// as `\\*not italic*`.
// ============================================================

/** The formatting the rendered paragraph holds, as `tag:text` pairs. */
function renderedMarks(page: Page): Promise<string[]> {
  return page
    .locator('.ProseMirror p :is(em, strong, code, del, s)')
    .evaluateAll((elements) =>
      elements.map((element) => `${element.tagName.toLowerCase()}:${element.textContent ?? ''}`),
    );
}

for (const typed of [
  '2 * 3 * 4',
  '** not bold **',
  '__ not bold __',
  'a * b*',
  'a *b *',
  '~~ not struck ~~',
]) {
  test(`typed "${typed}" stays text, as a file reads it`, async ({ page }) => {
    expect(await typeIntoEmpty(page, typed)).toBe(`${typed}\n`);
    expect(await renderedMarks(page)).toEqual([]);
  });
}

for (const typed of [
  '\\*not italic*',
  '\\**not bold**',
  '\\_not italic_',
  '\\`not code`',
  '\\~not struck~',
]) {
  test(`a typed backslash before "${typed.slice(1)}" keeps the delimiters text`, async ({
    page,
  }) => {
    // The typed `\` is a character the user sees, so the saved note must read
    // back as exactly that line — backslash included — with no formatting.
    const saved = await typeIntoEmpty(page, typed);
    expect(await renderedMarks(page), saved).toEqual([]);
    await reopen(page, saved);
    expect(await paragraphLines(page), saved).toEqual([typed]);
    expect(await renderedMarks(page), saved).toEqual([]);
  });
}

for (const typed of ['*foo\\* bar', '**foo\\** bar', '_foo\\_ bar', '~~foo\\~~ bar']) {
  test(`a typed backslash before the closer of "${typed}" keeps it text`, async ({ page }) => {
    // An escaped CLOSING delimiter closes nothing, as an escaped opener opens
    // nothing: a file holding `*foo\* bar` reads as plain `*foo* bar`.
    const saved = await typeIntoEmpty(page, typed);
    expect(await renderedMarks(page), saved).toEqual([]);
    await reopen(page, saved);
    expect(await paragraphLines(page), saved).toEqual([typed]);
    expect(await renderedMarks(page), saved).toEqual([]);
  });
}

for (const typed of ['a*"b"* c', 'a**"b"** c', 'a~~"b"~~ c', 'café_b_ c']) {
  test(`typed "${typed}" stays text: its opener cannot open`, async ({ page }) => {
    // CommonMark's flanking rule has a punctuation half: a delimiter after a
    // letter and before punctuation is not left-flanking, and an `_` between
    // letters (any script's) opens nothing. A file reads each of these as text.
    const saved = await typeIntoEmpty(page, typed);
    expect(await renderedMarks(page), saved).toEqual([]);
    await reopen(page, saved);
    expect(await paragraphLines(page), saved).toEqual([typed]);
    expect(await renderedMarks(page), saved).toEqual([]);
  });
}

for (const typed of ['a **x__ b', 'a __x** b', '``x` y']) {
  test(`typed "${typed}" stays text: its closer does not match its opener`, async ({ page }) => {
    // A delimiter run closes only a run of the same character (`**` is not
    // closed by `__`), and a code span only a backtick run of the same length.
    // A file reads each of these as text; converting saved `a **x** b`.
    const saved = await typeIntoEmpty(page, typed);
    expect(await renderedMarks(page), saved).toEqual([]);
    await reopen(page, saved);
    expect(await paragraphLines(page), saved).toEqual([typed]);
    expect(await renderedMarks(page), saved).toEqual([]);
  });
}

test('a typed run converts when an earlier opener on the line cannot open', async ({ page }) => {
  // The first `_` (between letters) opens nothing; the `_b_` after it is
  // emphasis in a file, so it converts as it is typed.
  const saved = await typeIntoEmpty(page, 'café_a_ _b_ c');
  expect(await renderedMarks(page), saved).toEqual(['em:b']);
  await reopen(page, saved);
  expect(await paragraphLines(page), saved).toEqual(['café_a_ b c']);
  expect(await renderedMarks(page), saved).toEqual(['em:b']);
});

for (const [typed, saved, marks] of [
  ['2 *3* 4', '2 *3* 4\n', ['em:3']],
  ['a **b c** d', 'a **b c** d\n', ['strong:b c']],
  // Two typed backslashes are an escaped backslash, each written escaped, so the `*` opens.
  ['x \\\\*y* z', 'x \\\\\\\\*y* z\n', ['em:y']],
  ['run `npm i` now', 'run `npm i` now\n', ['code:npm i']],
  // A backslash escapes nothing inside a code span: `a\` is code, as a file reads it.
  ['x `a\\` y', 'x `a\\` y\n', ['code:a\\']],
  // Punctuation after an opener is fine where whitespace or punctuation precedes it.
  ['a *"b"* c', 'a *"b"* c\n', ['em:"b"']],
  ['("*b*")', '("*b*")\n', ['em:b']],
] as const) {
  test(`typed "${typed}" still converts`, async ({ page }) => {
    expect(await typeIntoEmpty(page, typed)).toBe(saved);
    expect(await renderedMarks(page)).toEqual(marks);
  });
}
