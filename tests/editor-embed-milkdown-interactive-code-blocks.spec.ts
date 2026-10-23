// Part of the interactive-element parity suite: scope and input rules are in
// editor-embed-milkdown-interactive.spec.ts.

import { expect } from '@playwright/test';
import { getContent, withCaretObserved } from './lib/editorEmbedHost';
import {
  test,
  open,
  caretAtEndOf,
  settled,
  caretAtStartOf,
} from './lib/editorEmbedMilkdownInteractive';

// ============================================================
// Code blocks — Tab indentation (QA #011; keyboardParity.ts)
// ============================================================

test('Tab inside a code block inserts two spaces instead of moving focus out', async ({ page }) => {
  await open(page, '```\nconst x = 1;\n```');
  await caretAtStartOf(page, 'const x = 1;');
  await page.keyboard.press('Tab');
  await settled(page);
  expect(await getContent(page)).toContain('```\n  const x = 1;\n```');
});

test('Shift+Tab inside a code block removes up to two leading spaces', async ({ page }) => {
  await open(page, '```\n  const x = 1;\n```');
  await caretAtStartOf(page, '  const x = 1;');
  await page.keyboard.press('Shift+Tab');
  await settled(page);
  expect(await getContent(page)).toContain('```\nconst x = 1;\n```');
});

test('Tab over a multi-line selection in a code block indents every touched line', async ({
  page,
}) => {
  await open(page, '```\none\ntwo\nthree\n```');
  // `caretAtStartOf` matches a text node EXACTLY, which a multi-line code
  // block's single text node ("one\ntwo\nthree") never does. Place the caret
  // at that node's start. Select the intended lines directly because browser
  // vertical movement through a code block depends on font and line layout.
  await withCaretObserved(page, () =>
    page
      .locator('.ProseMirror pre')
      .first()
      .evaluate((pre) => {
        const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
        const text = walker.nextNode();
        if (!text) throw new Error('code block has no text node');
        document.getSelection()?.collapse(text, 0);
      }),
  );
  await withCaretObserved(page, () =>
    page
      .locator('.ProseMirror pre')
      .first()
      .evaluate((pre) => {
        const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
        const text = walker.nextNode();
        if (!text) throw new Error('code block text node is missing');
        document.getSelection()?.setBaseAndExtent(text, 0, text, 'one\ntwo'.length);
      }),
  );
  expect(await page.evaluate(() => document.getSelection()?.toString())).toBe('one\ntwo');
  await page.keyboard.press('Tab');
  await settled(page);
  expect(await getContent(page)).toContain('```\n  one\n  two\nthree\n```');
});

test('Escape then Tab releases the code-block claim for the next Tab only', async ({ page }) => {
  await open(page, '```\ncode\n```');
  await caretAtStartOf(page, 'code');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Tab');
  // The released Tab moved focus off the editor onto the block's own chrome
  // (the ⋮ menu) rather than the fence — the editor no longer has the caret,
  // so nothing typed next reaches the code block.
  await expect(page.locator('.ProseMirror')).not.toBeFocused();
  await page.locator('.ProseMirror').click();
  await caretAtStartOf(page, 'code');
  await page.keyboard.type('x'); // re-arms the claim
  await withCaretObserved(page, () => page.keyboard.press('ArrowLeft'));
  await page.keyboard.press('Tab');
  await settled(page);
  expect(await getContent(page)).toContain('  xcode');
});

// ============================================================
// Code blocks — the presets' block-type shortcuts (ed-24; spec: "A
// block-format command never touches a CODE BLOCK")
// ============================================================

/**
 * Every preset chord that sets or wraps a block: Text, H1-H6, Ordered, Bullet,
 * Quote, Code.
 */
const BLOCK_TYPE_CHORDS = [0, 1, 2, 3, 4, 5, 6, 7, 8]
  .map((n) => `ControlOrMeta+Alt+${n}`)
  .concat(['ControlOrMeta+Shift+b', 'ControlOrMeta+Alt+c']);

