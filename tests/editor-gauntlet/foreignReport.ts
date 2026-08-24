import { createHash } from 'node:crypto';

import type { ForeignCorpusAccounting, ForeignCorpusShard } from './foreignCorpus';
import {
  emptyForeignSweepResult,
  type ForeignSweepFailureStage,
  type ForeignSweepResult,
} from './foreignPreservation';

export interface ForeignSweepRunConfig {
  semanticsVersion: 'foreign-preservation-v2';
  candidate: string;
  candidateRevision: string;
  adapterRevision: string;
  corpusSha256: string;
  expectedRecords: number;
  maxNotes: number | null;
  shardCount: number;
  selection: 'zero-based-record-ordinal-modulo';
  blocks: 'lezer-markdown-gfm-top-level-v1';
  caretWalk: 'block-from-and-to-with-render-frame-v1';
  edit: 'isolated-insert-x-at-block-from-v1';
}

export interface ForeignSweepShardReport {
  schemaVersion: 1;
  candidate: string;
  corpusSha256: string;
  config: ForeignSweepRunConfig;
  configFingerprint: string;
  shard: ForeignCorpusShard;
  wallMs: number;
  maxRssKb: number;
  corpus: ForeignCorpusAccounting;
  sweep: ForeignSweepResult;
}

export interface ForeignSweepAggregateReport {
  schemaVersion: 1;
  candidate: string;
  corpusSha256: string;
  config: ForeignSweepRunConfig;
  configFingerprint: string;
  shards: number;
  /** Parallel critical-path duration, not the sum of shard durations. */
  wallMs: number;
  maxRssKb: number;
  corpus: Omit<ForeignCorpusAccounting, 'reachedEof'> & { reachedEof: true };
  sweep: ForeignSweepResult;
}

const FAILURE_STAGES: ForeignSweepFailureStage[] = [
  'parse',
  'caret-open',
  'caret-walk',
  'edit-open',
  'edit-select',
  'edit-perform',
  'edit-save',
];

export function fingerprintForeignSweepConfig(config: ForeignSweepRunConfig): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex');
}

export function expectedSelectedRecords(
  expectedRecords: number,
  shard: ForeignCorpusShard,
): number {
  if (shard.index >= expectedRecords) return 0;
  return Math.floor((expectedRecords - 1 - shard.index) / shard.count) + 1;
}

function addSweep(total: ForeignSweepResult, part: ForeignSweepResult): void {
  total.notesPlanned += part.notesPlanned;
  total.notesParsed += part.notesParsed;
  total.caretWalksPlanned += part.caretWalksPlanned;
  total.caretWalksCompleted += part.caretWalksCompleted;
  total.caretPositionsPlanned += part.caretPositionsPlanned;
  total.caretPositionsCompleted += part.caretPositionsCompleted;
  total.blocksPlanned += part.blocksPlanned;
  total.editsPlanned += part.editsPlanned;
  total.editsCompleted += part.editsCompleted;
  total.failedEdits += part.failedEdits;
  total.refusals += part.refusals;
  total.editsWithWarnings += part.editsWithWarnings;
  total.warningEvents += part.warningEvents;
  total.exactOnlyNotes += part.exactOnlyNotes;
  total.editedBlockRewrites += part.editedBlockRewrites;
  total.outsideBlockRewrites += part.outsideBlockRewrites;
  total.hardFailures.parseNotes += part.hardFailures.parseNotes;
  total.hardFailures.uneditableEdits += part.hardFailures.uneditableEdits;
  total.hardFailures.budgetExceededOperations += part.hardFailures.budgetExceededOperations;
  total.hardFailures.adapterOperations += part.hardFailures.adapterOperations;
  for (const stage of FAILURE_STAGES) total.failures[stage] += part.failures[stage];
}

