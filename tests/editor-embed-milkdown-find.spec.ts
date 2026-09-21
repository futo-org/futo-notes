import { expect, test as base, type Page } from '@playwright/test';

import { EDITOR_URL } from './editorEmbedBundle';
import {
  clearMessages,
  flushFrames,
  messagesOfType,
  openEmbed,
  type BridgeMessage,
  type FakeHostWindow,
} from './lib/editorEmbedHost';

/**
 * Find in note over the futoBridge, Milkdown engine — executable.
 *
 * The iOS and Android find bars are native chrome that owns NO find logic
 * (docs/spec/editor.md): they call `openFind`/`setFindQuery`/`stepFind`/
 * `setFindOverlayInset`/`closeFind` and render the `findMatches` report the
 * page posts back, verbatim. This drives exactly those five calls against the
 * same single-file `editor.html` the shells ship, and asserts on the messages —
 * which is the whole of what a native bar can see.
 *
 * The desktop panel must never appear here: the bundle runs with
 * `nativeShell: true`, and a web bar under a native one would be two bars.
 */

const test = base.extend<{ page: Page }>({
  page: async ({ browser }, use) => {
    const { context, page } = await openEmbed(browser, EDITOR_URL);
    await use(page);
    await context.close();
  },
});

const PANEL = '.futo-find-panel';
const MATCH = '.futo-find-match';
const CURRENT = '.futo-find-match-current';

async function seed(page: Page, markdown: string): Promise<void> {
  await page.evaluate(
    (text) => (window as unknown as FakeHostWindow).FutoEditor.setContent(text),
    markdown,
  );
  await flushFrames(page);
  await clearMessages(page);
}

async function lastFindReport(page: Page): Promise<BridgeMessage | undefined> {
  await flushFrames(page);
  return (await messagesOfType(page, 'findMatches')).at(-1);
}

test('the engine answers the native find calls and never mounts the web panel', async ({
  page,
}) => {
  await seed(page, 'cat dog CAT concatenate');

  await page.evaluate(() => (window as unknown as FakeHostWindow).FutoEditor.openFind());
  await expect(page.locator(PANEL)).toHaveCount(0);
  expect(await lastFindReport(page)).toEqual({
    type: 'findMatches',
    query: '',
    current: 0,
    total: 0,
    label: '0',
  });

  await page.evaluate(() => (window as unknown as FakeHostWindow).FutoEditor.setFindQuery('cat'));
  expect(await lastFindReport(page)).toEqual({
    type: 'findMatches',
    query: 'cat',
    current: 1,
    total: 3,
    label: '1 of 3',
  });
  await expect(page.locator(MATCH)).toHaveCount(3);
  await expect(page.locator(CURRENT)).toHaveCount(1);

  await page.evaluate(() => (window as unknown as FakeHostWindow).FutoEditor.stepFind(1));
  expect(await lastFindReport(page)).toMatchObject({ current: 2, total: 3, label: '2 of 3' });

  await page.evaluate(() => (window as unknown as FakeHostWindow).FutoEditor.closeFind());
  await expect(page.locator(MATCH)).toHaveCount(0);
});

test('stepping wraps at both ends', async ({ page }) => {
  await seed(page, 'cat\n\ncat\n\ncat');
  await page.evaluate(() => {
    const api = (window as unknown as FakeHostWindow).FutoEditor;
    api.openFind();
    api.setFindQuery('cat');
  });
  expect(await lastFindReport(page)).toMatchObject({ current: 1, total: 3 });

  const step = (delta: number): Promise<void> =>
    page.evaluate((d) => (window as unknown as FakeHostWindow).FutoEditor.stepFind(d), delta);

  await step(1);
  await step(1);
  expect(await lastFindReport(page)).toMatchObject({ current: 3 });
  await step(1);
  expect(await lastFindReport(page)).toMatchObject({ current: 1 });
  await step(-1);
  expect(await lastFindReport(page)).toMatchObject({ current: 3 });
});

test('a query that matches nothing reports 0 and every step is a no-op', async ({ page }) => {
  await seed(page, 'cat dog');
  await page.evaluate(() => {
    const api = (window as unknown as FakeHostWindow).FutoEditor;
    api.openFind();
    api.setFindQuery('zebra');
  });

  expect(await lastFindReport(page)).toMatchObject({
    query: 'zebra',
    current: 0,
    total: 0,
    label: '0',
  });
  await expect(page.locator(MATCH)).toHaveCount(0);

  await page.evaluate(() => (window as unknown as FakeHostWindow).FutoEditor.stepFind(1));
  expect(await lastFindReport(page)).toMatchObject({ current: 0, total: 0 });
});

test('editing while find is open recounts without moving the caret', async ({ page }) => {
  await seed(page, 'cat dog');
  await page.evaluate(() => {
    const api = (window as unknown as FakeHostWindow).FutoEditor;
    api.openFind();
    api.setFindQuery('cat');
  });
  expect(await lastFindReport(page)).toMatchObject({ total: 1 });

  // Real typing at the end of the note, the way a user edits with the bar up.
  await page.locator('.ProseMirror').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' cat', { delay: 40 });

  await expect.poll(async () => (await lastFindReport(page))?.total, { timeout: 5_000 }).toBe(2);
  // The caret stayed where the typing was — find never selected for an edit.
  expect(
    await page.evaluate(() => {
      const selection = window.getSelection();
      return selection ? selection.isCollapsed : null;
    }),
  ).toBe(true);
});

test('closing restores the selection and the viewport from before find opened', async ({
  page,
}) => {
  const filler = Array.from({ length: 200 }, (_, index) => `line ${index}`).join('\n\n');
  await seed(page, `${filler}\n\nneedle here`);

  const scrollTop = (): Promise<number> =>
    page.evaluate(() => document.querySelector('.ProseMirror')?.scrollTop ?? 0);
  expect(await scrollTop()).toBe(0);

  await page.evaluate(() => {
    const api = (window as unknown as FakeHostWindow).FutoEditor;
    api.openFind();
    api.setFindQuery('needle');
  });
  await expect.poll(scrollTop, { timeout: 5_000 }).toBeGreaterThan(0);

  await page.evaluate(() => (window as unknown as FakeHostWindow).FutoEditor.closeFind());
  await expect(page.locator(MATCH)).toHaveCount(0);
  await expect.poll(scrollTop, { timeout: 5_000 }).toBe(0);
});

test('a declared overlay inset keeps the current match above the bar', async ({ page }) => {
  const filler = Array.from({ length: 200 }, (_, index) => `line ${index}`).join('\n\n');
  await seed(page, `${filler}\n\nneedle here`);

  const INSET = 220;
  await page.evaluate((inset) => {
    const api = (window as unknown as FakeHostWindow).FutoEditor;
    api.openFind();
    api.setFindOverlayInset(inset);
    api.setFindQuery('needle');
  }, INSET);

  await expect.poll(async () => page.locator(CURRENT).count(), { timeout: 5_000 }).toBe(1);
  await flushFrames(page);

  const clearance = await page.evaluate((inset) => {
    const match = document.querySelector('.futo-find-match-current');
    const scroller = document.querySelector('.ProseMirror');
    if (!match || !scroller) return null;
    return scroller.getBoundingClientRect().bottom - inset - match.getBoundingClientRect().bottom;
  }, INSET);

  expect(clearance).not.toBeNull();
  expect(clearance ?? -1).toBeGreaterThanOrEqual(0);
});
