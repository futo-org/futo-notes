// Part of the interactive-element parity suite: scope and input rules are in
// editor-embed-milkdown-interactive.spec.ts.

import { expect, type Page } from '@playwright/test';
import { getContent, withCaretObserved, type FakeHostWindow } from './lib/editorEmbedHost';
import {
  test,
  open,
  caretAtEndOf,
  settled,
  reopen,
  lastLine,
} from './lib/editorEmbedMilkdownInteractive';

// ============================================================
// Typed `![alt](src)` becomes an image as the closing `)` is typed (RC-56,
// docs/spec/editor.md "Formatting is reachable by typing Markdown"). The
// vault filename, an external https/http URL, a URL with a query string, the
// `<…>` form and a title all convert, render, and save back as the same bytes.
// ============================================================

const IMAGE_BASE = 'file:///vault/';

/** Rendered images — ProseMirror adds its own `img.ProseMirror-separator` after a trailing inline atom. */
const IMAGES = '.ProseMirror img:not(.ProseMirror-separator)';

/** Type `typed` on a new line after "Notes" in a note whose host registered a base URL. */
async function typeAfterNotes(page: Page, typed: string): Promise<void> {
  await open(page, 'Notes');
  await page.evaluate(
    (base) => (window as unknown as FakeHostWindow).FutoEditor.setImageBaseUrl(base),
    IMAGE_BASE,
  );
  await caretAtEndOf(page, 'Notes');
  await page.keyboard.press('Enter');
  await page.keyboard.type(typed);
  await settled(page);
}

for (const [name, typed, src, alt, title, rendered] of [
  [
    'a vault filename',
    '![alt](image-123.png)',
    'image-123.png',
    'alt',
    null,
    IMAGE_BASE + 'image-123.png',
  ],
  [
    'an empty alt and a vault filename',
    '![](image-123.png)',
    'image-123.png',
    '',
    null,
    IMAGE_BASE + 'image-123.png',
  ],
  [
    'an external https URL',
    '![alt](https://example.com/a.png)',
    'https://example.com/a.png',
    'alt',
    null,
    'https://example.com/a.png',
  ],
  [
    'an external http URL with an empty alt',
    '![](http://example.com/b.png)',
    'http://example.com/b.png',
    '',
    null,
    'http://example.com/b.png',
  ],
  [
    'an external URL with a query string',
    '![alt](https://example.com/a.png?w=100)',
    'https://example.com/a.png?w=100',
    'alt',
    null,
    'https://example.com/a.png?w=100',
  ],
  [
    'a `<…>` destination with a space',
    '![alt](<my photo.png>)',
    'my photo.png',
    'alt',
    null,
    IMAGE_BASE + 'my%20photo.png',
  ],
  [
    'a title',
    '![alt](https://example.com/a.png "the title")',
    'https://example.com/a.png',
    'alt',
    'the title',
    'https://example.com/a.png',
  ],
] as const) {
  test(`typing ${name} as ![alt](…) becomes a rendered image that saves as typed`, async ({
    page,
  }) => {
    await typeAfterNotes(page, typed);
    const image = page.locator(`.ProseMirror img[data-futo-src="${src}"]`);
    await expect(image).toHaveCount(1);
    await expect(image).toHaveAttribute('src', rendered);
    await expect(image).toHaveAttribute('alt', alt);
    if (title) await expect(image).toHaveAttribute('title', title);
    const saved = await getContent(page);
    expect(saved).toBe(`Notes\n${typed}\n`);
    // And the saved bytes reopen as the same image.
    await reopen(page, saved);
    await expect(page.locator(`.ProseMirror img[data-futo-src="${src}"]`)).toHaveCount(1);
    expect(await getContent(page)).toBe(saved);
  });
}

test('a typed external URL keeping its `&` reopens as the same image', async ({ page }) => {
  // The serializer writes `&` in a destination as `\&` (an entity guard — the
  // same for a link, and for any note opened and edited); it means the same
  // URL, so what must hold is that the image still points at it after a save.
  const url = 'https://example.com/a.png?w=100&h=50';
  await typeAfterNotes(page, `![alt](${url})`);
  await expect(page.locator(`.ProseMirror img[data-futo-src="${url}"]`)).toHaveCount(1);
  await reopen(page, await getContent(page));
  await expect(page.locator(`.ProseMirror img[data-futo-src="${url}"]`)).toHaveCount(1);
});

