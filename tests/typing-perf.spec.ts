import { expect, type Page, test } from '@playwright/test';

async function openNewNote(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.goto('/#/note/new');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.cm-content', { timeout: 10000 });
}

test('typing latency in a large note is viewport-bounded, not O(document)', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => {
    pageErrors.push(error.message);
  });

  await openNewNote(page);

  // Never page.keyboard here: CDP's Input.insertText is quadratic in document
  // length on a contenteditable (~10s vs ~30ms for a real paste), so it
  // measures the harness, not the editor.
  const timings = await page.evaluate(() => {
    interface NotesShellTestHook {
      replaceEditorContent: (content: string) => string;
      typeInEditor: (text: string) => string;
    }

    const testWindow = window as typeof window & { __notesShellTest: NotesShellTestHook };
    const blocks = Array.from({ length: 32000 }, (_, index) => {
      switch (index % 4) {
        case 0:
          return `paragraph ${index}`;
        case 1:
          return `# heading ${index}`;
        case 2:
          return `- bullet ${index}`;
        default:
          return `> quote ${index}`;
      }
    });
    const doc = blocks.join('\n\n');

    testWindow.__notesShellTest.replaceEditorContent(doc);
    for (let index = 0; index < 5; index += 1) {
      testWindow.__notesShellTest.typeInEditor('x');
    }

    const measured: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      const startedAt = performance.now();
      testWindow.__notesShellTest.typeInEditor('x');
      measured.push(performance.now() - startedAt);
    }
    return measured.sort((left, right) => left - right);
  });

  const median = timings[Math.floor(timings.length / 2)];
  // Measured basis (local Chromium, 2026-07-29): viewport-bounded keystrokes
  // median ~28 ms at 32k blocks (mostly the hook's per-keystroke
  // doc.toString(); real dispatch is single-digit ms), while re-scanning the
  // whole document per keystroke — the regression this guards — measures
  // ~700 ms and grows with note size. 60 ms separates both with margin; do
  // not fix a failure here by raising the budget.
  console.log(
    `typing median ${median.toFixed(1)}ms (sorted: ${timings.map((t) => t.toFixed(0)).join(',')})`,
  );
  expect(median).toBeLessThanOrEqual(60);
  expect(pageErrors).toEqual([]);
});
