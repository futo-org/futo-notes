import { describe, expect, it } from 'vitest';

import type { ForeignSweepShardReport } from './foreignReport';
import { mergeForeignSweepShardReports } from './foreignReport';
import { emptyForeignSweepResult } from './foreignPreservation';

function shard(index: number, count = 2): ForeignSweepShardReport {
  const selectedRecords = index === 0 ? 2 : 1;
  const sweep = emptyForeignSweepResult();
  sweep.notesPlanned = selectedRecords;
  sweep.notesParsed = selectedRecords;
  return {
    schemaVersion: 1,
    candidate: 'candidate',
    shard: { index, count },
    corpus: {
      recordsSeen: 3,
      selectedRecords,
      selectedValidNotes: selectedRecords,
      selectedInvalidJson: 0,
      selectedMissingBody: 0,
      yieldedNotes: selectedRecords,
      omittedByLimit: 0,
      reachedEof: true,
    },
    sweep,
  };
}

describe('mergeForeignSweepShardReports', () => {
  it('exactly aggregates a complete modulo partition independent of input order', () => {
    const second = shard(1);
    second.sweep.blocksPlanned = 5;
    second.sweep.editsPlanned = 5;
    second.sweep.editsCompleted = 5;
    second.sweep.editedBlockRewrites = 1;
    const first = shard(0);
    first.sweep.blocksPlanned = 3;
    first.sweep.editsPlanned = 3;
    first.sweep.editsCompleted = 3;

    expect(mergeForeignSweepShardReports([second, first])).toMatchObject({
      candidate: 'candidate',
      shards: 2,
      corpus: {
        recordsSeen: 3,
        selectedRecords: 3,
        yieldedNotes: 3,
        reachedEof: true,
      },
      sweep: {
        notesPlanned: 3,
        blocksPlanned: 8,
        editsPlanned: 8,
        editsCompleted: 8,
        editedBlockRewrites: 1,
        rewriteRate: 0.125,
      },
    });
  });

  it('rejects missing, duplicate, capped, and imbalanced evidence', () => {
    expect(() => mergeForeignSweepShardReports([shard(0)])).toThrow(/expected 2/);
    expect(() => mergeForeignSweepShardReports([shard(0), shard(0)])).toThrow(/duplicate/);
    const capped = shard(1);
    capped.corpus.omittedByLimit = 1;
    expect(() => mergeForeignSweepShardReports([shard(0), capped])).toThrow(/capped/);
    const imbalanced = shard(1);
    imbalanced.corpus.selectedRecords = 2;
    expect(() => mergeForeignSweepShardReports([shard(0), imbalanced])).toThrow(
      /partition|balance/,
    );
    const incomplete = shard(1);
    incomplete.sweep.editsPlanned = 1;
    expect(() => mergeForeignSweepShardReports([shard(0), incomplete])).toThrow(/planned edit/);
  });
});
