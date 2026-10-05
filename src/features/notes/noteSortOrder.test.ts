// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_NOTE_SORT_ORDER } from '$lib/localNoteStore';
import {
  NOTE_SORT_ORDER_KEY,
  persistNoteSortOrder,
  readPersistedNoteSortOrder,
  sortDirectionLabelPath,
  withSortDirection,
  withSortKey,
} from './noteSortOrder';

describe('note sort order preference', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to last modified, newest first', () => {
    expect(readPersistedNoteSortOrder()).toEqual(DEFAULT_NOTE_SORT_ORDER);
    expect(DEFAULT_NOTE_SORT_ORDER).toEqual({ key: 'lastModified', direction: 'descending' });
  });

  it('round-trips through localStorage', () => {
    persistNoteSortOrder({ key: 'name', direction: 'descending' });
    expect(readPersistedNoteSortOrder()).toEqual({ key: 'name', direction: 'descending' });
  });

  it('falls back to the default on garbage or unknown values', () => {
    localStorage.setItem(NOTE_SORT_ORDER_KEY, '{not json');
    expect(readPersistedNoteSortOrder()).toEqual(DEFAULT_NOTE_SORT_ORDER);
    localStorage.setItem(NOTE_SORT_ORDER_KEY, JSON.stringify({ key: 'created', direction: 'up' }));
    expect(readPersistedNoteSortOrder()).toEqual(DEFAULT_NOTE_SORT_ORDER);
  });

  it('keeps the menu position when the key changes: Recent first pairs with A-Z', () => {
    expect(withSortKey({ key: 'lastModified', direction: 'descending' }, 'name')).toEqual({
      key: 'name',
      direction: 'ascending',
    });
    expect(withSortKey({ key: 'name', direction: 'descending' }, 'lastModified')).toEqual({
      key: 'lastModified',
      direction: 'ascending',
    });
  });

  it('swaps the direction and keeps the key', () => {
    expect(withSortDirection({ key: 'name', direction: 'ascending' }, 'descending')).toEqual({
      key: 'name',
      direction: 'descending',
    });
  });

  it('labels directions by what they mean for the active key', () => {
    expect(sortDirectionLabelPath('name', 'ascending')).toBe('notes.sort.aToZ');
    expect(sortDirectionLabelPath('name', 'descending')).toBe('notes.sort.zToA');
    expect(sortDirectionLabelPath('lastModified', 'descending')).toBe('notes.sort.newest');
    expect(sortDirectionLabelPath('lastModified', 'ascending')).toBe('notes.sort.oldest');
  });
});
