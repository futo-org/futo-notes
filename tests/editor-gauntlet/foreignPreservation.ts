import type { EditorGauntletAdapter } from './types';
import { markdownBlockRanges } from './markdownStructure';

export interface ForeignNote {
  id: string;
  source: string;
}

export interface ForeignSweepResult {
  notes: number;
  edits: number;
  refusals: number;
  warnings: number;
  exactOnlyNotes: number;
  editedBlockRewrites: number;
  outsideBlockRewrites: number;
  rewriteRate: number;
}

function diffBounds(
  expected: string,
  actual: string,
): { from: number; expectedTo: number; actualTo: number } {
  let from = 0;
  while (from < expected.length && from < actual.length && expected[from] === actual[from])
    from += 1;
  let expectedTo = expected.length;
  let actualTo = actual.length;
  while (
    expectedTo > from &&
    actualTo > from &&
    expected[expectedTo - 1] === actual[actualTo - 1]
  ) {
    expectedTo -= 1;
    actualTo -= 1;
  }
  return { from, expectedTo, actualTo };
}

export async function runForeignPreservationSweep(
  adapter: EditorGauntletAdapter,
  notes: Iterable<ForeignNote>,
): Promise<ForeignSweepResult> {
  const result: ForeignSweepResult = {
    notes: 0,
    edits: 0,
    refusals: 0,
    warnings: 0,
    exactOnlyNotes: 0,
    editedBlockRewrites: 0,
    outsideBlockRewrites: 0,
    rewriteRate: 0,
  };

  for (const note of notes) {
    result.notes += 1;
    const blocks = markdownBlockRanges(note.source);
    await adapter.open(note.source, `${note.id}/caret-walk`);
    await adapter.walkCaret(blocks.flatMap((block) => [block.from, block.to]));
    let noteWasExactOnly = false;

    for (const [blockIndex, block] of blocks.entries()) {
      await adapter.open(note.source, `${note.id}/block-${blockIndex}`);
      await adapter.select({ anchor: block.from });
      await adapter.perform({ type: 'insert-text', text: 'x' });
      const saved = await adapter.save();
      result.edits += 1;
      if (saved.refused) result.refusals += 1;
      if (saved.warnings.length > 0) result.warnings += 1;
      if (saved.mode === 'exact-only') noteWasExactOnly = true;

      const expected = `${note.source.slice(0, block.from)}x${note.source.slice(block.from)}`;
      if (saved.savedSource === expected) continue;
      const diff = diffBounds(expected, saved.savedSource);
      const adjustedBlockTo = block.to + 1;
      if (diff.from < block.from || diff.expectedTo > adjustedBlockTo) {
        result.outsideBlockRewrites += 1;
      } else {
        result.editedBlockRewrites += 1;
      }
    }

    if (noteWasExactOnly) result.exactOnlyNotes += 1;
  }

  result.rewriteRate =
    result.edits === 0
      ? 0
      : (result.editedBlockRewrites + result.outsideBlockRewrites) / result.edits;
  return result;
}
