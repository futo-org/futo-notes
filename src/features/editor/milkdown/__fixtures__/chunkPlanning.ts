import { expect } from 'vitest';
import { planMarkdownChunks } from '../markdownChunks';

/** The one invariant every plan must satisfy, whatever it decided. */
export function expectLossless(markdown: string): string[] {
  const plan = planMarkdownChunks(markdown, { minLines: 0, firstChunkLines: 2, chunkLines: 2 });
  expect(plan.chunks.join('')).toBe(markdown);
  return plan.chunks;
}
