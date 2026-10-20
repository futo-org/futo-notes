// Part of the Milkdown toolbar suite: the parity model is described in
// editor-embed-milkdown-toolbar.spec.ts.

import { expect, type Page } from '@playwright/test';
import { flushFrames, focusEditor, getContent } from './lib/editorEmbedHost';
import { test, settle, hostSetContent, exec, selectAll } from './lib/editorEmbedMilkdownToolbar';

// ============================================================
// Link (QA-005) — opens the shared URL prompt, same as the desktop
// selection toolbar and the `/` menu's Link item (linkPrompt/).
// ============================================================

function linkUrlField(page: Page) {
  return page.locator('input[aria-label="Link URL"]');
}

test('link with a selection opens a URL field; Enter applies it over the selection', async ({
  page,
}) => {
  await hostSetContent(page, 'hello world');
  await focusEditor(page);
  await selectAll(page);
  await exec(page, 'link');

  const url = linkUrlField(page);
  await expect(url).toBeVisible();
  await expect(url).toBeFocused();
  await url.fill('https://example.test');
  await url.press('Enter');
  await settle(page);
  expect((await getContent(page)).trimEnd()).toBe('[hello world](https://example.test)');
});

test('link on an existing link prefills its href; emptying it removes the link', async ({
  page,
}) => {
  await hostSetContent(page, '[docs](https://example.com)');
  await focusEditor(page);
  // A selection strictly INSIDE the link's run, not `selectAll` — the whole
  // document here IS the link, and a selection all the way out to the doc's
  // own boundary resolves outside any textblock, which is not what a real
  // text selection landing on a link ever does. A double-click (word select)
  // is one atomic browser action, unlike click-then-Home/Shift+End, which
  // races the click's asynchronous selectionchange (AGENTS.md M15 — wait on a
  // condition, not a sleep, and this sidesteps the wait entirely).
  await page.getByText('docs', { exact: true }).first().dblclick();
  await flushFrames(page);
  await exec(page, 'link');

  const url = linkUrlField(page);
  await expect(url).toHaveValue('https://example.com');
  await url.fill('');
  await url.press('Enter');
  await settle(page);
  expect((await getContent(page)).trimEnd()).toBe('docs');
});

// The WYSIWYG equivalent of CodeMirror's `[]()` scaffold: there is no source
// text to put a caret into, so submitting inserts the URL as its own label
// and leaves it selected, ready to be typed straight over.
test('link with no selection inserts the URL as its own selected label', async ({ page }) => {
  await hostSetContent(page, 'x');
  await focusEditor(page);
  await exec(page, 'link');

  const url = linkUrlField(page);
  await expect(url).toBeVisible();
  await url.fill('https://example.test');
  await url.press('Enter');
  await settle(page);
  // The serializer's own autolink shorthand for a link whose label is
  // identical to its href — the same bytes as `[https://example.test](https://example.test)`.
  expect((await getContent(page)).trimEnd()).toBe('x<https://example.test>');

  // Still selected — typing replaces the label rather than appending after it.
  await page.keyboard.type('abc');
  await settle(page);
  expect((await getContent(page)).trimEnd()).toBe('x[abc](https://example.test)');
});

test('Escape in the link field leaves the note untouched', async ({ page }) => {
  await hostSetContent(page, 'hello world');
  await focusEditor(page);
  await selectAll(page);
  await exec(page, 'link');

  const url = linkUrlField(page);
  await url.fill('https://example.test');
  await url.press('Escape');
  await settle(page);
  expect((await getContent(page)).trimEnd()).toBe('hello world');
});

