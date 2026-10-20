// Part of the Milkdown parity suite: what it covers and why is described in
// editor-embed-milkdown-parity.spec.ts.

import { expect, type Page } from '@playwright/test';
import { extractTags } from '../packages/editor/src/tags';
import { flushFrames, getContent, type FakeHostWindow } from './lib/editorEmbedHost';
import { test, CHANGE_DEBOUNCE_MS, open, typeAtEnd } from './lib/editorEmbedMilkdownParity';

// ============================================================
// Fenced code highlighting
// ============================================================

/** Waits for the fence's grammar to arrive — it is fetched on first use. */
async function waitForTokens(page: Page): Promise<void> {
  await page.locator('.ProseMirror pre .tok-keyword').first().waitFor({ timeout: 10_000 });
}

test('a fence in a curated language is coloured', async ({ page }) => {
  await open(page, '```js\nconst greeting = "hi";\n```\n');
  await waitForTokens(page);
  await expect(page.locator('.ProseMirror pre .tok-keyword')).toHaveText('const');
  await expect(page.locator('.ProseMirror pre .tok-string')).toHaveText('"hi"');
});

test('a language alias is matched, not just the canonical name', async ({ page }) => {
  await open(page, '```rs\nfn main() {}\n```\n');
  await waitForTokens(page);
  await expect(page.locator('.ProseMirror pre .tok-keyword')).toHaveText('fn');
});

test('a fence outside the curated set still renders, just uncoloured', async ({ page }) => {
  await open(page, '```mermaid\ngraph TD\n```\n');
  await flushFrames(page);
  await expect(page.locator('.ProseMirror pre')).toHaveText('graph TD');
  await expect(page.locator('.ProseMirror pre span')).toHaveCount(0);
});

test('a fence with no language still renders, just uncoloured', async ({ page }) => {
  await open(page, '```\nplain text\n```\n');
  await flushFrames(page);
  await expect(page.locator('.ProseMirror pre')).toHaveText('plain text');
  await expect(page.locator('.ProseMirror pre span')).toHaveCount(0);
});

test('the shared token palette reaches this editor without a per-fence class', async ({ page }) => {
  // The colours are scoped by container, not by a decoration on each fence —
  // one node decoration per fence made every keystroke cost O(fences)
  // (codeHighlight.ts). So the proof is that a token is COLOURED, and that no
  // per-fence marker class exists to be relied on.
  await open(page, '```js\nlet a = 1;\n```\n');
  await waitForTokens(page);
  await expect(page.locator('.ProseMirror pre.futo-code-tokens')).toHaveCount(0);
  const [color, muted] = await page.evaluate(() => {
    const token = document.querySelector('.ProseMirror pre .tok-keyword');
    return [
      token ? getComputedStyle(token).color : null,
      getComputedStyle(document.querySelector('.ProseMirror pre')!).color,
    ];
  });
  expect(color).not.toBeNull();
  expect(color).not.toBe(muted);
});

test('token colours come from the theme, and follow it', async ({ page }) => {
  await open(page, '```js\nconst a = 1;\n```\n');
  await waitForTokens(page);
  const light = await page
    .locator('.ProseMirror pre .tok-keyword')
    .evaluate((el) => getComputedStyle(el).color);

  await page.evaluate(() => (window as unknown as FakeHostWindow).FutoEditor.setTheme('dark'));
  await flushFrames(page);
  const dark = await page
    .locator('.ProseMirror pre .tok-keyword')
    .evaluate((el) => getComputedStyle(el).color);

  expect(light).not.toBe('rgba(0, 0, 0, 0)');
  expect(dark).not.toBe(light);
});

test('editing inside a fence re-colours it', async ({ page }) => {
  await open(page, '```js\nconst a = 1;\n```\n');
  await waitForTokens(page);

  await page.locator('.ProseMirror pre').click();
  // NOT Control+End: this doc's last (only) node is a code_block, so
  // "move to document end" lands in ProseMirror's gap cursor position AFTER
  // the fence rather than inside its text — confirmed by a CI failure
  // artifact (pipeline 36709, job 256798) whose page snapshot showed
  // "let b = 2;" as a sibling paragraph below an empty paragraph, both
  // outside the `<pre>`, instead of a second line inside it. Every other
  // Control+End caller in this suite targets a doc that ends in an ordinary
  // paragraph, where there is no gap to land in — this fence fixture is the
  // only one where the browser-native "end of editable" landing spot is
  // ambiguous. `End` stays scoped to the current line within the textblock
  // ProseMirror already has focus in, with no cross-node gap involved, and
  // this fence is one line, so end-of-line is end-of-content.
  await page.keyboard.press('End');
  await page.keyboard.type('\nlet b = 2;');
  await page.waitForTimeout(CHANGE_DEBOUNCE_MS + 120);

  await expect(page.locator('.ProseMirror pre .tok-keyword')).toHaveCount(2);
  expect(await getContent(page)).toContain('let b = 2;');
});

test('editing one fence leaves the next one coloured', async ({ page }) => {
  // Regression: decorations were removed by everything TOUCHING the edited
  // block's range, and the next fence's node decoration starts exactly where
  // this one ends — so typing in the first fence stripped the second one's
  // highlighting and nothing put it back.
  await open(page, '```js\nconst a = 1;\n```\n\n```js\nconst b = 2;\n```\n');
  await waitForTokens(page);
  await expect(page.locator('.ProseMirror pre .tok-keyword')).toHaveCount(2);

  await page.locator('.ProseMirror pre').first().click();
  await page.keyboard.type(' ');
  await page.waitForTimeout(CHANGE_DEBOUNCE_MS + 120);

  await expect(page.locator('.ProseMirror pre').nth(1).locator('.tok-keyword')).toHaveText('const');
});

test('a fence typed into a note gets coloured once its grammar arrives', async ({ page }) => {
  await open(page, '```python\ndef f():\n    return 1\n```\n');
  await waitForTokens(page);
  await expect(page.locator('.ProseMirror pre .tok-keyword').first()).toHaveText('def');
});

test('tags and checkboxes and fences all survive one round trip together', async ({ page }) => {
  const note =
    '#alpha\n\n- [ ] todo\n- [x] done\n\n```js\nconst a = 1;\n```\n\nBody #inline here\n';
  await open(page, note);
  await typeAtEnd(page);

  const saved = await getContent(page);
  expect(extractTags(saved)).toEqual(extractTags(note));
  expect(saved).toContain('[ ] todo');
  expect(saved).toContain('[x] done');
  expect(saved).toContain('```js\nconst a = 1;\n```');
});
