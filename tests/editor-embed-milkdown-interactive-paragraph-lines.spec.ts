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
  SMALL_TABLE,
  paragraphLines,
  openAtEnd,
  caretAtStartOf,
  pastePlainText,
} from './lib/editorEmbedMilkdownInteractive';

// ============================================================
// Paragraphs and lines — Enter is a newline (docs/spec/editor.md "Paragraphs
// and lines", #263). Each case asserts only two things: the bytes the editor
// would save, and what the reader sees.
// ============================================================

/**
 * Moves the caret `count` characters left, and waits until ProseMirror has
 * read the move: arrow keys move only the DOM caret, which ProseMirror learns
 * from an async `selectionchange`, so a key pressed straight after would be
 * handled against the old caret (see `withCaretObserved`).
 */
async function caretBack(page: Page, count: number): Promise<void> {
  for (let i = 0; i < count - 1; i += 1) await page.keyboard.press('ArrowLeft');
  await withCaretObserved(page, () => page.keyboard.press('ArrowLeft'));
}

test('one Enter writes one newline, and the next line shows under the first', async ({ page }) => {
  await openAtEnd(page, 'one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('two');
  await settled(page);
  expect(await getContent(page)).toBe('one\ntwo\n');
  expect(await paragraphLines(page)).toEqual(['one\ntwo']);
});

test('two Enters end the paragraph: one blank line', async ({ page }) => {
  await openAtEnd(page, 'one');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('two');
  await settled(page);
  expect(await getContent(page)).toBe('one\n\ntwo\n');
  expect(await paragraphLines(page)).toEqual(['one', 'two']);
});

test('three Enters leave an empty paragraph: two blank lines', async ({ page }) => {
  await openAtEnd(page, 'one');
  for (let i = 0; i < 3; i += 1) await page.keyboard.press('Enter');
  await page.keyboard.type('two');
  await settled(page);
  expect(await getContent(page)).toBe('one\n\n\ntwo\n');
});

test('Shift+Enter is Enter: one newline, then a paragraph break, never a backslash', async ({
  page,
}) => {
  await openAtEnd(page, 'one');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('two');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('three');
  await settled(page);
  expect(await getContent(page)).toBe('one\ntwo\n\nthree\n');
});

test('Backspace at the start of a line joins it to the line above', async ({ page }) => {
  await openAtEnd(page, 'one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('two');
  await caretBack(page, 'two'.length);
  await page.keyboard.press('Backspace');
  await settled(page);
  expect(await getContent(page)).toBe('onetwo\n');
});

test('Backspace after two Enters takes back one of them, not both', async ({ page }) => {
  await openAtEnd(page, 'one');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('two');
  await caretBack(page, 'two'.length);
  await page.keyboard.press('Backspace');
  await settled(page);
  expect(await getContent(page)).toBe('one\ntwo\n');
  expect(await paragraphLines(page)).toEqual(['one\ntwo']);
});

// A selectionchange left over from the step before a caret move satisfies
// `withCaretObserved`'s counter while the move's own event is still pending
// (CI jobs 271142, 269958: the Backspace above took both newlines; 270970: the
// Tab indented after the `x`). On demand: the move bumps the counter with a
// selectionchange ProseMirror cannot hear (its DOM observer is stopped), then
// lets it catch up 150 ms later.
test('withCaretObserved returns only once the editor holds the DOM caret', async ({ page }) => {
  await openAtEnd(page, 'abcdef');
  await withCaretObserved(page, () =>
    page.evaluate(() => {
      const view = (
        window as unknown as {
          __futoProseMirrorView: () => { domObserver: { stop(): void; start(): void } };
        }
      ).__futoProseMirrorView();
      const text = document.querySelector('.ProseMirror > p')?.firstChild;
      if (!text) throw new Error('no paragraph text node');
      view.domObserver.stop();
      window.getSelection()!.collapse(text, 2);
      document.dispatchEvent(new Event('selectionchange'));
      setTimeout(() => {
        view.domObserver.start();
        document.dispatchEvent(new Event('selectionchange'));
      }, 150);
    }),
  );
  const { editor, dom } = await page.evaluate(() => {
    const view = (
      window as unknown as {
        __futoProseMirrorView: () => {
          state: { selection: { from: number } };
          posAtDOM: (node: Node, offset: number) => number;
        };
      }
    ).__futoProseMirrorView();
    const selection = window.getSelection()!;
    return {
      editor: view.state.selection.from,
      dom: view.posAtDOM(selection.anchorNode!, selection.anchorOffset),
    };
  });
  expect(editor).toBe(dom);
});

test('Delete at the end of a paragraph joins the next one as a line', async ({ page }) => {
  await open(page, 'one\n\ntwo');
  await caretAtEndOf(page, 'one');
  await page.keyboard.press('Delete');
  await settled(page);
  expect(await getContent(page)).toBe('one\ntwo\n');
});

/**
 * Puts the caret `offset` characters into the first text node that holds
 * exactly `text` — a line of a paragraph, which `getByText` cannot address.
 */
async function caretInText(page: Page, text: string, offset: number): Promise<void> {
  await withCaretObserved(page, () =>
    page.evaluate(
      ([wanted, at]) => {
        const root = document.querySelector('.ProseMirror');
        if (!root) throw new Error('no editor');
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (node.textContent === wanted) {
            getSelection()?.collapse(node, at);
            return;
          }
        }
        throw new Error(`no text node "${wanted}"`);
      },
      [text, offset] as const,
    ),
  );
}

test('Enter at the end of a line with a line below leaves one blank line between them', async ({
  page,
}) => {
  await open(page, 'one\ntwo');
  await caretInText(page, 'one', 'one'.length);
  await page.keyboard.press('Enter');
  await settled(page);
  expect(await paragraphLines(page)).toEqual(['one\n\ntwo']);
  expect(await getContent(page)).toBe('one\n\ntwo\n');
});

test('two Enters at the end of a line with a line below leave an empty line: two blank lines', async ({
  page,
}) => {
  // The second Enter splits the paragraph, so the line below starts with a
  // line break (the empty line). The save writes it as an empty line, never
  // as a character reference.
  await open(page, 'one\ntwo');
  await caretInText(page, 'one', 'one'.length);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await settled(page);
  expect(await paragraphLines(page)).toEqual(['one', '\ntwo']);
  expect(await getContent(page)).toBe('one\n\n\ntwo\n');
});

test('Backspace under a line that ends in a newline takes back one newline', async ({ page }) => {
  await open(page, 'one\n\ntwo');
  await caretInText(page, 'one', 'one'.length);
  await page.keyboard.press('Enter');
  await caretInText(page, 'two', 0);
  await page.keyboard.press('Backspace');
  await settled(page);
  expect(await paragraphLines(page)).toEqual(['one\ntwo']);
  expect(await getContent(page)).toBe('one\ntwo\n');
});

test('Delete on an empty last line joins the next paragraph onto it', async ({ page }) => {
  await open(page, 'one\n\ntwo');
  await caretInText(page, 'one', 'one'.length);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Delete');
  await settled(page);
  expect(await paragraphLines(page)).toEqual(['one\ntwo']);
  expect(await getContent(page)).toBe('one\ntwo\n');
});

test('bold typed across an Enter stays one bold run', async ({ page }) => {
  await openAtEnd(page, 'start');
  await page.keyboard.type(' ');
  await page.keyboard.press('ControlOrMeta+b');
  await page.keyboard.type('one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('two');
  await settled(page);
  const saved = await getContent(page);
  expect(saved).toBe('start **one\ntwo**\n');
  await reopen(page, saved);
  expect(await page.locator('.ProseMirror strong').count(), saved).toBe(1);
});

test('a file with single newlines opens on separate lines and is not rewritten', async ({
  page,
}) => {
  await open(page, 'hey man\nyes');
  expect(await paragraphLines(page)).toEqual(['hey man\nyes']);
  expect(await getContent(page)).toBe('hey man\nyes');
});

test('undo after an Enter takes back exactly that newline', async ({ page }) => {
  await openAtEnd(page, 'one');
  await page.keyboard.press('Enter');
  await page.keyboard.press('ControlOrMeta+z');
  await settled(page);
  expect(await paragraphLines(page)).toEqual(['one']);
  expect(await getContent(page)).toBe('one');
});

test('Enter at the end of a heading still starts a paragraph', async ({ page }) => {
  await open(page, '# Title');
  await caretAtEndOf(page, 'Title');
  await page.keyboard.press('Enter');
  await page.keyboard.type('body');
  await settled(page);
  expect(await getContent(page)).toBe('# Title\n\nbody\n');
});

test('Enter in a blockquote still splits its paragraph', async ({ page }) => {
  await open(page, '> quote');
  await caretAtEndOf(page, 'quote');
  await page.keyboard.press('Enter');
  await page.keyboard.type('more');
  await settled(page);
  expect(await getContent(page)).toBe('> quote\n>\n> more\n');
});

test('Enter in a code block is still a newline in the code', async ({ page }) => {
  await open(page, '```\ncode\n```');
  await withCaretObserved(page, () =>
    page.evaluate(() => {
      const text = document.querySelector('.ProseMirror pre code')?.firstChild;
      if (!text) throw new Error('no code text');
      getSelection()?.collapse(text, 'code'.length);
    }),
  );
  await page.keyboard.press('Enter');
  await page.keyboard.type('more');
  await settled(page);
  expect(await getContent(page)).toBe('```\ncode\nmore\n```\n');
});

test('Shift+Enter in a list item continues the list, as Enter does', async ({ page }) => {
  await open(page, '- a');
  await caretAtEndOf(page, 'a');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('b');
  await settled(page);
  expect(await getContent(page)).toBe('- a\n- b\n');
});

test('Shift+Enter in a table cell is still a line break in that cell, and moves no row', async ({
  page,
}) => {
  await open(page, SMALL_TABLE);
  await caretAtEndOf(page, 'c');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('more');
  await settled(page);
  expect(await page.locator('.ProseMirror tr').count()).toBe(2);
  expect(await page.locator('.ProseMirror tr').nth(1).locator('td').first().innerText()).toBe(
    'c\nmore',
  );
  const saved = await getContent(page);
  expect(saved.split('\n').filter((line) => line !== '')).toHaveLength(3);
  expect(saved).toContain('| c<br>more | d |');
});

test('"- " typed at the start of a line starts a list from that line', async ({ page }) => {
  await openAtEnd(page, 'Shopping:');
  await page.keyboard.press('Enter');
  await page.keyboard.type('- milk');
  await settled(page);
  expect(await getContent(page)).toBe('Shopping:\n\n- milk\n');
  expect(await page.locator('.ProseMirror > p').first().innerText()).toBe('Shopping:');
  expect(await page.locator('.ProseMirror li').allInnerTexts()).toEqual(['milk']);
});

test('"# " typed at the start of a line makes that line a heading', async ({ page }) => {
  await openAtEnd(page, 'one\ntwo');
  await page.keyboard.press('Enter');
  await page.keyboard.type('# Next');
  await settled(page);
  expect(await getContent(page)).toBe('one\ntwo\n\n# Next\n');
});

test('"|2x2| " typed at the start of a line makes a table from that line', async ({ page }) => {
  await openAtEnd(page, 'one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('|2x2| ');
  await settled(page);
  // The line above stays a paragraph of its own (the empty one after the
  // table is the caret's landing place under a last-block table).
  expect((await paragraphLines(page))[0]).toBe('one');
  expect(await page.locator('.ProseMirror table').count()).toBe(1);
  expect(await getContent(page)).toMatch(/^one\n\n\|/);
});

test('a block format from the toolbar lands on the caret line only', async ({ page }) => {
  await openAtEnd(page, 'one\ntwo\nthree');
  await withCaretObserved(page, () => page.keyboard.press('ArrowUp'));
  await page.evaluate(() =>
    (
      window as unknown as FakeHostWindow & { FutoEditor: { exec(id: string): void } }
    ).FutoEditor.exec('bullet-list'),
  );
  await settled(page);
  expect(await getContent(page)).toBe('one\n\n- two\n\nthree\n');
});

// ============================================================
// Plain-text paste into a line. The pasted text is read as markdown, but the
// characters it puts in the line are the ones that were copied.
// ============================================================

// The paste was parsed as a markdown file on its own, which trims a line's
// ends: `base` + ` x` saved `basex`, fusing the two words.
for (const [note, place, pasted, expected] of [
  ['base\n', 'end', ' x', 'base x\n'],
  ['base\n', 'start', 'x ', 'x base\n'],
  [
    'base\n',
    'end',
    ' see [[Other note]] and [[Target|alias]]',
    'base see [[Other note]] and [[Target|alias]]\n',
  ],
  ['## Head\n\nbody\n', 'end', ' more', '## Head more\n\nbody\n'],
] as const) {
  test(`pasted plain text keeps the space at its ${place === 'end' ? 'start' : 'end'}: ${JSON.stringify(pasted)}`, async ({
    page,
  }) => {
    await open(page, note);
    const word = note.replace(/^#+ /, '').split('\n')[0];
    if (place === 'end') await caretAtEndOf(page, word);
    else await caretAtStartOf(page, word);
    await pastePlainText(page, pasted);
    await settled(page);
    expect(await getContent(page)).toBe(expected);
  });
}

// The parsed paste went through the DOM, whose whitespace rules collapse every
// run of spaces and tabs to one space.
for (const [pasted, expected] of [
  ['a\tb', 'basea\tb\n'],
  ['a    b', 'basea    b\n'],
] as const) {
  test(`pasted plain text keeps its tabs and runs of spaces: ${JSON.stringify(pasted)}`, async ({
    page,
  }) => {
    await open(page, 'base\n');
    await caretAtEndOf(page, 'base');
    await pastePlainText(page, pasted);
    await settled(page);
    expect(await getContent(page)).toBe(expected);
  });
}

// Its text was merged into the paragraph, `#` and all gone: `startTitle`, or
// `start\nTitle` on the empty line an Enter makes.
for (const [enter, pasted, expected] of [
  [false, '# Title', 'start\n\n# Title\n'],
  [true, '# Title', 'start\n\n# Title\n'],
  [true, '# Title\n\nbody', 'start\n\n# Title\n\nbody\n'],
] as const) {
  test(`a markdown heading pasted ${enter ? 'on the empty line after' : 'at the end of'} a line stays a heading: ${JSON.stringify(pasted)}`, async ({
    page,
  }) => {
    await openAtEnd(page, 'start');
    if (enter) await page.keyboard.press('Enter');
    await pastePlainText(page, pasted);
    await settled(page);
    expect(await getContent(page)).toBe(expected);
  });
}

// The same block after text in a heading, a list item or a task item lost its
// markup and fused onto the text before it: `## HeadTitle`, `- itemTitle`,
// `- [ ] taskT`, `- itemx` + `- y`. A block in a list item lands inside that
// item; a pasted list adds items beside it.
for (const [note, word, pasted, expected] of [
  ['## Head\n', 'Head', '# Title', '## Head\n\n# Title\n'],
  ['- item\n', 'item', '# Title', '- item\n  # Title\n'],
  ['- [ ] task\n', 'task', '# T', '- [ ] task\n  # T\n'],
  ['- item\n', 'item', '- x\n- y', '- item\n- x\n- y\n'],
  ['- [ ] task\n', 'task', '- [ ] b', '- [ ] task\n- [ ] b\n'],
  ['1. one\n', 'one', '- x', '1. one\n2. x\n'],
] as const) {
  test(`a block pasted at the end of ${JSON.stringify(note)} keeps its markup: ${JSON.stringify(pasted)}`, async ({
    page,
  }) => {
    await open(page, note);
    await caretAtEndOf(page, word);
    await pastePlainText(page, pasted);
    await settled(page);
    expect(await getContent(page)).toBe(expected);
  });
}

// A copied line carries its line ending: the space before it was dropped with
// it, so `x ` + newline pasted into `ab|cd` saved `abxcd`.
test('pasted plain text keeps a space before its final newline', async ({ page }) => {
  await open(page, 'abcd\n');
  await caretAtEndOf(page, 'abcd');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await pastePlainText(page, 'x \n');
  await settled(page);
  expect(await getContent(page)).toBe('abx cd\n');
});

// A block marker on its own read as an empty block (an empty heading, list
// item, quote or task), and the line was split around it: `#` pasted into
// `ab|cd` saved `ab`, `#`, `cd` as three blocks, and `*` came back as `-`.
for (const [note, word, back, pasted, expected] of [
  ['abcd\n', 'abcd', 2, '#', 'ab#cd\n'],
  ['abcd\n', 'abcd', 2, '-', 'ab-cd\n'],
  ['abcd\n', 'abcd', 2, '*', 'ab*cd\n'],
  ['abcd\n', 'abcd', 2, '>', 'ab>cd\n'],
  ['abcd\n', 'abcd', 2, '1.', 'ab1.cd\n'],
  ['abcd\n', 'abcd', 2, '- [ ]', 'ab- [ ]cd\n'],
  ['abcd\n', 'abcd', 2, '# \n', 'ab# cd\n'],
  ['## Head\n', 'Head', 2, '-', '## He-ad\n'],
  ['- item\n', 'item', 2, '#', '- it#em\n'],
] as const) {
  test(`a block marker pasted alone into ${JSON.stringify(note)} goes in as its characters: ${JSON.stringify(pasted)}`, async ({
    page,
  }) => {
    await open(page, note);
    await caretAtEndOf(page, word);
    if (back > 0) await caretBack(page, back);
    await pastePlainText(page, pasted);
    await settled(page);
    expect(await getContent(page)).toBe(expected);
  });
}
