import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from 'vitest';

vi.mock('$lib/platform');

import { testFS } from '$lib/platform';

const ENGAGEMENT_PATH = '.engagement-v1.json';

async function freshEngagement() {
  vi.resetModules();
  return import('./engagement');
}

beforeEach(() => {
  testFS._reset();
  vi.useRealTimers();
});

afterAll(() => {
  testFS._cleanup();
});

describe('loadEngagement', () => {
  it('loads empty data when file is missing', async () => {
    const { loadEngagement, getEngagementData } = await freshEngagement();
    await loadEngagement();
    expect(getEngagementData()).toEqual({});
  });

  it('loads empty data from malformed JSON', async () => {
    await testFS.writeAppData(ENGAGEMENT_PATH, 'not valid json!!!');
    const { loadEngagement, getEngagementData } = await freshEngagement();
    await loadEngagement();
    expect(getEngagementData()).toEqual({});
  });

  it('loads empty data when version is wrong', async () => {
    await testFS.writeAppData(ENGAGEMENT_PATH, JSON.stringify({ version: 99, notes: { a: {} } }));
    const { loadEngagement, getEngagementData } = await freshEngagement();
    await loadEngagement();
    expect(getEngagementData()).toEqual({});
  });

  it('loads empty data when notes is not an object', async () => {
    await testFS.writeAppData(ENGAGEMENT_PATH, JSON.stringify({ version: 1, notes: 'bad' }));
    const { loadEngagement, getEngagementData } = await freshEngagement();
    await loadEngagement();
    expect(getEngagementData()).toEqual({});
  });

  it('loads existing engagement data', async () => {
    const data = {
      version: 1,
      notes: {
        'my-note': { lastOpenedAt: 100, openCount: 3, lastEditedAt: 200, editCount: 1 },
      },
    };
    await testFS.writeAppData(ENGAGEMENT_PATH, JSON.stringify(data));
    const { loadEngagement, getEngagementData } = await freshEngagement();
    await loadEngagement();
    expect(getEngagementData()).toEqual(data.notes);
  });
});

describe('trackOpen', () => {
  it('creates a new record for first open', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-01T12:00:00Z'));
    const now = Date.now();

    const { loadEngagement, trackOpen, getEngagementData } = await freshEngagement();
    await loadEngagement();
    trackOpen('note-a');

    const record = getEngagementData()['note-a'];
    expect(record).toBeDefined();
    expect(record.lastOpenedAt).toBe(now);
    expect(record.openCount).toBe(1);
    expect(record.lastEditedAt).toBe(0);
    expect(record.editCount).toBe(0);
  });

  it('increments openCount and updates lastOpenedAt for existing record', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-01T12:00:00Z'));

    const { loadEngagement, trackOpen, getEngagementData } = await freshEngagement();
    await loadEngagement();
    trackOpen('note-a');

    vi.setSystemTime(new Date('2026-03-01T13:00:00Z'));
    const later = Date.now();
    trackOpen('note-a');

    const record = getEngagementData()['note-a'];
    expect(record.openCount).toBe(2);
    expect(record.lastOpenedAt).toBe(later);
  });
});

describe('trackEdit', () => {
  it('creates a new record for first edit', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-01T12:00:00Z'));
    const now = Date.now();

    const { loadEngagement, trackEdit, getEngagementData } = await freshEngagement();
    await loadEngagement();
    trackEdit('note-b');

    const record = getEngagementData()['note-b'];
    expect(record).toBeDefined();
    expect(record.lastEditedAt).toBe(now);
    expect(record.editCount).toBe(1);
    expect(record.lastOpenedAt).toBe(0);
    expect(record.openCount).toBe(0);
  });

  it('increments editCount and updates lastEditedAt for existing record', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-01T12:00:00Z'));

    const { loadEngagement, trackEdit, getEngagementData } = await freshEngagement();
    await loadEngagement();
    trackEdit('note-b');

    vi.setSystemTime(new Date('2026-03-01T14:00:00Z'));
    const later = Date.now();
    trackEdit('note-b');

    const record = getEngagementData()['note-b'];
    expect(record.editCount).toBe(2);
    expect(record.lastEditedAt).toBe(later);
  });
});

