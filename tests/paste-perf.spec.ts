import { expect, type Page, test } from '@playwright/test';

import { EDITOR } from './lib/desktopEditor';

async function openNewNote(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.goto('/#/note/new');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector(EDITOR, { timeout: 10000 });
}

async function measurePasteMs(page: Page, itemCount: number, correctlyNumbered: boolean) {
  return page.evaluate(
    async ({ itemCount, correctlyNumbered, selector }) => {
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

      const content = document.querySelector(selector) as HTMLElement;
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
    { itemCount, correctlyNumbered, selector: EDITOR },
  );
}

// A large single paste must stay proportional to its size. Issue #84 reported a
// multi-second freeze on the CodeMirror engine, where a pasted numbered list
// whose numbering was WRONG (an exported or hand-written list of all "1."
// items) cost one source edit per item across three quadratic paths.
//
// None of those paths exist any more: the paste is parsed into a single `<ol>`
// and the numbers are the browser's own rendering, so the "renumber" is free
// and only remark-stringify's serialize walks the list. The test is kept
// because the PROPERTY is the product's, not the engine's — a big paste must
// not freeze the app — and it is the only thing that would catch a new
// quadratic arriving in the parse or the serialize. Both shapes are still
// measured: the all-1s list still comes back renumbered (asserted below), so
// it still proves the expensive path ran.
//
// Drive the paste through a ClipboardEvent because that is the path the
// editor's own paste handling serves. Do NOT measure this with CDP
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
  await page.click(EDITOR);

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

  // Measured basis on the Milkdown engine (2026-09-01, Chromium — the only
  // engine this suite runs): needs-renumber 131ms at 1250 items / 335ms at
  // 5000, ratio 2.6x; already-numbered 85ms / 298ms, ratio 3.5x. Quadratic
  // cost would be ~16x for 4x the items. The budgets at real note sizes, with
  // hard millisecond gates rather than a ratio, are
  // `just gauntlet-milkdown-perf` (desktop) and `just test-android-perf` (the
  // low-end reference phone).
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
