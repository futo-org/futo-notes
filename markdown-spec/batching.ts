import type { SpecCase } from './schema.js';

export const STATIC_BLUR_BATCH_SIZE = 15;

export interface MarkdownSpecPartitions {
  staticBlurBatches: SpecCase[][];
  isolatedCases: SpecCase[];
}

export function partitionMarkdownSpecCases(
  cases: SpecCase[],
  batchSize = STATIC_BLUR_BATCH_SIZE,
): MarkdownSpecPartitions {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(`Markdown spec batch size must be a positive integer, got ${batchSize}`);
  }

  const staticBlurCases: SpecCase[] = [];
  const isolatedCases: SpecCase[] = [];

  for (const specCase of cases) {
    if (!specCase.moves?.length && specCase.cursor === null) {
      staticBlurCases.push(specCase);
    } else {
      isolatedCases.push(specCase);
    }
  }

  const staticBlurBatches: SpecCase[][] = [];
  for (let index = 0; index < staticBlurCases.length; index += batchSize) {
    staticBlurBatches.push(staticBlurCases.slice(index, index + batchSize));
  }

  return { staticBlurBatches, isolatedCases };
}
