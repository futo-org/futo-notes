import { describe, expect, it } from 'vitest';

import { findActiveSyncRename } from './syncManager.svelte';

describe('findActiveSyncRename', () => {
  it('prefers an explicit rename from the sync summary', () => {
    expect(findActiveSyncRename({
      updatedIds: [],
      deletedIds: [],
      renamed: [{ fromId: 'Old Title', toId: 'New Title' }],
    }, 'Old Title')).toEqual({ fromId: 'Old Title', toId: 'New Title' });
  });

  it('falls back to a recent recorded rename target', () => {
    expect(findActiveSyncRename({
      updatedIds: [],
      deletedIds: ['Old Title'],
      renamed: [],
    }, 'Old Title', 'Recovered Title')).toEqual({ fromId: 'Old Title', toId: 'Recovered Title' });
  });

  it('infers a rename from delete plus collision-suffixed update', () => {
    expect(findActiveSyncRename({
      updatedIds: ['Old Title (2)'],
      deletedIds: ['Old Title'],
      renamed: [],
    }, 'Old Title')).toEqual({ fromId: 'Old Title', toId: 'Old Title (2)' });
  });

  it('returns null when sync only deleted the note with no recovery target', () => {
    expect(findActiveSyncRename({
      updatedIds: [],
      deletedIds: ['Old Title'],
      renamed: [],
    }, 'Old Title')).toBeNull();
  });
});