for (const [where, markdown, selectAll] of [
  ['inside a one-line fence', '```js\nab\n```\n\nafter\n', false],
  ['inside a multi-line fence', '```js\nconst a = 1;\nif (a) {\n  b();\n}\n```\n', false],
  ['over a selection spanning a fence', 'before\n\n```js\nab\n```\n\nafter\n', true],
] as const) {
  test(`block-type shortcuts ${where} leave the note's bytes alone`, async ({ page }) => {
    await open(page, markdown);
    await withCaretObserved(page, () => page.locator('.ProseMirror pre code').first().click());
    if (selectAll) await withCaretObserved(page, () => page.keyboard.press('ControlOrMeta+a'));
    for (const chord of BLOCK_TYPE_CHORDS) {
      await page.keyboard.press(chord);
      await settled(page);
      expect.soft(await getContent(page), chord).toBe(markdown);
    }
  });
}

// A note ending in a list or quote has an empty paragraph parked after it
// that a save never writes; select-all covers it, and the chord used to format
// it too, saving a stray `#` or an empty fence.
for (const [markdown, chord, expected] of [
  ['- a\n', 'ControlOrMeta+Alt+1', '- a\n'],
  ['> a\n', 'ControlOrMeta+Alt+1', '> # a\n'],
  ['> a\n', 'ControlOrMeta+Alt+c', '> ```\n> a\n> ```\n'],
] as const) {
  test(`${chord} after select-all on ${JSON.stringify(markdown)} formats only the written lines`, async ({
    page,
  }) => {
    await open(page, markdown);
    await caretAtEndOf(page, 'a');
    await withCaretObserved(page, () => page.keyboard.press('ControlOrMeta+a'));
    await page.keyboard.press(chord);
    await settled(page);
    expect(await getContent(page)).toBe(expected);
  });
}

// #276: two lines typed with Enter are one paragraph with a line break, which
// a fence cannot hold — the chord joined them into one line. Like the toolbar
// (paragraphLines.ts `onSelectedLines`), a chord lands on each touched line.
for (const [chord, expected] of [
  ['ControlOrMeta+Alt+c', '```\none\n```\n\n```\ntwo\n```\n'],
  ['ControlOrMeta+Alt+1', '# one\n\n# two\n'],
] as const) {
  test(`${chord} after select-all over lines typed with Enter keeps every line`, async ({
    page,
  }) => {
    await open(page, 'one\ntwo\n');
    await withCaretObserved(page, () => page.locator('.ProseMirror p').first().click());
    await withCaretObserved(page, () => page.keyboard.press('ControlOrMeta+a'));
    await page.keyboard.press(chord);
    await settled(page);
    expect(await getContent(page)).toBe(expected);
    await page.keyboard.press('ControlOrMeta+z');
    await settled(page);
    expect(await getContent(page)).toBe('one\ntwo\n');
  });
}

test('Mod+Alt+1 still turns a paragraph into a heading', async ({ page }) => {
  await open(page, 'plain\n');
  await caretAtEndOf(page, 'plain');
  await page.keyboard.press('ControlOrMeta+Alt+1');
  await settled(page);
  expect(await getContent(page)).toBe('# plain\n');
});

// ============================================================
// Code blocks — the ```lang shortcut takes any language a fence can name
// (spec: interactive-elements.md "` ```lang `"). The preset's rule took
// lowercase letters only, so `C++`, `c#`, `JavaScript` and `ps1` — names the
// curated fence set (codeFenceLanguages.ts) itself spells — stayed an escaped
// paragraph (`\```c++ x`).
// ============================================================

for (const language of ['js', 'c++', 'JavaScript', 'c#', 'ps1', 'Objective-C']) {
  test(`typing \`\`\`${language} and a space opens a ${language} fence`, async ({ page }) => {
    await open(page, '');
    await page.locator('.ProseMirror').click();
    await page.keyboard.type('```' + language + ' ');
    await page.keyboard.type('x');
    await settled(page);
    expect(await getContent(page)).toBe('```' + language + '\nx\n```\n');
  });
}

test('typing ```c++ and a space on a later line of a paragraph opens a fence there', async ({
  page,
}) => {
  // The line-start route (paragraphLines.ts `lineStartShortcut`) mirrors the
  // rule, so it has to take the same languages.
  await open(page, 'Notes');
  await caretAtEndOf(page, 'Notes');
  await page.keyboard.press('Enter');
  await page.keyboard.type('```c++ ');
  await page.keyboard.type('x');
  await settled(page);
  expect(await getContent(page)).toBe('Notes\n\n```c++\nx\n```\n');
});
