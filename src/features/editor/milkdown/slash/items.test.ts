import { describe, expect, it } from 'vitest';

import { filterSlashItems, SLASH_ITEMS, type SlashItem } from './items';

const ids = (items: SlashItem[]): string[] => items.map((i) => i.id);

describe('SLASH_ITEMS', () => {
  it('has no duplicate ids', () => {
    expect(new Set(ids(SLASH_ITEMS)).size).toBe(SLASH_ITEMS.length);
  });
});

describe('filterSlashItems', () => {
  it('offers everything for an empty query', () => {
    expect(filterSlashItems('')).toEqual(SLASH_ITEMS);
    expect(filterSlashItems('   ')).toEqual(SLASH_ITEMS);
  });

  it('leads with a label prefix', () => {
    expect(ids(filterSlashItems('head'))).toEqual(['heading-1', 'heading-2', 'heading-3']);
  });

  it('keeps manifest order between equally good matches', () => {
    expect(ids(filterSlashItems('heading'))).toEqual(['heading-1', 'heading-2', 'heading-3']);
  });

  it('matches an id prefix the label does not carry', () => {
    expect(ids(filterSlashItems('task'))).toContain('task-list');
  });

  it('matches a keyword the label does not carry', () => {
    expect(ids(filterSlashItems('h1'))).toEqual(['heading-1']);
    expect(ids(filterSlashItems('todo'))).toEqual(['task-list']);
    expect(ids(filterSlashItems('hr'))).toEqual(['divider']);
  });

  it('ranks a label prefix above a keyword match', () => {
    // "Table" (label prefix) must beat "task-list" (no match) and must come
    // before anything that only mentions the word.
    expect(ids(filterSlashItems('tab'))[0]).toBe('table');
  });

  it('is case-insensitive', () => {
    expect(ids(filterSlashItems('QUOTE'))).toEqual(ids(filterSlashItems('quote')));
  });

  it('offers nothing when nothing matches', () => {
    expect(filterSlashItems('zzzz')).toEqual([]);
  });

  it('offers both lists for the shared "list" keyword', () => {
    const matched = ids(filterSlashItems('list'));
    expect(matched).toContain('bullet-list');
    expect(matched).toContain('ordered-list');
    expect(matched).toContain('task-list');
  });
});
