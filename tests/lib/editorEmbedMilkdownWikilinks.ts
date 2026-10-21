// The page fixture, vault and caret helpers shared by the editor-embed-milkdown-wikilinks*.spec.ts
// suites, moved here verbatim from editor-embed-milkdown-wikilinks.spec.ts.

import type { Page } from '@playwright/test';
import { flushFrames, withCaretObserved } from './editorEmbedHost';
import { embedTest, hostConfig, initialize, settleChangeDebounce } from './editorEmbedSpec';

export { settleChangeDebounce };
export const VAULT = [
  { id: 'Projects/Roadmap', title: 'Roadmap', modifiedMs: 3 },
  { id: 'Archive/2024/Roadmap', title: 'Roadmap', modifiedMs: 2 },
  { id: 'grocery list', title: 'grocery list', modifiedMs: 1 },
  { id: 'work/notes/ideas', title: 'ideas', modifiedMs: 0 },
];

export const test = embedTest;

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
  await initialize(
    page,
    hostConfig({ content, ...(notes ? { notesJson: JSON.stringify(notes) } : {}) }),
  );
}

export const chip = (page: Page) => page.locator('.ProseMirror a[data-wikilink]');
