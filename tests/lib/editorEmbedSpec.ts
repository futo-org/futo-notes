import { test as base, type Page } from '@playwright/test';

import { BRIDGE_VERSION } from '@futo-notes/editor';

import { EDITOR_URL } from '../editorEmbedBundle';
import { flushFrames, openEmbed, type FakeHostWindow } from './editorEmbedHost';

/**
 * Spec-side helpers shared by the `editor-embed-milkdown*` suites: the default
 * page fixture and the host's `initialize` / `setContent` calls.
 *
 * Not in `editorEmbedHost.ts` because that module also loads under
 * `node --experimental-strip-types` (scripts/perf/editor-bench.mjs), which
 * cannot resolve `@futo-notes/editor` or an extensionless import.
 */

/** @milkdown/plugin-listener debounces `markdownUpdated` by 200 ms (trailing). */
export const CHANGE_DEBOUNCE_MS = 200;

/**
 * Bounded wait for "no message arrives". Asserting an ABSENCE needs a window,
 * and the only honest one is the debounce the editor actually runs on.
 */
export async function settleChangeDebounce(page: Page): Promise<void> {
  await page.waitForTimeout(CHANGE_DEBOUNCE_MS + 80);
  await flushFrames(page);
}

/** `editor.html` with the fake host installed and its `ready` already posted. */
export const embedTest = base.extend<{ page: Page }>({
  page: async ({ browser }, use) => {
    const { context, page } = await openEmbed(browser, EDITOR_URL);
    await use(page);
    await context.close();
  },
});

export function hostConfig(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    bridgeVersion: BRIDGE_VERSION,
    noteId: 'test-note',
    theme: 'light',
    content: '',
    nativeToolbar: true,
    contentPaddingInlinePx: 14,
    ...overrides,
  });
}

export async function initialize(page: Page, configJson: string): Promise<void> {
  await page.evaluate(
    (json) => (window as unknown as FakeHostWindow).FutoEditor.initialize(json),
    configJson,
  );
  await flushFrames(page);
}

export async function hostSetContent(page: Page, markdown: string): Promise<void> {
  await page.evaluate(
    (md) => (window as unknown as FakeHostWindow).FutoEditor.setContent('test-note', md),
    markdown,
  );
  await settleChangeDebounce(page);
}

/**
 * A note past the 400-line threshold, so it takes the progressive path. Kept
 * only as large as the assertion needs: mounting tens of thousands of blocks
 * per test leaves enough browser pressure to make the suite's mouse-click
 * tests miss, which is a flake this suite pays for and learns nothing from.
 */
export function largeNote(paragraphs = 800): string {
  return (
    Array.from(
      { length: paragraphs },
      (_, i) => `## Section ${i}\n\nBody line ${i} with some **bold** and a [link](https://e.com).`,
    ).join('\n\n') + '\n'
  );
}
