import { describe, expect, it } from 'vitest';

import type {
  EditorGauntletAdapter,
  EditorIntentAction,
  EditorSnapshot,
  SourceSelection,
} from './types';
import { runForeignPreservationSweep } from './foreignPreservation';

class RecordingAdapter implements EditorGauntletAdapter {
  readonly name = 'recording';
  readonly caseIds: string[] = [];
  failWalk = false;
  failPerformAt = -1;
  saveMutation: 'exact' | 'inside' | 'outside' = 'exact';
  performCalls = 0;
  private source = '';
  private selection = 0;

  async open(source: string, caseId: string): Promise<void> {
    this.source = source;
    this.caseIds.push(caseId);
  }

  async select(selection: SourceSelection): Promise<void> {
    this.selection = selection.anchor;
  }

  async perform(_action: EditorIntentAction): Promise<EditorSnapshot[]> {
    this.performCalls += 1;
    if (this.performCalls === this.failPerformAt) throw new Error('synthetic perform failure');
    return [];
  }

  async save(): Promise<EditorSnapshot> {
    const exact = `${this.source.slice(0, this.selection)}x${this.source.slice(this.selection)}`;
    const savedSource =
      this.saveMutation === 'exact'
        ? exact
        : this.saveMutation === 'inside'
          ? `${exact.slice(0, this.selection + 1)}y${exact.slice(this.selection + 1)}`
          : `${exact}-outside`;
    return {
      source: savedSource,
      shellSource: savedSource,
      savedSource,
      visibleText: '',
      decorations: [],
      warnings: [],
      refused: false,
      mode: 'rich',
    };
  }

  async walkCaret(_positions: number[]): Promise<void> {
    if (this.failWalk) throw new Error('synthetic caret failure');
  }

  async undo(): Promise<EditorSnapshot> {
    throw new Error('unused');
  }

  async measureOpen(): Promise<never> {
    throw new Error('unused');
  }

  async measureKeystrokes(): Promise<never> {
    throw new Error('unused');
  }

  async captureFeelState(): Promise<never> {
    throw new Error('unused');
  }
}

describe('runForeignPreservationSweep', () => {
  it('walks every parsed block boundary and makes one isolated edit per block', async () => {
    const adapter = new RecordingAdapter();
    const result = await runForeignPreservationSweep(adapter, [
      { ordinal: 41, source: 'alpha\n\nbeta' },
    ]);

    expect(result).toMatchObject({
      notesPlanned: 1,
      notesParsed: 1,
      caretWalksPlanned: 1,
      caretWalksCompleted: 1,
      caretPositionsPlanned: 4,
      caretPositionsCompleted: 4,
      blocksPlanned: 2,
      editsPlanned: 2,
      editsCompleted: 2,
      failedEdits: 0,
      editedBlockRewrites: 0,
      outsideBlockRewrites: 0,
    });
    expect(adapter.caseIds).toEqual([
      'foreign-41-caret',
      'foreign-41-block-0',
      'foreign-41-block-1',
    ]);
  });

  it('turns operation exceptions into aggregate failure evidence and continues', async () => {
    const adapter = new RecordingAdapter();
    adapter.failWalk = true;
    adapter.failPerformAt = 1;
    const result = await runForeignPreservationSweep(adapter, [
      { ordinal: 7, source: 'alpha\n\nbeta' },
    ]);

    expect(result.caretWalksCompleted).toBe(0);
    expect(result.caretPositionsCompleted).toBe(0);
    expect(result.failures['caret-walk']).toBe(1);
    expect(result.blocksPlanned).toBe(2);
    expect(result.editsPlanned).toBe(2);
    expect(result.editsCompleted).toBe(1);
    expect(result.failedEdits).toBe(1);
    expect(result.failures['edit-perform']).toBe(1);
    expect(result.hardFailures.adapterOperations).toBe(2);
  });

  it.each([
    ['inside', 1, 0],
    ['outside', 0, 1],
  ] as const)(
    'classifies %s rewrites against the parser-owned block',
    async (mutation, inside, outside) => {
      const adapter = new RecordingAdapter();
      adapter.saveMutation = mutation;
      const result = await runForeignPreservationSweep(adapter, [{ ordinal: 0, source: 'alpha' }]);

      expect(result.editedBlockRewrites).toBe(inside);
      expect(result.outsideBlockRewrites).toBe(outside);
      expect(result.rewriteRate).toBe(1);
    },
  );
});
