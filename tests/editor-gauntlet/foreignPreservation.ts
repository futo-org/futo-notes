import type { EditorGauntletAdapter } from './types';
import { detectTextLoss } from './lossOracle';
import { markdownBlockRanges } from './markdownStructure';

/** The one character every isolated edit types. */
export const SWEEP_INSERTED_TEXT = 'x';

/** How many distinct lost words a report keeps as evidence. */
const LOST_TOKEN_SAMPLE_LIMIT = 50;

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
  /**
   * Edits after which at least one word the note had is gone. This is the
   * loss-only bar a WYSIWYG candidate is held to (ADR-0002): the rewrite
   * counters above stay as evidence, because a round trip legitimately rewrites
   * markdown syntax, but nothing a reader wrote may disappear.
   */
  lossyEdits: number;
  /** Total lost word occurrences across every edit. */
  lostTokenEvents: number;
  /** Up to 50 distinct lost words, so a red run says WHAT went missing. */
  lostTokenSamples: string[];
  hardFailures: {
    parseNotes: number;
    uneditableEdits: number;
    budgetExceededOperations: number;
    adapterOperations: number;
  };
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
    lossyEdits: 0,
    lostTokenEvents: 0,
    lostTokenSamples: [],
    hardFailures: {
      parseNotes: 0,
      uneditableEdits: 0,
      budgetExceededOperations: 0,
      adapterOperations: 0,
    },
    failures: emptyFailures(),
  };
}

function countOperationFailure(
  result: ForeignSweepResult,
  stage: ForeignSweepFailureStage,
  error: unknown,
): void {
  result.failures[stage] += 1;
  if (stage === 'parse') {
    result.hardFailures.parseNotes += 1;
  } else if (error instanceof Error && error.name === 'TimeoutError') {
    result.hardFailures.budgetExceededOperations += 1;
  } else {
    result.hardFailures.adapterOperations += 1;
  }
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
    } catch (error) {
      countOperationFailure(result, 'parse', error);
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
      } catch (error) {
        countOperationFailure(result, 'caret-walk', error);
      }
    } catch (error) {
      countOperationFailure(result, 'caret-open', error);
    }

    let noteWasExactOnly = false;

    for (const [blockIndex, block] of blocks.entries()) {
      result.blocksPlanned += 1;
      result.editsPlanned += 1;
      try {
        await adapter.open(note.source, `foreign-${note.ordinal}-block-${blockIndex}`);
      } catch (error) {
        countOperationFailure(result, 'edit-open', error);
        result.failedEdits += 1;
        continue;
      }
      try {
        await adapter.select({ anchor: block.from });
      } catch (error) {
        countOperationFailure(result, 'edit-select', error);
        result.failedEdits += 1;
        continue;
      }
      try {
        await adapter.perform({ type: 'insert-text', text: SWEEP_INSERTED_TEXT });
      } catch (error) {
        countOperationFailure(result, 'edit-perform', error);
        result.failedEdits += 1;
        continue;
      }

      let saved;
      try {
        saved = await adapter.save();
      } catch (error) {
        countOperationFailure(result, 'edit-save', error);
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
      if (saved.refused || saved.mode === 'exact-only') result.hardFailures.uneditableEdits += 1;

      // Loss is measured against the note as it arrived, not against the
      // byte-exact expected string: a rich editor puts the typed character
      // inside the block's text where a source offset would have put it before
      // the block marker, and that is the same edit, not a lost word.
      const loss = detectTextLoss(note.source, saved.savedSource, {
        absorbable: SWEEP_INSERTED_TEXT,
      });
      if (loss.lostTokenCount > 0) {
        result.lossyEdits += 1;
        result.lostTokenEvents += loss.lostTokenCount;
        for (const token of loss.lostTokens) {
          if (result.lostTokenSamples.length >= LOST_TOKEN_SAMPLE_LIMIT) break;
          if (!result.lostTokenSamples.includes(token)) result.lostTokenSamples.push(token);
        }
      }

      const expected =
        note.source.slice(0, block.from) + SWEEP_INSERTED_TEXT + note.source.slice(block.from);
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
