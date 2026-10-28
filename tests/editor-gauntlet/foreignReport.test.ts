import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  fingerprintForeignSweepConfig,
  mergeForeignSweepShardReports,
  type ForeignSweepRunConfig,
  type ForeignSweepShardReport,
} from './foreignReport';
import { emptyForeignSweepResult } from './foreignPreservation';

function shard(index: number, count = 2): ForeignSweepShardReport {
  const selectedRecords = index === 0 ? 2 : 1;
  const sweep = emptyForeignSweepResult();
  sweep.notesPlanned = selectedRecords;
  sweep.notesParsed = selectedRecords;
  const config: ForeignSweepRunConfig = {
    semanticsVersion: 'foreign-preservation-v4',
    assertions: 'byte-fidelity',
    candidate: 'candidate',
    candidateRevision: 'candidate-revision',
    adapterRevision: 'adapter-sha',
    corpusSha256: 'corpus-sha',
    expectedRecords: 3,
    maxNotes: null,
    artifactCapture: 'off-retry-on-failure',
    shardCount: count,
    selection: 'zero-based-record-ordinal-modulo',
    blocks: 'lezer-markdown-gfm-top-level-v1',
    caretWalk: 'block-from-and-to-with-render-frame-v1',
    edit: 'isolated-insert-x-at-block-from-v1',
  };
  return {
    schemaVersion: 1,
    candidate: 'candidate',
    corpusSha256: 'corpus-sha',
    config,
    configFingerprint: fingerprintForeignSweepConfig(config),
    shard: { index, count },
    wallMs: 100 + index,
    maxRssKb: 1_000 + index,
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
  it.each([true, false])('aggregates CLI inputs with output flag: %s', (withOutput) => {
    const directory = mkdtempSync(path.join(tmpdir(), 'foreign-aggregate-'));
    try {
      const inputs = [0, 1].map((index) => {
        const file = path.join(directory, `shard-${index}.json`);
        writeFileSync(file, JSON.stringify(shard(index)));
        return file;
      });
      const output = path.join(directory, 'aggregate.json');
      const args = withOutput ? ['--', '--output', output, ...inputs] : inputs;
      const result = spawnSync(
        'pnpm',
        ['--silent', 'run', 'test:editor-gauntlet:foreign:aggregate', ...args],
        { encoding: 'utf8' },
      );
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('EDITOR_GAUNTLET_FOREIGN_AGGREGATE');
      if (withOutput) expect(JSON.parse(readFileSync(output, 'utf8')).shards).toBe(2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('sums the loss counters and unions the lost-word samples across shards', () => {
    const first = shard(0);
    first.sweep.lossyEdits = 2;
    first.sweep.lostTokenEvents = 3;
    first.sweep.lostTokenSamples = ['alpha', 'beta'];
    const second = shard(1);
    second.sweep.lossyEdits = 1;
    second.sweep.lostTokenEvents = 4;
    second.sweep.lostTokenSamples = ['beta', 'gamma'];

    const merged = mergeForeignSweepShardReports([first, second]);

    expect(merged.sweep.lossyEdits).toBe(3);
    expect(merged.sweep.lostTokenEvents).toBe(7);
    expect(merged.sweep.lostTokenSamples).toEqual(['alpha', 'beta', 'gamma']);
  });

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
      corpusSha256: 'corpus-sha',
      shards: 2,
      wallMs: 101,
      maxRssKb: 1_001,
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

  it('rejects mixed corpus, config, revision, and expected-record evidence', () => {
    const wrongCorpus = shard(1);
    wrongCorpus.corpusSha256 = 'other-corpus';
    expect(() => mergeForeignSweepShardReports([shard(0), wrongCorpus])).toThrow(/corpus SHA/);

    const wrongRevision = shard(1);
    wrongRevision.config.adapterRevision = 'other-adapter';
    wrongRevision.configFingerprint = fingerprintForeignSweepConfig(wrongRevision.config);
    expect(() => mergeForeignSweepShardReports([shard(0), wrongRevision])).toThrow(
      /config fingerprint/,
    );

    const wrongExpectedCount = shard(1);
    wrongExpectedCount.corpus.recordsSeen = 2;
    expect(() => mergeForeignSweepShardReports([shard(0), wrongExpectedCount])).toThrow(
      /expected corpus record count/,
    );
  });
});