// F2 (P1) — a native note switch survives an open Link prompt. The native
// shells switch notes through `FutoEditor.setContent` (no click, no Escape —
// neither on-screen dismissal path runs), unlike desktop's `openNote`. A
// prompt left open from the PREVIOUS note holds that note's caret position;
// submitting it after the switch must not write into the new document.
test('a note switch through FutoEditor.setContent dismisses an open Link prompt', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await hostSetContent(page, 'hello world hello world');
  await focusEditor(page);
  await exec(page, 'link');

  const url = linkUrlField(page);
  await expect(url).toBeVisible();
  await url.fill('https://example.test');

  // The host adopts a different, much shorter note while the prompt is still
  // open and focused.
  await hostSetContent(page, 'x');

  await expect(url).not.toBeVisible();
  // Nothing left listening for this key should be able to write into the new
  // note at the old note's (now out-of-range) position.
  await page.keyboard.press('Enter');
  await settle(page);

  expect(pageErrors).toEqual([]);
  expect((await getContent(page)).trimEnd()).toBe('x');
});

// A bare CARET (no selection) sitting right at the edge of an existing link —
// reachable on a real phone via a selection-handle drag that resolves back to
// a collapsed caret (measured on Android: the Link button is lit from
// `formatState` at exactly this position). `linkRunAt` must be checked before
// the empty-selection branch, or this inserts a second, unrelated link glued
// to the first instead of editing the one under the caret.
test('a caret at the edge of an existing link (no selection) edits that link', async ({ page }) => {
  await hostSetContent(page, '[docs](https://example.com) tail');
  await focusEditor(page);
  await page.evaluate(() => {
    const view = (
      window as unknown as {
        __futoProseMirrorView: () => {
          state: {
            doc: unknown;
            selection: { constructor: { near(pos: unknown): unknown } };
            tr: { setSelection(s: unknown): unknown };
          };
          dispatch: (tr: unknown) => void;
        };
      }
    ).__futoProseMirrorView();
    // Position 5: right after "docs", still inside the link's run.
    const pos = (view.state.doc as { resolve(p: number): unknown }).resolve(5);
    const selection = view.state.selection.constructor.near(pos);
    view.dispatch(
      (view.state.tr.setSelection(selection) as { scrollIntoView(): unknown }).scrollIntoView(),
    );
  });
  await exec(page, 'link');

  const url = linkUrlField(page);
  await expect(url).toHaveValue('https://example.com');
  await url.fill('https://example.test/moved');
  await url.press('Enter');
  await settle(page);
  expect((await getContent(page)).trimEnd()).toBe('[docs](https://example.test/moved) tail');
});

// A phone-width WebView (360 CSS px, the Android release-smoke device): the
// prompt is wider than the room right of most carets, and once placed at the
// caret it ran ~15px off the right edge, cutting the Update button in half.
// The cases cover the left side, the right edge, a selection, and a screen
// narrower than the prompt itself.
const LINK_IN_PARAGRAPH = '[paragraph](example.org)';
const NEARLY_FULL_LINE = 'a line that runs nearly the whole width';
const NARROW_PROMPT_CASES: Array<[string, number, string, (page: Page) => Promise<void>]> = [
  [
    'a caret inside an existing link',
    360,
    LINK_IN_PARAGRAPH,
    (page) => page.getByText('paragraph', { exact: true }).first().click(),
  ],
  // `setContent` leaves the caret at the end of the document, which this
  // line's length puts near the right edge of a 360px column.
  ['a caret near the right edge', 360, NEARLY_FULL_LINE, async () => {}],
  [
    'a selection near the right edge',
    360,
    NEARLY_FULL_LINE,
    (page) => page.getByText('width', { exact: false }).first().dblclick(),
  ],
  [
    'a caret inside an existing link',
    300,
    LINK_IN_PARAGRAPH,
    (page) => page.getByText('paragraph', { exact: true }).first().click(),
  ],
];
for (const [where, width, markdown, place] of NARROW_PROMPT_CASES) {
  test(`at ${width}px wide, the link prompt for ${where} stays inside the viewport`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 640 });
    await hostSetContent(page, markdown);
    await focusEditor(page);
    await place(page);
    await flushFrames(page);
    await exec(page, 'link');

    const url = linkUrlField(page);
    await expect(url).toBeVisible();
    const prompt = page.locator('.futo-selection-toolbar').filter({ has: url });
    for (const part of [prompt, url, prompt.locator('.futo-selection-toolbar-apply')]) {
      const box = await part.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    }
  });
}
