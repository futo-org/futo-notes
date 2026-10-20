// The page fixture, vault and caret helpers shared by the editor-embed-milkdown-wikilinks*.spec.ts
// suites, moved here verbatim from editor-embed-milkdown-wikilinks.spec.ts.

import { test as base, type Page } from '@playwright/test';
import { BRIDGE_VERSION } from '@futo-notes/editor';
import { EDITOR_URL } from '../editorEmbedBundle';
import {
  flushFrames,
  installFakeAndroidHost,
  withCaretObserved,
  type FakeHostWindow,
} from './editorEmbedHost';

/** @milkdown/plugin-listener debounces `markdownUpdated` by 200 ms (trailing). */
const CHANGE_DEBOUNCE_MS = 200;

export const VAULT = [
  { id: 'Projects/Roadmap', title: 'Roadmap', modifiedMs: 3 },
  { id: 'Archive/2024/Roadmap', title: 'Roadmap', modifiedMs: 2 },
  { id: 'grocery list', title: 'grocery list', modifiedMs: 1 },
  { id: 'work/notes/ideas', title: 'ideas', modifiedMs: 0 },
];

export const test = base.extend<{ page: Page }>({
  page: async ({ browser }, use) => {
    const context = await browser.newContext({ hasTouch: true });
    await context.addInitScript(installFakeAndroidHost);
    const page = await context.newPage();
    await page.goto(EDITOR_URL);
    await page.waitForFunction(() =>
      (window as unknown as FakeHostWindow).__msgs?.some((m) => m.type === 'ready'),
    );
    await use(page);
    await context.close();
  },
});

export async function settleChangeDebounce(page: Page): Promise<void> {
  await page.waitForTimeout(CHANGE_DEBOUNCE_MS + 80);
  await flushFrames(page);
}

/**
 * One key that moves the caret, returning only once ProseMirror has read the new
 * caret out of the DOM (`withCaretObserved`). `page.keyboard.press` resolves in
 * ~2 ms but the browser reports the caret to ProseMirror on the next rendering
 * update, so on a loaded runner the next key (or the typed `[[`) acted on the
 * PREVIOUS caret: RC-100 saw the popup open because the caret was still outside
 * the code span. The key MUST really move the caret, or there is nothing to
 * wait for.
 */
export async function moveCaret(page: Page, key: string, times = 1): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await withCaretObserved(page, () => page.keyboard.press(key));
  }
}

/**
 * `End` after `focusEditor`. The caret may already BE at the end (`focus()` leaves
 * it there for a one-paragraph note), so no selection change is guaranteed and
 * `withCaretObserved` would wait for ever: settle on rendering frames instead,
 * which is when the browser reports a pending caret to ProseMirror.
 */
export async function goToEnd(page: Page): Promise<void> {
  await page.keyboard.press('End');
  await flushFrames(page);
}

/** Boots the bundle exactly as a native host does: one `initialize` call. */
export async function open(
  page: Page,
  content: string,
  notes: typeof VAULT | null = VAULT,
): Promise<void> {
  const config = JSON.stringify({
    bridgeVersion: BRIDGE_VERSION,
    noteId: 'test-note',
    theme: 'light',
    content,
    nativeToolbar: true,
    contentPaddingInlinePx: 14,
    ...(notes ? { notesJson: JSON.stringify(notes) } : {}),
  });
  await page.evaluate(
    (json) => (window as unknown as FakeHostWindow).FutoEditor.initialize(json),
    config,
  );
  await flushFrames(page);
}

export const chip = (page: Page) => page.locator('.ProseMirror a[data-wikilink]');
