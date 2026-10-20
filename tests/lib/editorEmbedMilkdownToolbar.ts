// The page fixture and command helpers shared by the editor-embed-milkdown-toolbar*.spec.ts
// suites, moved here verbatim from editor-embed-milkdown-toolbar.spec.ts.

import { test as base, type Page } from '@playwright/test';
import { EDITOR_URL } from '../editorEmbedBundle';
import {
  flushFrames,
  focusEditor,
  getContent,
  installFakeAndroidHost,
  type FakeHostWindow,
} from './editorEmbedHost';

/** @milkdown/plugin-listener debounces `markdownUpdated` by 200 ms (trailing). */
const CHANGE_DEBOUNCE_MS = 200;

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

export async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(CHANGE_DEBOUNCE_MS + 80);
  await flushFrames(page);
}

export async function hostSetContent(page: Page, markdown: string): Promise<void> {
  await page.evaluate(
    (md) => (window as unknown as FakeHostWindow).FutoEditor.setContent('test-note', md),
    markdown,
  );
  await settle(page);
}

export async function exec(page: Page, ...ids: string[]): Promise<void> {
  for (const id of ids) {
    await page.evaluate(
      (commandId) =>
        (
          window as unknown as FakeHostWindow & { FutoEditor: { exec(id: string): void } }
        ).FutoEditor.exec(commandId),
      id,
    );
    await settle(page);
  }
}

/** Put the caret in the block whose rendered text is `text`. */
export async function caretIn(page: Page, text: string): Promise<void> {
  await page.getByText(text, { exact: true }).first().click();
  await flushFrames(page);
}

/**
 * Select the whole document with a real Ctrl/Cmd-A. Triple-click is not usable
 * here: over a rendered `<a>` it resolves to the word, not the block.
 */
export async function selectAll(page: Page): Promise<void> {
  await page.keyboard.press('ControlOrMeta+a');
  await flushFrames(page);
}

/**
 * Load `markdown`, run `ids`, and return the markdown the editor produces.
 * Loading leaves the caret at the end of the document, which is the block
 * every single-block case here is about.
 */
export async function afterExec(page: Page, markdown: string, ...ids: string[]): Promise<string> {
  await hostSetContent(page, markdown);
  await focusEditor(page);
  await exec(page, ...ids);
  return (await getContent(page)).trimEnd();
}
