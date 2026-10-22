// Part of the interactive-element parity suite: scope and input rules are in
// editor-embed-milkdown-interactive.spec.ts.

import { expect } from '@playwright/test';
import { getContent } from './lib/editorEmbedHost';
import {
  test,
  open,
  settled,
  reopen,
  paragraphLines,
  caretAtStartOf,
} from './lib/editorEmbedMilkdownInteractive';

// Enter at the very start of a quote (docs/spec/editor/paragraphs-and-lines.md).
// An empty line at the start of a quote is not written (Markdown house style),
// so the plain split there left the file `> ab` and the line vanished on reopen.
for (const [name, source, saved, above] of [
  ['a quote', '> ab', '\n> ab\n', ['']],
  ['a nested quote', '> > ab', '\n> > ab\n', ['']],
  ['a quote after a paragraph', 'x\n\n> ab', 'x\n\n\n> ab\n', ['x', '']],
] as const) {
  test(`Enter at the very start of ${name} puts an empty line above it, the text staying quoted`, async ({
    page,
  }) => {
    await open(page, source);
    await caretAtStartOf(page, 'ab');
    await page.keyboard.press('Enter');
    await page.keyboard.type('c');
    await settled(page);
    expect(await getContent(page)).toBe(saved.replace('ab', 'cab'));
    await page.keyboard.press('Backspace');
    await settled(page);
    expect(await getContent(page)).toBe(saved);
    await reopen(page, saved);
    expect((await paragraphLines(page)).slice(0, above.length)).toEqual(above);
    expect(await page.locator('.ProseMirror blockquote').first().innerText()).toBe('ab');
  });
}
