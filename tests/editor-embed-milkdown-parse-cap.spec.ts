// Part of the futoBridge Milkdown suite: scope and input rules are in
// editor-embed-milkdown.spec.ts.

import { expect, type Page } from '@playwright/test';
import { PERFORMANCE_BUDGET } from './editor-gauntlet/performanceFloor';
import {
  focusEditor,
  getContent,
  messagesOfType,
  type FakeHostWindow,
} from './lib/editorEmbedHost';
import { settleChangeDebounce, test, hostConfig } from './lib/editorEmbedMilkdown';

// ============================================================
// The parse cap — a note with one enormous block (the huge-note trap)
// ============================================================
//
// Progressive open streams a note in top-level blocks, so it has nothing to
// offer a note that IS one block. Measured against these exact bundle bytes in
// chromium (2026-09-01): the cost of a whole-document parse is driven not by
// the note's size but by the size of its largest INLINE CONTENT RUN, and it is
// superlinear in it — micromark's text tokenizer merges adjacent data tokens by
// splicing one events array, which is quadratic inside a single run.
//
// | fixture (same 1.26 MB either way)      | initialize |
// |---|---|
// | 1.26 MB in ONE line (one inline node)  | 107 ms     |
// | 20k lines, blank line every 200        | 667 ms     |
// | 20k lines, blank line every line       | 2,264 ms   |
// | 20k lines, NO blank line (one run)     | 7,796 ms   |
//
// A user's 50,000-line note with no blank line anywhere took 28 s here and
// minutes on a phone: the editor showed nothing, and because the iOS shell
// cannot read a document that never mounted, Back refused to leave. The editor's
// half of that fix is parse SPEED. The cost was never the note's size: it was
// micromark's text resolver merging adjacent data events with one `splice` per
// run, which is quadratic in the number of runs — and a paragraph of
// single-newline lines produces one run per line. Patched to compact in one
// pass (patches/micromark@4.0.2.patch): 20,000 lines went 4.8 s -> 1.6 s and
// 50,000 went 18.1 s -> 0.9 s, linear in the note.
//
// There is deliberately NO cap and no read-only mode. An earlier attempt
// mounted a bounded read-only preview with a notice, and it was the wrong
// answer to the right measurement: a 4,280-line note is an ordinary pasted
// transcript, and telling its owner the editor cannot open it is a capitulation
// (docs/plan/milkdown-transition.md §5).

/**
 * A note that is ONE paragraph: every line is a sentence and there is no blank
 * line anywhere, so `planMarkdownChunks` declines it (`no-boundary`) and the
 * whole document goes through a single parse.
 *
 * 20,000 lines rather than the reported 50,000 deliberately: it is the smallest
 * fixture that reproduces the block clearly (7.8 s in chromium against ~50 ms
 * after the cap), and a regression fails the timing assertion below instead of
 * blowing the spec timeout with no message.
 */
function oneParagraphNote(lines: number): string {
  return Array.from(
    { length: lines },
    (_, i) => `Line ${i + 1} of this note is an ordinary sentence about something.`,
  ).join('\n');
}

const HUGE_PARAGRAPH_LINES = 20_000;
/** Reference size for the CI-throughput calibration below: same generator,
 * same declined-chunking (`no-boundary`) code path, an order of magnitude
 * smaller so its own cost stays dominated by fixed per-open overhead rather
 * than the parse this test is actually guarding. */
const REFERENCE_LINES = 1_000;
/** A regression to the quadratic resolver blows straight through this. */
const OPEN_BUDGET_MS = 2_000;

async function initializeTimed(page: Page, content: string): Promise<number> {
  return page.evaluate((json) => {
    const w = window as unknown as FakeHostWindow & { __msgs: { type: string }[] };
    w.__msgs.length = 0;
    const started = performance.now();
    w.FutoEditor.initialize(json);
    return performance.now() - started;
  }, hostConfig({ content }));
}

test('a note that is one enormous paragraph opens instead of blocking the engine', async ({
  page,
}) => {
  // CI-2026-09: pipelines 35760-36709 measured THIS test between 2.5 s and
  // 12.7 s elapsed with no code change in between, while a local desktop
  // chromium run does the same 20,000-line open in ~0.5 s. That swing tracks
  // CI runner load, not the product — a fixed CI-only budget would chase a
  // moving target and need re-bumping every time contention shifts (M15).
  // Calibrate instead against a note built by the
  // SAME generator, an order of magnitude smaller, opened moments earlier in
  // this same page/runner: the per-line cost ratio rides out the runner's
  // throughput swings while still failing hard on the actual regression class
  // this test guards against — the quadratic resolver, which does not make
  // per-line cost a little worse, it makes per-line cost balloon with N.
  const referenceElapsed = await initializeTimed(page, oneParagraphNote(REFERENCE_LINES));
  const referencePerLine = referenceElapsed / REFERENCE_LINES;

  const note = oneParagraphNote(HUGE_PARAGRAPH_LINES);
  const elapsed = await initializeTimed(page, note);
  const perLine = elapsed / HUGE_PARAGRAPH_LINES;

  // Healthy (linear) parsing amortizes fixed overhead, so perLine at 20,000
  // lines is normally CHEAPER than at 1,000 (~0.64x locally) — reusing the
  // gauntlet's own cliff factor keeps one definition of "how much worse
  // before it's a cliff, not noise" instead of a second unaudited constant.
  expect(perLine).toBeLessThan(referencePerLine * PERFORMANCE_BUDGET.openCliffFactor);
  // Absolute backstop, not the primary gate: refuse a pathologically slow
  // open even if contention or GC pressure hit only the larger doc and hid
  // it from the ratio above. 15 s clears the worst runner contention seen in
  // the 2026-09 CI history (12.7 s) with margin, well under the job's 90 s
  // Playwright timeout, so this fires as a clear assertion instead of an
  // ambiguous suite timeout.
  expect(elapsed).toBeLessThan(15_000);
  // It really did mount something the user can read, rather than "opening" by
  // rendering nothing at all.
  expect(await page.locator('.ProseMirror').innerText()).toContain('Line 1 of this note');
});

test('a one-paragraph note of ordinary size opens fully editable', async ({ page }) => {
  const note = oneParagraphNote(2_000);

  const elapsed = await initializeTimed(page, note);

  expect(elapsed).toBeLessThan(OPEN_BUDGET_MS);
  expect(await getContent(page)).toBe(note);

  await focusEditor(page);
  await page.keyboard.type('x');
  await settleChangeDebounce(page);

  const changes = await messagesOfType(page, 'change');
  expect(changes.length).toBeGreaterThan(0);
  expect(await getContent(page)).toContain('x');
});
