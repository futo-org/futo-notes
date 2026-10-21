// Large-note builders and stream waits shared by the editor-embed-milkdown
// progressive-open specs and the note-switch spec.

import { expect, type Page } from '@playwright/test';
import { readTailWatch } from './editorEmbedMilkdown';
import { largeNote, settleChangeDebounce } from './editorEmbedSpec';

export { largeNote };

/**
 * Resolves once the streaming affordance has come and gone — and FAILS if it
 * never came.
 *
 * Waiting only for `detached` would resolve instantly for a note the chunk
 * planner declined, and every assertion after it would then pass while
 * exercising the ordinary whole-document load: a test going green having
 * checked nothing (AGENTS.md M11). The planner's decline conditions are
 * exactly the kind of thing a later change moves.
 */
export async function waitForStreamComplete(page: Page): Promise<void> {
  await page.waitForSelector('.milkdown-stream-tail', { state: 'detached', timeout: 60000 });
  expect(
    (await readTailWatch(page)).seen,
    'this note never took the progressive path — the assertions below prove nothing',
  ).toBe(true);
  await settleChangeDebounce(page);
}
