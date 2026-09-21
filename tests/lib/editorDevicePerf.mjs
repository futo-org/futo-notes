/**
 * The DEVICE leg of the editor performance floor (issue #106).
 *
 * `tests/editor-gauntlet/performanceFloor.ts` holds the desktop floor, where
 * progressive open did not exist when it was written and time-to-fully-loaded
 * was the only observable. On the low-end Android reference phone the budget
 * docs/plan/milkdown-transition.md §5 states is enforceable directly:
 *
 * - `hard` fixtures (real-note sizes): time-to-interactive-FIRST-VIEWPORT —
 *   the `futo:editor-open-interactive` performance measure — under the 1s
 *   budget.
 * - `linear` fixtures (sizes real notes do not reach): no absolute budget; the
 *   per-line time-to-COMPLETE must stay within the cliff factor of the
 *   reference fixture. Complete, not interactive: progressive open makes
 *   interactive roughly constant regardless of size, so it can prove nothing
 *   about scaling.
 * - `hard` fixtures also budget the FIRST focus after the open — the tap that
 *   starts typing — at the same 1s. A `content-visibility` containment rule
 *   once stalled it quadratically in the block count (12s at 1,000 blocks, see
 *   docs/spec/editor.md, Performance); this is the regression guard.
 * - `measured` fixtures are reported but their open time gates nothing — used
 *   for a fixture that exists to be the `linear` comparison's reference, or
 *   whose open time is not a claim about the product. Their keystroke budget
 *   still applies.
 * - A `measured`/`linear` fixture may additionally set `openPolicy.interactive:
 *   'hard'` to hold ONLY its interactive-first-viewport time to the same 1s
 *   budget as a `hard` fixture — without gaining `hard`'s first-focus check.
 *   markdownChunks.ts's non-blank cut points (a column-0 heading, fence,
 *   blockquote, or interrupting list item) mean a document with no blank line
 *   anywhere can still chunk, so its open can meet the interactive budget even
 *   though it never carried the `hard` policy's real-note-viewport shape.
 * - The keystroke budget applies to EVERY fixture: typing stays interactive at
 *   any size (AGENTS.md M5).
 *
 * Plain node .mjs, not TS: the device runner (tests/android-editor-perf.mjs)
 * imports it directly, and the vitest suite locks it.
 */

export const DEVICE_BUDGET = {
  /** Time-to-interactive-first-viewport, plan §5 / D7. */
  interactiveMs: 1_000,
  /** The first focus after an open, to the third frame after it. */
  firstFocusMs: 1_000,
  keystrokeP95Ms: 16,
  /**
   * How much worse a linear fixture's per-line complete cost may be than its
   * reference before it counts as a cliff — the TipTap-shaped failure, not a
   * constant factor. Matches the desktop floor's factor.
   */
  openCliffFactor: 2.5,
};

/** One content line, in the four shapes the desktop floor's fixture cycles. */
function contentLine(index) {
  switch (index % 4) {
    case 0:
      return `paragraph ${index} with **bold** and [a link](https://example.test/${index})`;
    case 1:
      return `- list item ${index}`;
    case 2:
      return `> quoted line ${index}`;
    default:
      return `\`inline code ${index}\``;
  }
}

/**
 * The desktop floor's line fixture, copied because that generator is
 * TypeScript inside the Playwright harness and this module is plain node.
 * tests/lib/editorDevicePerf.test.mjs holds the two byte-identical — edit them
 * together (AGENTS.md §12).
 *
 * Note what this document IS: every line abuts the next, so it has no blank
 * line anywhere. Before `markdownChunks.ts` learned to cut at a non-blank
 * "hard starter" (a column-0 heading, fence, blockquote, or interrupting list
 * item), a blank line was the ONLY place it was willing to cut, so
 * `planMarkdownChunks` declined this fixture (`no-boundary`) outright. It no
 * longer does: the list-item and blockquote lines this fixture cycles through
 * are hard starters, so it chunks under the DEFAULT options too (first chunk
 * 82 lines at every size tried, verified in editorDevicePerf.test.mjs) — see
 * markdownChunks.test.ts's own copy of this shape for the line-by-line reason.
 * It still does NOT fuse into a few giant blocks, as an even older version of
 * this comment claimed: list items and blockquotes interrupt the paragraphs,
 * so 10k lines parse to ~5,000 small top-level blocks (measured in Crepe on
 * 2026-09-04) — the same block count as the blank-line fixture, and still
 * loaded with the caret at the END of the document, which is what keeps this
 * the harder typing case. The device runner gives it the interactive budget
 * via `openPolicy.interactive: 'hard'` rather than promoting it all the way to
 * the `hard` policy: first focus after a full load is Chromium's editable-
 * focus work over the fully rendered document (containment was retired
 * 2026-09-05 — every block renders eagerly by the time "complete" fires),
 * measured at 1.6s / 3.9s at 10k/25k lines on the 2026-09-06 gate run, and
 * that is not what the open budget measures.
 */
export function lineFixture(lines) {
  return Array.from({ length: lines }, (_, index) => contentLine(index)).join('\n');
}

