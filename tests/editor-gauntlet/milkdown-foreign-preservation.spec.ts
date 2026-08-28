import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { expect, test } from '@playwright/test';

import { MilkdownGauntletAdapter } from './milkdownAdapter';
import { gauntletArtifactCapture } from './artifactCapture';
import { ForeignCorpusLoader, sha256File } from './foreignCorpus';
import {
  expectedSelectedRecords,
  fingerprintForeignSweepConfig,
  type ForeignSweepRunConfig,
  type ForeignSweepShardReport,
} from './foreignReport';
import { runForeignPreservationSweep } from './foreignPreservation';

/**
 * The foreign-corpus preservation sweep against Milkdown, on the LOSS-ONLY bar.
 *
 * The CodeMirror sweep asserts byte fidelity: an edit rewrites its own block
 * and nothing else, byte for byte. ADR-0002 retires that bar for a WYSIWYG
 * candidate — a round trip through Milkdown legitimately renormalizes markdown
 * syntax across the whole document — so what this run gates is what the corpus
 * census actually measured (docs/plan/milkdown-transition.md §2):
 *
 *   never refuse the edit · never warn · never lose text
 *
 * "Refuse" needs a definition for an editor that cannot refuse anything: here
 * it is the edit failing to reach the shell at all, which is the only way an
 * edit can be made and still be unsaveable.
 *
 * The rewrite counters are still computed and still in the report. They are
 * evidence about how much normalization the corpus provokes, which is the
 * normalize-once scorecard (plan D4). They are not pass conditions, and this
 * spec says so out loud rather than quietly dropping them.
 */

const corpusPath = process.env.EDITOR_GAUNTLET_CORPUS;
const shardIndex = Number.parseInt(process.env.EDITOR_GAUNTLET_SHARD_INDEX ?? '0', 10);
const shardCount = Number.parseInt(process.env.EDITOR_GAUNTLET_SHARD_COUNT ?? '1', 10);
const maxNotes = process.env.EDITOR_GAUNTLET_CORPUS_LIMIT
  ? Number.parseInt(process.env.EDITOR_GAUNTLET_CORPUS_LIMIT, 10)
  : undefined;
const timeoutMs = Number.parseInt(process.env.EDITOR_GAUNTLET_TIMEOUT_MS ?? '21600000', 10);
const expectedRecords = process.env.EDITOR_GAUNTLET_EXPECTED_RECORDS
  ? Number.parseInt(process.env.EDITOR_GAUNTLET_EXPECTED_RECORDS, 10)
  : undefined;

