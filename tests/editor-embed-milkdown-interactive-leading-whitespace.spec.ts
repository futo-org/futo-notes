// Part of the interactive-element parity suite: scope and input rules are in
// editor-embed-milkdown-interactive.spec.ts.

import { expect } from '@playwright/test';
import { getContent } from './lib/editorEmbedHost';
import {
  test,
  settled,
  reopen,
  paragraphLines,
  openAtEnd,
} from './lib/editorEmbedMilkdownInteractive';

// ============================================================
// Whitespace typed at the start of a paragraph's line (docs/spec/editor/
// markdown-house-style.md "Text and escaping"). It showed until the note was
// reopened: the save dropped it (`one\ntwo`), since a read drops raw
// line-start whitespace. The first character is written as a reference, so
// the read keeps the whole run.
// ============================================================

test('spaces typed at the start of a line are saved, and shown again on reopen', async ({
  page,
}) => {
  await openAtEnd(page, 'one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('  two');
  await settled(page);
  const saved = await getContent(page);
  expect(saved).toBe('one\n&#x20; two\n');
  expect(await paragraphLines(page)).toEqual(['one\n  two']);
  await reopen(page, saved);
  expect(await paragraphLines(page)).toEqual(['one\n  two']);
  expect(await getContent(page)).toBe(saved);
});

test("four spaces typed at a paragraph's first line stay text, not indented code, on reopen", async ({
  page,
}) => {
  await openAtEnd(page, 'one');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('    four');
  await settled(page);
  const saved = await getContent(page);
  expect(saved).toBe('one\n\n&#x20;   four\n');
  await reopen(page, saved);
  expect(await paragraphLines(page)).toEqual(['one', '    four']);
  expect(await page.locator('.ProseMirror pre').count()).toBe(0);
});
