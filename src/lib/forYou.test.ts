import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NotePreview } from '../types';
import type { EngagementRecord } from './engagement';
import { getForYouNotes } from './forYou';

function makeNote(id: string, modificationTime = Date.now()): NotePreview {
  return { id, title: id, preview: `preview of ${id}`, modificationTime };
}

function makeRecord(overrides: Partial<EngagementRecord> = {}): EngagementRecord {
  return {
    lastOpenedAt: 0,
    openCount: 0,
    lastEditedAt: 0,
    editCount: 0,
    ...overrides,
  };
}

const DAY_MS = 86_400_000;

describe('getForYouNotes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-24T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns empty array for empty notes', () => {
    expect(getForYouNotes([], {})).toEqual([]);
  });

  it('returns all notes when fewer than limit', () => {
    const notes = [makeNote('a'), makeNote('b')];
    const result = getForYouNotes(notes, {}, 3);
    expect(result).toHaveLength(2);
  });

  it('returns at most `limit` notes', () => {
    const notes = [makeNote('a'), makeNote('b'), makeNote('c'), makeNote('d')];
    const result = getForYouNotes(notes, {}, 2);
    expect(result).toHaveLength(2);
  });

  it('ranks recently opened notes higher', () => {
    const now = Date.now();
    const notes = [makeNote('old'), makeNote('recent')];
    const engagement: Record<string, EngagementRecord> = {
      old: makeRecord({ lastOpenedAt: now - 30 * DAY_MS, openCount: 1 }),
      recent: makeRecord({ lastOpenedAt: now - 1 * DAY_MS, openCount: 1 }),
    };

    const result = getForYouNotes(notes, engagement, 3);
    expect(result[0].id).toBe('recent');
  });

  it('ranks frequently opened notes higher', () => {
    const now = Date.now();
    const notes = [makeNote('few'), makeNote('many')];
    const engagement: Record<string, EngagementRecord> = {
      few: makeRecord({ lastOpenedAt: now - 5 * DAY_MS, openCount: 2 }),
      many: makeRecord({ lastOpenedAt: now - 5 * DAY_MS, openCount: 20 }),
    };

    const result = getForYouNotes(notes, engagement, 3);
    expect(result[0].id).toBe('many');
  });

  it('cold start: uses modificationTime as synthetic lastEditedAt', () => {
    const now = Date.now();
    const notes = [
      makeNote('old-file', now - 60 * DAY_MS),
      makeNote('new-file', now - 1 * DAY_MS),
    ];

    // No engagement data at all
    const result = getForYouNotes(notes, {}, 3);
    expect(result[0].id).toBe('new-file');
  });

  it('combines recency and frequency signals', () => {
    const now = Date.now();
    const notes = [makeNote('a'), makeNote('b'), makeNote('c')];
    const engagement: Record<string, EngagementRecord> = {
      // a: opened recently but rarely
      a: makeRecord({ lastOpenedAt: now - 1 * DAY_MS, openCount: 1 }),
      // b: not opened recently but very frequently
      b: makeRecord({ lastOpenedAt: now - 20 * DAY_MS, openCount: 50 }),
      // c: both recent and frequent (should win)
      c: makeRecord({ lastOpenedAt: now - 1 * DAY_MS, openCount: 50 }),
    };

    const result = getForYouNotes(notes, engagement, 3);
    expect(result[0].id).toBe('c');
  });

  it('defaults to limit of 3', () => {
    const notes = [makeNote('a'), makeNote('b'), makeNote('c'), makeNote('d'), makeNote('e')];
    const result = getForYouNotes(notes, {});
    expect(result).toHaveLength(3);
  });
});