test('milkdown preserves foreign files', async ({ browser }) => {
  test.skip(!corpusPath, 'set EDITOR_GAUNTLET_CORPUS after reading the corpus NOTICE');
  test.setTimeout(timeoutMs);
  const startedAt = performance.now();
  if (maxNotes === undefined && expectedRecords === undefined) {
    throw new Error('a full sweep requires EDITOR_GAUNTLET_EXPECTED_RECORDS');
  }
  if (
    expectedRecords !== undefined &&
    (!Number.isInteger(expectedRecords) || expectedRecords < 1)
  ) {
    throw new Error('EDITOR_GAUNTLET_EXPECTED_RECORDS must be a positive integer');
  }

  const loader = new ForeignCorpusLoader(corpusPath!, {
    shard: { index: shardIndex, count: shardCount },
    maxNotes,
  });
  const adapter = new MilkdownGauntletAdapter(browser);
  const [corpusSha256, adapterRevision] = await Promise.all([
    sha256File(corpusPath!),
    sha256File(path.resolve('tests/editor-gauntlet/milkdownAdapter.ts')),
  ]);
  const config: ForeignSweepRunConfig = {
    semanticsVersion: 'foreign-preservation-v4',
    assertions: 'loss-only',
    candidate: adapter.name,
    candidateRevision:
      process.env.EDITOR_GAUNTLET_CANDIDATE_REVISION ??
      execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    adapterRevision,
    corpusSha256,
    expectedRecords: expectedRecords ?? 0,
    maxNotes: maxNotes ?? null,
    artifactCapture: gauntletArtifactCapture(),
    shardCount,
    selection: 'zero-based-record-ordinal-modulo',
    blocks: 'lezer-markdown-gfm-top-level-v1',
    caretWalk: 'block-from-and-to-with-render-frame-v1',
    edit: 'isolated-insert-x-at-block-from-v1',
  };

  let result;
  try {
    result = await runForeignPreservationSweep(adapter, loader, (progress) => {
      if (progress.notesPlanned % 100 === 0) {
        console.log(
          `EDITOR_GAUNTLET_FOREIGN_PROGRESS ${JSON.stringify({
            shardIndex,
            shardCount,
            notes: progress.notesPlanned,
            blocks: progress.blocksPlanned,
          })}`,
        );
      }
    });
  } finally {
    await adapter.dispose();
  }

  const report: ForeignSweepShardReport = {
    schemaVersion: 1,
    candidate: adapter.name,
    corpusSha256,
    config,
    configFingerprint: fingerprintForeignSweepConfig(config),
    shard: loader.shard,
    wallMs: performance.now() - startedAt,
    maxRssKb: process.resourceUsage().maxRSS,
    corpus: loader.accounting,
    sweep: result,
  };
  const reportDir = path.resolve('tests/editor-gauntlet/local');
  await mkdir(reportDir, { recursive: true });
  const reportPath = process.env.EDITOR_GAUNTLET_REPORT_PATH
    ? path.resolve(process.env.EDITOR_GAUNTLET_REPORT_PATH)
    : path.join(
        reportDir,
        `milkdown-foreign-preservation.shard-${shardIndex}-of-${shardCount}.json`,
      );
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`EDITOR_GAUNTLET_FOREIGN ${JSON.stringify(report)}`);

  // ---- accounting: the run must have covered what it claims to have covered //
  expect(loader.accounting.reachedEof, 'the loader must account through corpus EOF').toBe(true);
  if (expectedRecords !== undefined) {
    expect(
      loader.accounting.recordsSeen,
      'the shard must see the expected corpus record count',
    ).toBe(expectedRecords);
    expect(
      loader.accounting.selectedRecords,
      'the modulo shard must select its exact partition',
    ).toBe(expectedSelectedRecords(expectedRecords, loader.shard));
  }
  expect(
    loader.accounting.selectedInvalidJson,
    'every selected corpus record must be valid JSON',
  ).toBe(0);
  expect(loader.accounting.selectedMissingBody, 'every selected record must have a body').toBe(0);
  if (maxNotes === undefined) {
    expect(loader.accounting.omittedByLimit, 'a full sweep must not cap selected notes').toBe(0);
    expect(loader.accounting.yieldedNotes, 'every valid selected note must reach the runner').toBe(
      loader.accounting.selectedValidNotes,
    );
  }
  expect(result.notesPlanned, 'the runner must account for every yielded note').toBe(
    loader.accounting.yieldedNotes,
  );
  expect(result.failures.parse, 'every yielded note must parse').toBe(0);
  expect(result.caretWalksCompleted, 'every parsed note must complete its caret walk').toBe(
    result.caretWalksPlanned,
  );
  expect(result.caretPositionsCompleted, 'every planned caret position must complete').toBe(
    result.caretPositionsPlanned,
  );
  expect(result.failedEdits, 'every parsed block must complete one isolated edit').toBe(0);
  expect(result.editsPlanned, 'every parsed block must plan one isolated edit').toBe(
    result.blocksPlanned,
  );
  expect(result.editsCompleted, 'every planned block edit must complete').toBe(result.editsPlanned);
  expect(
    result.hardFailures,
    'no edit may be uneditable or exceed/lose its adapter budget',
  ).toEqual({
    parseNotes: 0,
    uneditableEdits: 0,
    budgetExceededOperations: 0,
    adapterOperations: 0,
  });

  // ---- the loss-only bar --------------------------------------------------- //
  // `refusals` is a real signal for this adapter, not a formality: it counts
  // edits the shell was never told about, which is otherwise invisible — the
  // file would still hold the note unchanged and the loss check would see
  // nothing. milkdown-adapter.spec.ts is the standing proof that it fires.
  expect.soft(result.refusals, 'never refuse: no edit may be refused').toBe(0);
  expect.soft(result.editsWithWarnings, 'never warn: no edit may surface a warning').toBe(0);
  // No `exactOnlyNotes` line. Milkdown has no exact-only fallback mode, so the
  // adapter reports 'rich' for every note and the assertion could never fail —
  // a gate that cannot go red is worse than no gate (M11). If a candidate with
  // a read-only fallback ever appears, it belongs back in its spec.

  expect
    .soft(
      { lossyEdits: result.lossyEdits, lostWords: result.lostTokenSamples },
      'never lose: every word the note had must survive the edit',
    )
    .toEqual({ lossyEdits: 0, lostWords: [] });
});
