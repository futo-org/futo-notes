import { readFileSync, writeFileSync } from 'node:fs';

/**
 * A checked-in ledger of the cases a candidate is known to fail, and the guard
 * that keeps it honest.
 *
 * The Milkdown adapter's first job is to RECORD the split-torture score, not to
 * be green: several constructs the matrix exercises are still unbuilt parity
 * work (wikilinks above all — issue #100's siblings own them). A suite that
 * simply went red would tell nobody which of those 56 cases moved, and a suite
 * that swallowed the failures would be a silent green (M11).
 *
 * So the ledger is the assertion. A case that starts failing is a regression; a
 * case that starts passing while still listed is a stale ledger. Both are red,
 * and the fix for the second is one line: delete the entry.
 */
export interface ScoreBaseline {
  /** Case id -> why it is expected to fail, one line. */
  expectedFailures: Record<string, string>;
}

export interface CaseOutcome {
  id: string;
  ok: boolean;
  /** Human-readable reasons, empty when the case passed. */
  failures: string[];
  /** Reported evidence, never a pass condition. See ADR-0002 normalize-once. */
  undoByteExact?: boolean;
  /** What the editor saved, so a failure in the report is readable on its own. */
  savedSource?: string;
}

export interface BaselineDrift {
  regressions: Array<{ id: string; failures: string[] }>;
  /** Listed as expected-failure but now passing: the ledger needs the entry gone. */
  staleEntries: string[];
}

export function readScoreBaseline(path: string): ScoreBaseline {
  return JSON.parse(readFileSync(path, 'utf8')) as ScoreBaseline;
}

export function compareToBaseline(baseline: ScoreBaseline, outcomes: CaseOutcome[]): BaselineDrift {
  const regressions = outcomes
    .filter((outcome) => !outcome.ok && !(outcome.id in baseline.expectedFailures))
    .map(({ id, failures }) => ({ id, failures }));
  const passing = new Set(outcomes.filter((outcome) => outcome.ok).map((outcome) => outcome.id));
  const staleEntries = Object.keys(baseline.expectedFailures).filter((id) => passing.has(id));
  return { regressions, staleEntries };
}

/**
 * Rewrites the ledger from a run. Deliberately opt-in via
 * `EDITOR_GAUNTLET_UPDATE_BASELINE=1` and never called by a normal run — a
 * self-updating baseline would ratchet failures in silently.
 */
export function writeScoreBaseline(path: string, outcomes: CaseOutcome[]): void {
  const expectedFailures: Record<string, string> = {};
  for (const outcome of outcomes.filter((candidate) => !candidate.ok)) {
    expectedFailures[outcome.id] = outcome.failures.join('; ');
  }
  writeFileSync(path, `${JSON.stringify({ expectedFailures }, null, 2)}\n`);
}