/**
 * The same content, shaped like a real note: one block per line with a blank
 * line between, so `markdownChunks.ts` has a legal cut at every boundary and
 * the document is thousands of top-level blocks rather than a handful of huge
 * ones.
 *
 * This is the fixture the interactive-first-viewport budget is measured on,
 * and the difference from `lineFixture` is deliberately a single property —
 * block separation — so a failure cannot be blamed on unrelated content. Real
 * notes are shaped this way: the corpus study in plan §5 found 88.9% of notes
 * past the threshold take the progressive path, and the 11% that decline
 * "open no worse than they do today" rather than being held to the 1s gate.
 *
 * Returns exactly [lines] lines, blank separators included, so the per-line
 * arithmetic the cliff check does stays honest.
 */
export function blockFixture(lines) {
  const out = [];
  let index = 0;
  while (out.length < lines) {
    if (out.length > 0) {
      out.push('');
      if (out.length >= lines) break;
    }
    out.push(contentLine(index));
    index += 1;
  }
  return out.slice(0, lines).join('\n');
}

/** p95 by the same rank rule the desktop floor uses (performanceFloor.ts). */
export function percentile95(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? Infinity;
}

/**
 * Every budget the run missed, in fixture order. Empty means the floor held.
 *
 * fixtures: { name, openPolicy: {kind:'hard'} | {kind:'linear', reference} | {kind:'measured'} }
 * results:  { fixture, lines, interactiveMs, completeMs, keystrokeSynchronousP95Ms }
 *           or { fixture, lines, loadError } when the editor refused to open it
 */
export function evaluateDeviceFloor(fixtures, results) {
  const byName = new Map(results.map((result) => [result.fixture, result]));
  const violations = [];

  for (const fixture of fixtures) {
    const result = byName.get(fixture.name);
    if (!result) {
      violations.push({
        fixture: fixture.name,
        kind: 'missing-measurement',
        detail: 'the fixture produced no measurement',
      });
      continue;
    }

    /* The editor refused the fixture outright. A perf run that reports "every
     * budget held" because the document never opened is the silent green
     * AGENTS.md M11 forbids, so this is a violation in its own right and the
     * timing checks below have nothing to work with. */
    if (result.loadError) {
      violations.push({
        fixture: fixture.name,
        kind: 'load-failure',
        detail: `the editor could not open this fixture: ${result.loadError}`,
      });
      continue;
    }

    if (result.keystrokeSynchronousP95Ms >= DEVICE_BUDGET.keystrokeP95Ms) {
      violations.push({
        fixture: fixture.name,
        kind: 'keystroke-budget',
        detail:
          `synchronous keystroke p95 ${Math.round(result.keystrokeSynchronousP95Ms)}ms ` +
          `is not under the ${DEVICE_BUDGET.keystrokeP95Ms}ms budget`,
      });
    }

    const checkInteractiveBudget = () => {
      if (result.interactiveMs >= DEVICE_BUDGET.interactiveMs) {
        violations.push({
          fixture: fixture.name,
          kind: 'interactive-budget',
          detail:
            `time-to-interactive-first-viewport ${Math.round(result.interactiveMs)}ms ` +
            `is not under the ${DEVICE_BUDGET.interactiveMs}ms budget`,
        });
      }
    };

    if (fixture.openPolicy.kind === 'measured') {
      // `interactive: 'hard'` asserts the open budget without gaining the
      // `hard` policy's first-focus check — see the module header comment.
      if (fixture.openPolicy.interactive === 'hard') checkInteractiveBudget();
      continue;
    }

    if (fixture.openPolicy.kind === 'hard') {
      checkInteractiveBudget();
      if (result.firstFocusMs >= DEVICE_BUDGET.firstFocusMs) {
        violations.push({
          fixture: fixture.name,
          kind: 'focus-budget',
          detail:
            `first focus ${Math.round(result.firstFocusMs)}ms ` +
            `is not under the ${DEVICE_BUDGET.firstFocusMs}ms budget`,
        });
      }
      continue;
    }

    // Only `linear` policies reach here (`measured` and `hard` both `continue`d above).
    if (fixture.openPolicy.interactive === 'hard') checkInteractiveBudget();

    const reference = byName.get(fixture.openPolicy.reference);
    if (!reference) {
      violations.push({
        fixture: fixture.name,
        kind: 'missing-reference',
        detail: `no ${fixture.openPolicy.reference} measurement to compare against`,
      });
      continue;
    }
    const perLine = (measurement) =>
      measurement.lines > 0 ? measurement.completeMs / measurement.lines : Infinity;
    const ratio = perLine(result) / perLine(reference);
    if (ratio > DEVICE_BUDGET.openCliffFactor) {
      violations.push({
        fixture: fixture.name,
        kind: 'open-cliff',
        detail:
          `open completes at ${ratio.toFixed(1)}x the per-line cost of ` +
          `${fixture.openPolicy.reference}, past the ${DEVICE_BUDGET.openCliffFactor}x cliff factor`,
      });
    }
  }

  return violations;
}
