import { describe, expect, it } from 'vitest';

import type { ScenarioReport } from '../diff.ts';
import type { VisualDiffResult } from '../visualDiff.ts';
import { summarizeCorpusRound } from './summary.ts';
import type { CorpusSampleResult } from './sample.ts';

describe('summarizeCorpusRound', () => {
  it('emits aggregate construct and drift buckets without source content', () => {
    const sample = {
      scenarios: [
        {
          name: 'corpus-callout-001',
          markdown: 'secret source',
          complexity: 1,
          construct: 'callout',
        },
        { name: 'corpus-table-001', markdown: 'also secret', complexity: 1, construct: 'table' },
      ],
      stats: {
        recordsSeen: 20,
        usableNotes: 18,
        oversizedNotesSkipped: 0,
        malformedRecords: 1,
        missingBodies: 0,
        piiFlaggedSkipped: 1,
        matchedConstructCounts: { callout: 4, table: 3 },
        primaryConstructCounts: { callout: 4, table: 3 },
        sampledByConstruct: { callout: 1, table: 1 },
      },
    } as unknown as CorpusSampleResult;
    const reports: ScenarioReport[] = [
      {
        name: 'corpus-callout-001',
        complexity: 1,
        satisfaction: 0,
        divergences: [
          { kind: 'decoration-only-in-obsidian', detail: 'callout mismatch' },
          { kind: 'visual-divergence', detail: '12% drift' },
        ],
      },
      {
        name: 'corpus-table-001',
        complexity: 1,
        satisfaction: 1,
        divergences: [],
      },
    ];
    const visualResults = [
      { scenarioName: 'corpus-callout-001', diffRatio: 0.12, sizesMatched: false },
      { scenarioName: 'corpus-table-001', diffRatio: 0.06, sizesMatched: false },
    ] as VisualDiffResult[];

    const summary = summarizeCorpusRound({
      seed: 13,
      requestedSampleSize: 2,
      scenarios: sample.scenarios,
      sampleStats: sample.stats,
      reports,
      visualResults,
    });

    expect(summary).toMatchObject({
      actualSampleSize: 2,
      comparedScreenshots: 2,
      structurallyDivergentNotes: 1,
      visualOverToleranceNotes: 1,
      confirmedStructuralMisrenders: null,
      confirmedVisualMisrenders: null,
      sizeMismatchedScreenshots: 2,
      structuralDivergenceBuckets: { 'decoration-only-in-obsidian': 1 },
      visualDriftBuckets: { '10-to-20-percent': 1, '5-to-10-percent': 1 },
    });
    expect(JSON.stringify(summary)).not.toContain('secret source');
    expect(JSON.stringify(summary)).not.toContain('also secret');
    expect(summary.limitations).toContain(
      'Every screenshot pair required size cropping in this run, so visual thresholds are candidates rather than confirmed mis-renders.',
    );
  });
});
