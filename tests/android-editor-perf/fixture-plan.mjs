/**
 * The fixture ladders the run measures, and the real note it can substitute.
 */

import { existsSync, readFileSync } from 'node:fs';
import { blockFixture, lineFixture } from '../lib/editorDevicePerf.mjs';
import { LOCAL_NOTE_PATH, STRESS } from './run-config.mjs';

// Two ladders, because the two budgets need different documents.
//
// `*-blocks` fixtures are real-note shaped — blank line between blocks — and
// carry the full `hard` policy: interactive-first-viewport AND first focus.
// `*-lines` fixtures are the desktop floor's own generator (differential-
// locked in editorDevicePerf.test.mjs) so the device numbers stay comparable
// to MILKDOWN_FLOOR_FIXTURES'; they have no blank line anywhere. Before
// markdownChunks.ts learned to cut at a non-blank "hard starter" (a column-0
// heading, fence, blockquote, or interrupting list item), `planMarkdownChunks`
// declined them outright and they loaded whole — that measured 15.7s at 10k
// lines on this phone. They chunk now: the list-item and blockquote lines this
// generator cycles through are hard starters (verified in
// markdownChunks.test.ts and editorDevicePerf.test.mjs), so `10000-lines` and
// `25000-lines` now carry `openPolicy.interactive: 'hard'` too — the
// interactive budget is meaningful for them, matching plan §5's point that a
// document offering a safe boundary opens progressively regardless of shape.
// They still do NOT carry the `hard` policy's first-focus check: first focus
// after a full load is Chromium's editable-focus work over the fully rendered
// document (containment was retired 2026-09-05), measured at 1.6s / 3.9s at
// 10k/25k lines on the 2026-09-06 gate run and reported but not gated — see
// `lineFixture`'s own comment in editorDevicePerf.mjs.
//
// The adversarial byte fixtures stay desktop-only: §2's note-size population
// says nothing about benchmark-shaped documents, and shipping 10 MiB through
// a phone's CDP socket measures the socket more than the editor.
export function fixturePlan() {
  const plan = [
    {
      name: '1000-lines-blocks',
      openPolicy: { kind: 'hard' },
      save: {},
      build: () => blockFixture(1_000),
    },
    {
      name: '10000-lines-blocks',
      openPolicy: { kind: 'hard' },
      save: { reference: '1000-lines-blocks' },
      build: () => blockFixture(10_000),
    },
  ];
  const realNote = resolveRealNote();
  if (realNote) {
    plan.push({
      name: realNote.name,
      // A real note is a real-note size by definition: the 1s budget applies.
      openPolicy: { kind: 'hard' },
      build: () => realNote.content,
    });
  }
  plan.push(
    // The reference for the cliff check below. Its open is now held to the
    // interactive budget too (it chunks — see the comment above), but not to
    // first focus.
    {
      name: '10000-lines',
      openPolicy: { kind: 'measured', interactive: 'hard' },
      build: () => lineFixture(10_000),
    },
    {
      name: '25000-lines',
      openPolicy: { kind: 'linear', reference: '10000-lines', interactive: 'hard' },
      build: () => lineFixture(25_000),
    },
  );
  /* 50k lines is what plan §5 names, and on the reference phone it is still
   * not affordable in a routine run — but not because the open is unmeasurable
   * any more. It chunks now, the same as 10k/25k (see the comment above), so
   * this is held to the interactive budget too. The cost that remains is the
   * KEYSTROKE samples: each settled-to-paint sample is a layout pass over a
   * ~25,000-block document, slow enough on its own that the routine 10k/25k
   * ladder already proves the
   * same "scales linearly, no cliff" property (a RATIO check) at a fraction of
   * the wall-clock cost. `--stress` adds the 50k rung for anyone who wants the
   * number §5 quotes. Making it opt-in is a cost decision, not a weaker
   * assertion — the same policy is applied to whichever rungs run. */
  if (STRESS) {
    plan.push({
      name: '50000-lines',
      openPolicy: { kind: 'linear', reference: '10000-lines', interactive: 'hard' },
      build: () => lineFixture(50_000),
    });
  }
  return { plan, realNote };
}

/** The local, uncommitted big-note fixture, or null with a loud notice. */
function resolveRealNote() {
  const explicit = process.env.FUTO_PERF_NOTE;
  const file = explicit || (existsSync(LOCAL_NOTE_PATH) ? LOCAL_NOTE_PATH : null);
  if (!file) {
    console.log(
      `NOTE: no real-note fixture — set $FUTO_PERF_NOTE or place one at ${LOCAL_NOTE_PATH} ` +
        '(it stays local and uncommitted; the directory is gitignored).',
    );
    return null;
  }
  const content = readFileSync(file, 'utf8');
  const lines = content.split('\n').length;
  console.log(`Real-note fixture: ${file} (${lines} lines, ${content.length} chars)`);
  return { name: 'real-note', content, lines };
}
