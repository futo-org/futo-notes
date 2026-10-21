// The page fixture and command helpers shared by the editor-embed-milkdown-toolbar*.spec.ts
// suites, moved here verbatim from editor-embed-milkdown-toolbar.spec.ts.

import type { Page } from '@playwright/test';
import { flushFrames, focusEditor, getContent, type FakeHostWindow } from './editorEmbedHost';
import { embedTest, hostSetContent, settleChangeDebounce } from './editorEmbedSpec';

export { hostSetContent };
export const test = embedTest;
export const settle = settleChangeDebounce;

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
