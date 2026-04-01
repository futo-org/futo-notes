import { describe, expect, it } from 'vitest';

import { shouldWriteNoteToDisk } from './noteSession.svelte.ts';

describe('shouldWriteNoteToDisk', () => {
  it('persists a new note even when the body is empty', () => {
    expect(
      shouldWriteNoteToDisk({
        originalId: null,
        savedTitle: 'Untitled',
        newTitle: 'Title only',
        content: '',
        newContent: '',
      }),
    ).toBe(true);
  });

  it('skips writes for existing notes when neither title nor content changed', () => {
    expect(
      shouldWriteNoteToDisk({
        originalId: 'existing',
        savedTitle: 'Existing',
        newTitle: 'Existing',
        content: '',
        newContent: '',
      }),
    ).toBe(false);
  });
});
