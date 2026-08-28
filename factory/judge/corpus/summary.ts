import type { ScenarioReport } from '../diff.ts';
import type { VisualDiffResult } from '../visualDiff.ts';
import type { CorpusConstruct, CorpusSampleStats, CorpusScenario } from './sample.ts';

export interface CorpusAggregateReport {
  mode: 'stratified-bounded-corpus-notes';
  seed: number;
  requestedSampleSize: number;
  actualSampleSize: number;
  sourcePopulation: CorpusSampleStats;
  comparedScreenshots: number;
  structurallyDivergentNotes: number;
  visualOverToleranceNotes: number;
  confirmedStructuralMisrenders: null;
  confirmedVisualMisrenders: null;
  erroredNotes: number;
  structuralDivergenceBuckets: Record<string, number>;
  visualDriftBuckets: Record<string, number>;
  sizeMismatchedScreenshots: number;
  byConstruct: Record<
    CorpusConstruct,
    {
      sampled: number;
      structurallyDivergent: number;
      visualOverTolerance: number;
      errored: number;
    }
  >;
  limitations: string[];
}

const VISUAL_KIND = 'visual-divergence';

function visualBucket(ratio: number): string {
  if (ratio < 0.05) return 'under-5-percent';
  if (ratio < 0.1) return '5-to-10-percent';
  if (ratio < 0.2) return '10-to-20-percent';
  return '20-percent-or-more';
}

export function summarizeCorpusRound({
  seed,
  requestedSampleSize,
  scenarios,
  sampleStats,
  reports,
  visualResults,
}: {
  seed: number;
  requestedSampleSize: number;
  scenarios: CorpusScenario[];
  sampleStats: CorpusSampleStats;
  reports: ScenarioReport[];
  visualResults: VisualDiffResult[];
}): CorpusAggregateReport {
  const constructByName = new Map(scenarios.map((scenario) => [scenario.name, scenario.construct]));
  const byConstruct = Object.fromEntries(
    Object.keys(sampleStats.sampledByConstruct).map((construct) => [
      construct,
      { sampled: 0, structurallyDivergent: 0, visualOverTolerance: 0, errored: 0 },
    ]),
  ) as CorpusAggregateReport['byConstruct'];
  const structuralDivergenceBuckets: Record<string, number> = {};
  let structurallyDivergentNotes = 0;
  let visualOverToleranceNotes = 0;
  let erroredNotes = 0;

  for (const report of reports) {
    const construct = constructByName.get(report.name);
    if (!construct) continue;
    const bucket = byConstruct[construct];
    bucket.sampled += 1;
    if (report.error) {
      bucket.errored += 1;
      erroredNotes += 1;
    }
    const structural = report.divergences.filter((divergence) => divergence.kind !== VISUAL_KIND);
    const visual = report.divergences.some((divergence) => divergence.kind === VISUAL_KIND);
    if (structural.length > 0) {
      bucket.structurallyDivergent += 1;
      structurallyDivergentNotes += 1;
    }
    if (visual) {
      bucket.visualOverTolerance += 1;
      visualOverToleranceNotes += 1;
    }
    for (const divergence of structural) {
      structuralDivergenceBuckets[divergence.kind] =
        (structuralDivergenceBuckets[divergence.kind] ?? 0) + 1;
    }
  }

  const visualDriftBuckets: Record<string, number> = {};
  for (const result of visualResults) {
    const bucket = visualBucket(result.diffRatio);
    visualDriftBuckets[bucket] = (visualDriftBuckets[bucket] ?? 0) + 1;
  }
  const sizeMismatchedScreenshots = visualResults.filter((result) => !result.sizesMatched).length;
  const visualSizeLimitation =
    visualResults.length > 0 && sizeMismatchedScreenshots === visualResults.length
      ? 'Every screenshot pair required size cropping in this run, so visual thresholds are candidates rather than confirmed mis-renders.'
      : 'Screenshot pairs with different dimensions are cropped before comparison; review them before inferring a mis-render.';

  return {
    mode: 'stratified-bounded-corpus-notes',
    seed,
    requestedSampleSize,
    actualSampleSize: scenarios.length,
    sourcePopulation: sampleStats,
    comparedScreenshots: visualResults.length,
    structurallyDivergentNotes,
    visualOverToleranceNotes,
    confirmedStructuralMisrenders: null,
    confirmedVisualMisrenders: null,
    erroredNotes,
    structuralDivergenceBuckets,
    visualDriftBuckets,
    sizeMismatchedScreenshots,
    byConstruct,
    limitations: [
      'The unit is a complete note under explicit line and character bounds; oversized notes are excluded and counted.',
      'Stratification intentionally over-samples rare construct buckets; these rates do not estimate corpus-wide prevalence.',
      'A parity divergence says FUTO Notes and Obsidian differ; without human review it does not identify which rendering is correct.',
      'The structural oracle drops unknown decoration kinds and cannot see CSS pseudo-elements.',
      'The visual oracle compares Chromium and Electron rasterization; sub-threshold drift includes font and runtime noise.',
      'Confirmed mis-render counts are null because this automated run does not assign correctness.',
      visualSizeLimitation,
      'This is a single-run census; repeat cursor, selection, and lazy-rendering divergences before treating them as stable.',
      'PII-flagged records are skipped, but the corpus flagger is heuristic; detailed artifacts remain local-only.',
    ],
  };
}
