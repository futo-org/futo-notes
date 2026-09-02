import { test, expect, Page } from '@playwright/test';

import {
  editorMarkdown,
  openNewNote,
  typeAtCaret,
  typeInEditor,
  withoutTrailingBlank,
} from './lib/desktopEditor';

/**
 * Blockquote continuation, asserted on the MARKDOWN the editor would save.
 *
 * The CodeMirror version of this file read the caret's line text and character
 * offset out of the editor's document and expected to find a literal `> ` /
 * `> > ` prefix there. A WYSIWYG editor has no such prefix to find: a quote is
 * a nested `<blockquote>`, and the `>` markers exist only in the serialized
 * file. So the same product behaviour is checked one level out — what typing
 * produces in the note, and how deep the caret's quote nesting is.
 *
 * The caret-offset-after-continuation cases went with the engine: "the caret
 * sits at column 2, after `> `" is a claim about markdown source, and there is
 * no column 2 to be at.
 */

/** How deep the caret's quote nesting is: 0 outside a quote, 1 in `>`, 2 in `> >`. */
async function quoteDepth(page: Page): Promise<number> {
  return page.evaluate(() => {
    const selection = window.getSelection();
    let node: Node | null = selection?.focusNode ?? null;
    let depth = 0;
    while (node) {
      if (node instanceof HTMLElement) {
        if (node.classList.contains('ProseMirror')) break;
        if (node.tagName === 'BLOCKQUOTE') depth += 1;
      }
      node = node.parentNode;
    }
    return depth;
  });
}

/** The saved note, without the empty trailing paragraph the editor always keeps. */
async function savedNote(page: Page): Promise<string> {
  return withoutTrailingBlank(await editorMarkdown(page));
}

test.describe('Blockquote continuation', () => {
  test('Enter inside a quote stays in the quote', async ({ page }) => {
    await openNewNote(page);
    await typeInEditor(page, '> hello');
    expect(await quoteDepth(page)).toBe(1);

    await page.keyboard.press('Enter');
    await typeAtCaret(page, 'world');

    expect(await quoteDepth(page)).toBe(1);
    expect(await savedNote(page)).toBe('> hello\n>\n> world');
  });

  test('Enter on an empty quote line leaves the quote', async ({ page }) => {
    await openNewNote(page);
    await typeInEditor(page, '> hello');

    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    expect(await quoteDepth(page)).toBe(0);

    // The lift out of the quote lands in its own transaction, which re-places
    // the caret. Typing into the very next frame races it (measured: the first
    // character ends up after the rest). Wait for the document to settle, the
    // way a human pausing between paragraphs does.
    await page.waitForTimeout(200);
    await typeAtCaret(page, 'outside');

    expect(await quoteDepth(page)).toBe(0);
    expect(await savedNote(page)).toBe('> hello\n\noutside');
  });

  test('a nested quote steps down one level at a time', async ({ page }) => {
    await openNewNote(page);
    await typeInEditor(page, '> > deep');
    expect(await quoteDepth(page)).toBe(2);
    expect(await savedNote(page)).toBe('> > deep');

    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    expect(await quoteDepth(page), 'one empty line steps out of the inner quote only').toBe(1);

    await page.keyboard.press('Enter');
    expect(await quoteDepth(page), 'a second steps out of the outer quote').toBe(0);
  });

  test('the quote the user typed survives the continuation', async ({ page }) => {
    await openNewNote(page);
    await typeInEditor(page, '> hello');
    await page.keyboard.press('Enter');

    expect(await editorMarkdown(page)).toContain('> hello');
  });
});
