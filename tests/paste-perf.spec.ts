import { expect, type Page, test } from '@playwright/test';

async function openNewNote(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.goto('/#/note/new');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.cm-content', { timeout: 10000 });
}

async function measurePasteMs(page: Page, itemCount: number, correctlyNumbered: boolean) {
  return page.evaluate(
    async ({ itemCount, correctlyNumbered }) => {
      interface NotesShellTestHook {
        replaceEditorContent: (content: string) => string;
        getState: () => { editorContent: string };
      }
      const testWindow = window as typeof window & { __notesShellTest: NotesShellTestHook };
      testWindow.__notesShellTest.replaceEditorContent('');
      await new Promise((resolve) => setTimeout(resolve, 300));

      const pasted = Array.from(
        { length: itemCount },
        (_, index) => `${correctlyNumbered ? index + 1 : 1}. item number ${index}`,
      ).join('\n');

      const content = document.querySelector('.cm-content') as HTMLElement;
      content.focus();
      const transfer = new DataTransfer();
      transfer.setData('text/plain', pasted);

      const startedAt = performance.now();
      content.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
      );
      const measured = performance.now() - startedAt;

      const landed = testWindow.__notesShellTest.getState().editorContent;
      if (landed.length === 0) throw new Error('paste did not land in the editor');
      // A list pasted as all-ones must come back renumbered, so the expensive
      // path really did run rather than being skipped.
      if (!correctlyNumbered && !landed.startsWith('1. item number 0\n2. item number 1')) {
        throw new Error(`renumber did not run: ${landed.slice(0, 60)}`);
      }
      return measured;
    },
    { itemCount, correctlyNumbered },
  );
}

// A large single paste must stay proportional to its size. Issue #84 reported a
// multi-second freeze. The expensive shape is a pasted numbered list whose
// numbering is WRONG (an exported or hand-written list of all "1." items),
// because renumbering it is then one edit per item, and three paths scaled with
// that count: orderedListRenumber gave every affected line its own backward walk
// to its list-block start; interactiveTableEditor expanded a change out to its
// enclosing markdown block once per change; and the renumber dispatched one
// change range per item rather than one per list block (~1.7x slower on desktop).
// A list that is ALREADY correctly numbered emits no edits and so never exercised
// the last two — which is why both shapes are measured here.
//
// Drive the paste through a ClipboardEvent because that is the path
// CodeMirror's own paste handler serves. Do NOT measure this with CDP
// `Input.insertText` (`page.keyboard.insertText`): a bare contenteditable with
// no application code shows the same quadratic under it, because the browser
// splits the insertion into quadratically many editing operations. That is the
// M21 trap — it measures the harness, not the app.
test('pasting a large ordered list stays proportional to paste size', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => {
    pageErrors.push(error.message);
  });

  await openNewNote(page);
  await page.click('.cm-content');

  // Compare the same shape at two sizes rather than checking a duration. A wall
  // clock measures the machine — a busy one made even the cheap shape 44x slower
  // here, which no fixed budget survives — while the ratio measures the property
  // this guards. Quadratic cost is ~16x for 4x the items; linear is at most ~4x.
  const results: Record<string, { small: number; large: number; ratio: number }> = {};
  for (const [shape, correctlyNumbered] of [
    ['needs-renumber', false],
    ['already-numbered', true],
  ] as const) {
    const small = await measurePasteMs(page, 1250, correctlyNumbered);
    const large = await measurePasteMs(page, 5000, correctlyNumbered);
    // Floor the divisor: a sub-millisecond baseline would make any ratio explode.
    results[shape] = { small, large, ratio: large / Math.max(small, 5) };
  }

  // Measured basis (2026-08-05, Chromium — the only engine this suite runs):
  // ratios ~1.2-2.5 after the fix, ~12-16 before it. The sharp machine-independent
  // guards on the same property are the unit tests, which bound line reads and
  // change-range count: `listContinuation.test.ts` (2,003,001 reads before, under
  // 20,000 after; 499 change ranges before, 1 after) and
  // `table/interactiveTableEditor.test.ts` (159,601 reads before, under 3,200).
  // Fix a failure here by finding the regression those describe.
  for (const [shape, { small, large, ratio }] of Object.entries(results)) {
    console.log(
      `${shape}: 1250 items ${small.toFixed(1)}ms, 5000 items ${large.toFixed(1)}ms, ratio ${ratio.toFixed(1)}x`,
    );
  }
  // Only the expensive shape is gated. The cheap one runs in single-digit ms, so its
  // ratio is mostly fixed overhead and swings 1.5x-4.7x run to run; its quadratic is
  // locked deterministically by the line-read bound in listContinuation.test.ts.
  expect(results['needs-renumber'].ratio).toBeLessThanOrEqual(8);
  expect(pageErrors).toEqual([]);
});