test('a typed image converts in the middle of a sentence and keeps the text around it', async ({
  page,
}) => {
  await typeAfterNotes(page, 'see ![alt](https://example.com/a.png) here');
  await expect(page.locator(IMAGES)).toHaveCount(1);
  expect(await getContent(page)).toBe('Notes\nsee ![alt](https://example.com/a.png) here\n');
});

test('one Ctrl+Z after the typed image converts undoes it, like another rule does', async ({
  page,
}) => {
  // The rule replaces the run without ever inserting the `)` that triggered it,
  // so undoing it gives back the text as it stood before that keystroke — the
  // same as `**bold**`. The pause keeps the conversion out of the typing's own
  // undo group (prosemirror-history merges edits closer than 500 ms).
  await open(page, 'Notes');
  await caretAtEndOf(page, 'Notes');
  await page.keyboard.press('Enter');
  await page.keyboard.type('![alt](https://example.com/a.png');
  await page.waitForTimeout(700);
  await page.keyboard.type(')');
  await expect(page.locator(IMAGES)).toHaveCount(1);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator(IMAGES)).toHaveCount(0);
  expect(await lastLine(page)).toBe('![alt](https://example.com/a.png');

  // Control: the strong rule, same shape.
  await page.keyboard.press('Enter');
  await page.keyboard.type('**bold*');
  await page.waitForTimeout(700);
  await page.keyboard.type('*');
  await expect(page.locator('.ProseMirror p strong')).toHaveText('bold');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('.ProseMirror p strong')).toHaveCount(0);
  expect(await lastLine(page)).toBe('**bold*');
});

test('a typed image does not convert inside inline code', async ({ page }) => {
  await typeAfterNotes(page, '`![alt](https://example.com/a.png)`');
  await expect(page.locator(IMAGES)).toHaveCount(0);
  await expect(page.locator('.ProseMirror p code').last()).toHaveText(
    '![alt](https://example.com/a.png)',
  );
  expect(await getContent(page)).toBe('Notes\n`![alt](https://example.com/a.png)`\n');
});

test('a typed image does not convert inside an existing code span', async ({ page }) => {
  await open(page, '`ab`');
  // Only the caret is placed through the DOM (between the `a` and the `b`);
  // the typing itself is real.
  await withCaretObserved(page, () =>
    page.evaluate(() => {
      const text = document.querySelector('.ProseMirror p code')?.firstChild;
      if (!text) throw new Error('no code text node');
      const range = document.createRange();
      range.setStart(text, 1);
      range.collapse(true);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
    }),
  );
  await page.keyboard.type('![x](https://example.com/a.png)');
  await settled(page);
  await expect(page.locator(IMAGES)).toHaveCount(0);
  await expect(page.locator('.ProseMirror p code')).toHaveText('a![x](https://example.com/a.png)b');
});

test('a typed image does not convert inside a code block', async ({ page }) => {
  await open(page, '```\n\n```\n');
  await page.locator('.ProseMirror pre').click();
  await page.keyboard.type('![alt](https://example.com/a.png)');
  await settled(page);
  await expect(page.locator(IMAGES)).toHaveCount(0);
  expect(await getContent(page)).toContain('![alt](https://example.com/a.png)');
  expect(await getContent(page)).toMatch(/^```\n!\[alt\]\(https:\/\/example.com\/a.png\)\n```/);
});

test('an escaped `\\![alt](…)` typed in a paragraph stays text', async ({ page }) => {
  await typeAfterNotes(page, '\\![alt](https://example.com/a.png)');
  await expect(page.locator(IMAGES)).toHaveCount(0);
  const saved = await getContent(page);
  await reopen(page, saved);
  await expect(page.locator(IMAGES)).toHaveCount(0);
  expect(await lastLine(page), saved).toBe('\\![alt](https://example.com/a.png)');
});

test('a typed plain link `[a](b)` is not turned into an image or a link', async ({ page }) => {
  await typeAfterNotes(page, '[a](https://example.com)');
  await expect(page.locator(IMAGES)).toHaveCount(0);
  expect(await lastLine(page)).toBe('[a](https://example.com)');
});
