import { describe, expect, it } from 'vitest';

import { shouldWriteNoteToDisk } from './noteSession.svelte.ts';

describe('shouldWriteNoteToDisk', () => {
  it('persists a new note when the title was changed', () => {
    expect(
      shouldWriteNoteToDisk({
        savedTitle: 'Untitled',
        newTitle: 'Title only',
        content: '',
        newContent: '',
      }),
    ).toBe(true);
  });

  it('skips writes for a brand-new note that was never touched', () => {
    // Regression: programmatic setEditorContent('') during loadNote('new')
    // used to fire a phantom debouncedSave, which wrote an empty note
    // to disk just because originalId was null.
    expect(
      shouldWriteNoteToDisk({
        savedTitle: 'Untitled (1)',
        newTitle: 'Untitled (1)',
        content: '',
        newContent: '',
      }),
    ).toBe(false);
  });

  it('skips writes for existing notes when neither title nor content changed', () => {
    expect(
      shouldWriteNoteToDisk({
        savedTitle: 'Existing',
        newTitle: 'Existing',
        content: '',
        newContent: '',
      }),
    ).toBe(false);
  });
});
