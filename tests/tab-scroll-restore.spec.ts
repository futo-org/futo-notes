import { expect, test, type Page } from '@playwright/test';

import { EDITOR, openNewNote } from './lib/desktopEditor';

/**
 * Per-tab scroll position persists (docs/spec/tabs.md) — including for a note
 * large enough to open progressively (progressiveLoad.ts).
 *
 * Such a note mounts its first chunk synchronously and streams the rest in idle
 * slices, so for the first frames after a tab switch the document is far
 * shorter than the offset the tab saved. Applied then, the browser clamped the
 * restore to that partial height, and the view rode the bottom of the note as
 * the remaining chunks appended: a note left at 50 000px came back near
 * 148 000px. A note that fits in one chunk always restored exactly, which is
 * why the bug only showed on large notes.
 */

/** A note of ~7.5k lines, mixed blocks, about 150 000px tall in the shell. */
function largeNote(tag: string, sections: number): string {
  const out = [`# ${tag} TOP`, ''];
  for (let i = 0; i < sections; i += 1) {
    out.push(`## ${tag} section ${i}`, '');
    out.push(
      `Paragraph ${tag}-${i} with **bold**, *italic*, \`code\` and a [link](https://example.com/${i}).`,
      '',
    );
    out.push(`- item ${tag}-${i}-a`, `- item ${tag}-${i}-b`, `  - nested ${tag}-${i}-c`, '');
    out.push(`- [ ] task ${tag}-${i}`, '');
    out.push('```js', `const v${i} = "${tag}-${i}";`, `console.log(v${i});`, '```', '');
    out.push(`> quote ${tag}-${i}`, '');
  }
  out.push(`## ${tag} END`, '', `Last line of ${tag}.`, '');
  return out.join('\n');
}

interface TestNotesWindow {
  __testNotes: { createNote: (id: string, content: string) => Promise<{ id: string }> };
}

/** `.note-body` is the desktop shell's scroller (tests/editor-scroll.spec.ts). */
const scrollTop = (page: Page): Promise<number> =>
  page.locator('.note-body').evaluate((el) => el.scrollTop);

/** Waits for the note's LAST line to be in the document: the stream is done. */
async function waitForWholeNote(page: Page, tag: string): Promise<void> {
  await expect(page.locator(EDITOR).getByText(`Last line of ${tag}.`)).toHaveCount(1, {
    timeout: 20_000,
  });
}

/** Opens `id` in the active tab, the way a link or the sidebar does. */
async function openInActiveTab(page: Page, id: string): Promise<void> {
  await page.evaluate((hash) => {
    window.location.hash = hash;
  }, `#/note/${id}`);
  await expect(page).toHaveURL(new RegExp(`#/note/${id}$`));
}

test('a large note restores its tab scroll position after a tab switch', async ({ page }) => {
  test.setTimeout(90_000);
  await openNewNote(page);
  await page.evaluate(
    async (content) => {
      const notes = (window as unknown as TestNotesWindow).__testNotes;
      await notes.createNote('small', '# Small\n\nA note that fits on one screen.\n');
      await notes.createNote('bigA', content);
    },
    largeNote('AAA', 420),
  );
  // The tab strip is the Tauri shell's; its shortcuts are the shell's on
  // every platform (registerNotesShellShortcuts.ts), which reads the platform
  // off the user agent, not the host Playwright runs on.
  const mac = await page.evaluate(() => /Mac|iPhone|iPad/i.test(navigator.userAgent));
  const mod = mac ? 'Meta' : 'Control';

  // Tab 1 holds the small note, tab 2 the large one.
  await openInActiveTab(page, 'small');
  await page.keyboard.press(`${mod}+t`);
  await expect(page).toHaveURL(/#\/$/);
  await openInActiveTab(page, 'bigA');
  await waitForWholeNote(page, 'AAA');

  const target = 50_000;
  const scrollHeight = await page.locator('.note-body').evaluate((el) => el.scrollHeight);
  // Deep, and far from the bottom: a view pinned there cannot pass for a restore.
  expect(scrollHeight).toBeGreaterThan(target * 2);
  await page.locator('.note-body').evaluate((el, to) => {
    el.scrollTop = to;
  }, target);
  await expect.poll(() => scrollTop(page)).toBe(target);
  await page.keyboard.press(`${mod}+1`);
  await expect(page).toHaveURL(/#\/note\/small$/);
  await expect(page.locator(EDITOR).getByText('A note that fits on one screen.')).toBeVisible();
  await page.keyboard.press(`${mod}+2`);
  await expect(page).toHaveURL(/#\/note\/bigA$/);
  await waitForWholeNote(page, 'AAA');
  // Settled: the same offset over several samples, not the first one read.
  const samples: number[] = [];
  await expect
    .poll(
      async () => {
        samples.push(await scrollTop(page));
        const last = samples.slice(-4);
        return last.length === 4 && last.every((value) => value === last[0]) ? last[0] : null;
      },
      { timeout: 15_000, intervals: [100] },
    )
    .not.toBeNull();
  expect(Math.abs(samples[samples.length - 1] - target)).toBeLessThanOrEqual(2);
});
