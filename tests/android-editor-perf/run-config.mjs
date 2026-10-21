/**
 * Command-line flags, the fixture note's names, sample counts and report paths.
 */

import path from 'node:path';

/**
 * Flags, parsed once and strictly: an unrecognized argument fails the run
 * rather than being ignored, so `--stres` cannot look like a 50k run that
 * quietly measured 25k instead.
 */
const FLAGS = new Set(['--stress']);
const unknownArgs = process.argv.slice(2).filter((arg) => !FLAGS.has(arg));
if (unknownArgs.length > 0) {
  console.error(
    `Unrecognized argument(s): ${unknownArgs.join(' ')}\nSupported: ${[...FLAGS].join(', ')}`,
  );
  process.exit(2);
}
export const STRESS = process.argv.includes('--stress');

export const PACKAGE = 'com.futo.notes.dev';
export const NOTE_TITLE = 'Perf fixture';
export const NOTE_FILE = `${NOTE_TITLE}.md`;
/**
 * Keystroke samples per fixture. The loop is byte-for-byte the desktop
 * gauntlet's `measureKeystrokes` (a dispatch, then a rAF), so the numbers mean
 * the same thing on both — which is also why the rAF cannot be dropped to make
 * a run cheaper.
 *
 * The budget-bearing fixtures keep the full 25. The pathological ladder does
 * not: one settled sample on the unchunkable 10k fixture measured 7.9s on the
 * reference phone, so 25 of them at 50k would spend ~20 minutes inside a single
 * leg. 8 samples still supports the same rank rule — it just collapses p95 onto
 * the second-worst sample, which makes the budget HARDER to meet, not easier.
 */
export const KEYSTROKE_SAMPLES = 25;
export const KEYSTROKE_SAMPLES_PATHOLOGICAL = 8;
/**
 * Save samples per state per fixture. Each waits out the 200 ms change debounce
 * for the editor's report, and a cold one serializes the whole document, so
 * this is the run's slowest loop per sample; 20 puts p95 on the second-worst.
 */
export const SAVE_SAMPLES = 20;
export const REPORT_DIR = 'tests/editor-gauntlet/local';
export const LOCAL_NOTE_PATH = path.join(REPORT_DIR, 'device-perf-note.md');