describe('removeEngagement', () => {
  it('deletes the record for a note', async () => {
    const { loadEngagement, trackOpen, removeEngagement, getEngagementData } = await freshEngagement();
    await loadEngagement();
    trackOpen('note-c');
    expect(getEngagementData()['note-c']).toBeDefined();

    removeEngagement('note-c');
    expect(getEngagementData()['note-c']).toBeUndefined();
  });

  it('is a no-op for missing noteId', async () => {
    const { loadEngagement, removeEngagement, getEngagementData } = await freshEngagement();
    await loadEngagement();
    removeEngagement('nonexistent');
    expect(getEngagementData()).toEqual({});
  });
});

describe('renameEngagement', () => {
  it('moves record from old id to new id', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-01T12:00:00Z'));

    const { loadEngagement, trackOpen, renameEngagement, getEngagementData } = await freshEngagement();
    await loadEngagement();
    trackOpen('old-name');

    const originalRecord = { ...getEngagementData()['old-name'] };
    renameEngagement('old-name', 'new-name');

    expect(getEngagementData()['old-name']).toBeUndefined();
    expect(getEngagementData()['new-name']).toEqual(originalRecord);
  });

  it('is a no-op when old id does not exist', async () => {
    const { loadEngagement, renameEngagement, getEngagementData } = await freshEngagement();
    await loadEngagement();
    renameEngagement('nonexistent', 'new-name');
    expect(getEngagementData()).toEqual({});
  });
});

describe('flushEngagement', () => {
  it('writes engagement data to appdata', async () => {
    const { loadEngagement, trackOpen, flushEngagement } = await freshEngagement();
    await loadEngagement();
    trackOpen('note-d');
    await flushEngagement();

    const raw = await testFS.readAppData(ENGAGEMENT_PATH);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.version).toBe(1);
    expect(parsed.notes['note-d']).toBeDefined();
    expect(parsed.notes['note-d'].openCount).toBe(1);
  });

  it('does not write when no data is loaded', async () => {
    // Don't call loadEngagement — cached is null
    const { flushEngagement } = await freshEngagement();
    await flushEngagement();

    const raw = await testFS.readAppData(ENGAGEMENT_PATH);
    expect(raw).toBeNull();
  });
});

describe('timer-based persist', () => {
  it('persists after PERSIST_DELAY_MS via schedulePersist', async () => {
    vi.useFakeTimers();

    const { loadEngagement, trackOpen } = await freshEngagement();
    await loadEngagement();
    trackOpen('note-e');

    // Data should not be persisted yet
    let raw = await testFS.readAppData(ENGAGEMENT_PATH);
    expect(raw).toBeNull();

    // Advance past the 5000ms debounce
    await vi.advanceTimersByTimeAsync(5000);

    raw = await testFS.readAppData(ENGAGEMENT_PATH);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.notes['note-e'].openCount).toBe(1);
  });

  it('debounces multiple operations into one write', async () => {
    vi.useFakeTimers();

    const { loadEngagement, trackOpen, trackEdit } = await freshEngagement();
    await loadEngagement();
    trackOpen('note-f');

    // Advance part way
    await vi.advanceTimersByTimeAsync(2000);
    trackEdit('note-f');

    // Advance past the first timer but not the second
    await vi.advanceTimersByTimeAsync(2000);
    let raw = await testFS.readAppData(ENGAGEMENT_PATH);
    expect(raw).toBeNull(); // Still debounced

    // Advance past the debounced timer
    await vi.advanceTimersByTimeAsync(3000);
    raw = await testFS.readAppData(ENGAGEMENT_PATH);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.notes['note-f'].openCount).toBe(1);
    expect(parsed.notes['note-f'].editCount).toBe(1);
  });

});