/** Merge only a complete, uncapped shard set. Partial evidence remains valid as shard reports. */
export function mergeForeignSweepShardReports(
  reports: ForeignSweepShardReport[],
): ForeignSweepAggregateReport {
  if (reports.length === 0) throw new Error('at least one foreign sweep shard report is required');
  const [first] = reports;
  const count = first.shard.count;
  const candidate = first.candidate;
  const corpusSha256 = first.corpusSha256;
  const configFingerprint = first.configFingerprint;
  if (reports.length !== count)
    throw new Error(`expected ${count} shard reports, got ${reports.length}`);

  const byIndex = new Map<number, ForeignSweepShardReport>();
  for (const report of reports) {
    if (report.schemaVersion !== 1) throw new Error('foreign sweep report schema mismatch');
    if (report.candidate !== candidate) throw new Error('foreign sweep candidate mismatch');
    if (report.corpusSha256 !== corpusSha256) throw new Error('foreign sweep corpus SHA mismatch');
    if (report.configFingerprint !== configFingerprint) {
      throw new Error('foreign sweep config fingerprint mismatch');
    }
    if (fingerprintForeignSweepConfig(report.config) !== report.configFingerprint) {
      throw new Error('foreign sweep config fingerprint is invalid');
    }
    if (
      report.config.candidate !== report.candidate ||
      report.config.corpusSha256 !== report.corpusSha256 ||
      report.config.shardCount !== report.shard.count
    ) {
      throw new Error('foreign sweep report disagrees with its immutable config');
    }
    if (report.config.maxNotes !== null) throw new Error('cannot aggregate a capped foreign sweep');
    if (report.shard.count !== count) throw new Error('foreign sweep shard-count mismatch');
    if (report.shard.index < 0 || report.shard.index >= count) {
      throw new Error('foreign sweep shard index is outside the shard count');
    }
    if (byIndex.has(report.shard.index)) throw new Error('duplicate foreign sweep shard index');
    if (!report.corpus.reachedEof) throw new Error('foreign sweep shard did not reach corpus EOF');
    if (report.corpus.omittedByLimit !== 0)
      throw new Error('cannot aggregate a capped foreign sweep');
    if (report.corpus.recordsSeen !== report.config.expectedRecords) {
      throw new Error('foreign sweep shard did not see the expected corpus record count');
    }
    if (
      report.corpus.selectedRecords !==
      expectedSelectedRecords(report.config.expectedRecords, report.shard)
    ) {
      throw new Error('foreign sweep shard selected-record count does not match modulo partition');
    }
    if (report.corpus.yieldedNotes !== report.corpus.selectedValidNotes) {
      throw new Error('foreign sweep shard did not yield every valid selected note');
    }
    if (report.sweep.notesPlanned !== report.corpus.yieldedNotes) {
      throw new Error('foreign sweep runner did not account for every yielded note');
    }
    if (report.sweep.editsPlanned !== report.sweep.editsCompleted) {
      throw new Error('foreign sweep shard did not complete every planned edit');
    }
    if (report.sweep.caretPositionsPlanned !== report.sweep.caretPositionsCompleted) {
      throw new Error('foreign sweep shard did not complete every planned caret position');
    }
    byIndex.set(report.shard.index, report);
  }

  const ordered = [...byIndex.values()].sort((left, right) => left.shard.index - right.shard.index);
  const recordsSeen = first.corpus.recordsSeen;
  if (ordered.some((report) => report.corpus.recordsSeen !== recordsSeen)) {
    throw new Error('foreign sweep shards disagree on corpus record count');
  }

  const corpus: ForeignSweepAggregateReport['corpus'] = {
    recordsSeen,
    selectedRecords: 0,
    selectedValidNotes: 0,
    selectedInvalidJson: 0,
    selectedMissingBody: 0,
    yieldedNotes: 0,
    omittedByLimit: 0,
    reachedEof: true,
  };
  const sweep = emptyForeignSweepResult();
  let wallMs = 0;
  let maxRssKb = 0;
  for (const report of ordered) {
    corpus.selectedRecords += report.corpus.selectedRecords;
    corpus.selectedValidNotes += report.corpus.selectedValidNotes;
    corpus.selectedInvalidJson += report.corpus.selectedInvalidJson;
    corpus.selectedMissingBody += report.corpus.selectedMissingBody;
    corpus.yieldedNotes += report.corpus.yieldedNotes;
    addSweep(sweep, report.sweep);
    wallMs = Math.max(wallMs, report.wallMs);
    maxRssKb = Math.max(maxRssKb, report.maxRssKb);
  }
  if (corpus.selectedRecords !== recordsSeen) {
    throw new Error('foreign sweep shards do not partition the complete corpus');
  }
  if (
    corpus.selectedRecords !==
    corpus.selectedValidNotes + corpus.selectedInvalidJson + corpus.selectedMissingBody
  ) {
    throw new Error('foreign sweep corpus accounting does not balance');
  }
  if (
    corpus.selectedInvalidJson !== 0 ||
    corpus.selectedMissingBody !== 0 ||
    corpus.selectedValidNotes !== first.config.expectedRecords ||
    corpus.yieldedNotes !== first.config.expectedRecords
  ) {
    throw new Error('foreign sweep did not run every expected corpus note');
  }
  if (sweep.editsPlanned !== sweep.editsCompleted) {
    throw new Error('foreign sweep aggregate did not complete every planned edit');
  }
  if (sweep.caretPositionsPlanned !== sweep.caretPositionsCompleted) {
    throw new Error('foreign sweep aggregate did not complete every planned caret position');
  }
  sweep.rewriteRate =
    sweep.editsCompleted === 0
      ? 0
      : (sweep.editedBlockRewrites + sweep.outsideBlockRewrites) / sweep.editsCompleted;

  return {
    schemaVersion: 1,
    candidate,
    corpusSha256,
    config: first.config,
    configFingerprint,
    shards: count,
    wallMs,
    maxRssKb,
    corpus,
    sweep,
  };
}
