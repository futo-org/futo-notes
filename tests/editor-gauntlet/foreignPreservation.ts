import type { EditorGauntletAdapter } from './types';
import { markdownBlockRanges } from './markdownStructure';

export interface ForeignNote {
  /** Corpus position only; never a title, hash, URL, or other source identifier. */
  ordinal: number;
  source: string;
}

export type ForeignSweepFailureStage =
  | 'parse'
  | 'caret-open'
  | 'caret-walk'
  | 'edit-open'
  | 'edit-select'
  | 'edit-perform'
  | 'edit-save';

export interface ForeignSweepResult {
  notesPlanned: number;
  notesParsed: number;
  caretWalksPlanned: number;
  caretWalksCompleted: number;
  caretPositionsPlanned: number;
  caretPositionsCompleted: number;
  blocksPlanned: number;
  editsPlanned: number;
  editsCompleted: number;
  failedEdits: number;
  refusals: number;
  editsWithWarnings: number;
  warningEvents: number;
  exactOnlyNotes: number;
  editedBlockRewrites: number;
  outsideBlockRewrites: number;
  rewriteRate: number;
  failures: Record<ForeignSweepFailureStage, number>;
}

function emptyFailures(): Record<ForeignSweepFailureStage, number> {
  return {
    parse: 0,
    'caret-open': 0,
    'caret-walk': 0,
    'edit-open': 0,
    'edit-select': 0,
    'edit-perform': 0,
    'edit-save': 0,
  };
}

export function emptyForeignSweepResult(): ForeignSweepResult {
  return {
    notesPlanned: 0,
    notesParsed: 0,
    caretWalksPlanned: 0,
    caretWalksCompleted: 0,
    caretPositionsPlanned: 0,
    caretPositionsCompleted: 0,
    blocksPlanned: 0,
    editsPlanned: 0,
    editsCompleted: 0,
    failedEdits: 0,
    refusals: 0,
    editsWithWarnings: 0,
    warningEvents: 0,
    exactOnlyNotes: 0,
    editedBlockRewrites: 0,
    outsideBlockRewrites: 0,
    rewriteRate: 0,
    failures: emptyFailures(),
  };
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
  notes: Iterable<ForeignNote> | AsyncIterable<ForeignNote>,
  onProgress?: (result: Readonly<ForeignSweepResult>) => void,
): Promise<ForeignSweepResult> {
  const result = emptyForeignSweepResult();

  for await (const note of notes) {
    result.notesPlanned += 1;
    let blocks;
    try {
      blocks = markdownBlockRanges(note.source);
      result.notesParsed += 1;
    } catch {
      result.failures.parse += 1;
      onProgress?.(result);
      continue;
    }

    result.caretWalksPlanned += 1;
    const caretPositions = blocks.flatMap((block) => [block.from, block.to]);
    result.caretPositionsPlanned += caretPositions.length;
    try {
      await adapter.open(note.source, `foreign-${note.ordinal}-caret`);
      try {
        await adapter.walkCaret(caretPositions);
        result.caretWalksCompleted += 1;
        result.caretPositionsCompleted += caretPositions.length;
      } catch {
        result.failures['caret-walk'] += 1;
      }
    } catch {
      result.failures['caret-open'] += 1;
    }

    let noteWasExactOnly = false;

    for (const [blockIndex, block] of blocks.entries()) {
      result.blocksPlanned += 1;
      result.editsPlanned += 1;
      try {
        await adapter.open(note.source, `foreign-${note.ordinal}-block-${blockIndex}`);
      } catch {
        result.failures['edit-open'] += 1;
        result.failedEdits += 1;
        continue;
      }
      try {
        await adapter.select({ anchor: block.from });
      } catch {
        result.failures['edit-select'] += 1;
        result.failedEdits += 1;
        continue;
      }
      try {
        await adapter.perform({ type: 'insert-text', text: 'x' });
      } catch {
        result.failures['edit-perform'] += 1;
        result.failedEdits += 1;
        continue;
      }

      let saved;
      try {
        saved = await adapter.save();
      } catch {
        result.failures['edit-save'] += 1;
        result.failedEdits += 1;
        continue;
      }
      result.editsCompleted += 1;
      if (saved.refused) result.refusals += 1;
      if (saved.warnings.length > 0) {
        result.editsWithWarnings += 1;
        result.warningEvents += saved.warnings.length;
      }
      if (saved.mode === 'exact-only') noteWasExactOnly = true;

      const expected = `${note.source.slice(0, block.from)}x${note.source.slice(block.from)}`;
      if (saved.savedSource === expected) continue;
      const diff = diffBounds(expected, saved.savedSource);
      const adjustedBlockTo = block.to + 1;
      if (
        diff.from < block.from ||
        diff.expectedTo > adjustedBlockTo ||
        diff.actualTo > adjustedBlockTo
      ) {
        result.outsideBlockRewrites += 1;
      } else {
        result.editedBlockRewrites += 1;
      }
    }

    if (noteWasExactOnly) result.exactOnlyNotes += 1;
    onProgress?.(result);
  }

  result.rewriteRate =
    result.editsCompleted === 0
      ? 0
      : (result.editedBlockRewrites + result.outsideBlockRewrites) / result.editsCompleted;
  return result;
}
