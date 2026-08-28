import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { expect, test } from '@playwright/test';

import { Cm6GauntletAdapter } from './cm6Adapter';
import { gauntletArtifactCapture } from './artifactCapture';
import { ForeignCorpusLoader, sha256File } from './foreignCorpus';
import {
  expectedSelectedRecords,
  fingerprintForeignSweepConfig,
  type ForeignSweepRunConfig,
  type ForeignSweepShardReport,
} from './foreignReport';
import { runForeignPreservationSweep } from './foreignPreservation';

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

test('current CM6 preserves foreign files', async ({ page }) => {
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
  const adapter = new Cm6GauntletAdapter(page);
  const [corpusSha256, adapterRevision] = await Promise.all([
    sha256File(corpusPath!),
    sha256File(path.resolve('tests/editor-gauntlet/cm6Adapter.ts')),
  ]);
  const config: ForeignSweepRunConfig = {
    semanticsVersion: 'foreign-preservation-v4',
    candidate: adapter.name,
    candidateRevision:
      process.env.EDITOR_GAUNTLET_CANDIDATE_REVISION ??
      execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    adapterRevision,
    corpusSha256,
    expectedRecords: expectedRecords ?? 0,
    maxNotes: maxNotes ?? null,
    artifactCapture: gauntletArtifactCapture(),
    assertions: 'byte-fidelity',
    shardCount,
    selection: 'zero-based-record-ordinal-modulo',
    blocks: 'lezer-markdown-gfm-top-level-v1',
    caretWalk: 'block-from-and-to-with-render-frame-v1',
    edit: 'isolated-insert-x-at-block-from-v1',
  };
  const result = await runForeignPreservationSweep(adapter, loader, (progress) => {
    if (progress.notesPlanned % 100 === 0) {
      console.log(
        `EDITOR_GAUNTLET_FOREIGN_PROGRESS ${JSON.stringify({ shardIndex, shardCount, notes: progress.notesPlanned, blocks: progress.blocksPlanned })}`,
      );
    }
  });
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
        `current-cm6-foreign-preservation.shard-${shardIndex}-of-${shardCount}.json`,
      );
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`EDITOR_GAUNTLET_FOREIGN ${JSON.stringify(report)}`);

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
  expect(
    loader.accounting.selectedMissingBody,
    'every selected corpus record must have a body',
  ).toBe(0);
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
  expect.soft(result.refusals, 'tier 1 requires zero refused edits').toBe(0);
  expect.soft(result.editsWithWarnings, 'tier 2 requires zero preservation warnings').toBe(0);
  expect.soft(result.exactOnlyNotes, 'rich editing must remain available').toBe(0);
  expect(result.outsideBlockRewrites, 'no edit may rewrite outside its parsed block').toBe(0);
});
