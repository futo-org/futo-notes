import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWriteSuppressor } from './writeSuppression';

describe('writeSuppression', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('recordWrite / isRecentWrite', () => {
    it('recognizes a write within the 1s window', () => {
      const ws = createWriteSuppressor();
      ws.recordWrite('note.md');
      expect(ws.isRecentWrite('note.md')).toBe(true);
    });

    it('returns false for unknown filenames', () => {
      const ws = createWriteSuppressor();
      expect(ws.isRecentWrite('unknown.md')).toBe(false);
    });

    it('expires after 1 second', () => {
      const ws = createWriteSuppressor();
      ws.recordWrite('note.md');
      vi.advanceTimersByTime(1001);
      expect(ws.isRecentWrite('note.md')).toBe(false);
    });

    it('is still valid just before the 1s threshold', () => {
      const ws = createWriteSuppressor();
      ws.recordWrite('note.md');
      vi.advanceTimersByTime(999);
      expect(ws.isRecentWrite('note.md')).toBe(true);
    });

    it('cleans up entries older than 2s on subsequent recordWrite calls', () => {
      const ws = createWriteSuppressor();
      ws.recordWrite('old.md');
      vi.advanceTimersByTime(2100);
      ws.recordWrite('new.md');
      // old.md should have been cleaned up by the recordWrite('new.md') call
      expect(ws.isRecentWrite('old.md')).toBe(false);
      expect(ws.isRecentWrite('new.md')).toBe(true);
    });
  });

  describe('recordSyncWrite / isRecentSyncWrite', () => {
    it('recognizes a sync write within the 5s window', () => {
      const ws = createWriteSuppressor();
      ws.recordSyncWrite('synced.md');
      expect(ws.isRecentSyncWrite('synced.md')).toBe(true);
    });

    it('returns false for unknown filenames', () => {
      const ws = createWriteSuppressor();
      expect(ws.isRecentSyncWrite('unknown.md')).toBe(false);
    });

    it('expires after 5 seconds', () => {
      const ws = createWriteSuppressor();
      ws.recordSyncWrite('synced.md');
      vi.advanceTimersByTime(5001);
      expect(ws.isRecentSyncWrite('synced.md')).toBe(false);
    });

    it('is still valid just before the 5s threshold', () => {
      const ws = createWriteSuppressor();
      ws.recordSyncWrite('synced.md');
      vi.advanceTimersByTime(4999);
      expect(ws.isRecentSyncWrite('synced.md')).toBe(true);
    });

    it('cleans up entries older than 5s on subsequent recordSyncWrite calls', () => {
      const ws = createWriteSuppressor();
      ws.recordSyncWrite('old.md');
      vi.advanceTimersByTime(5100);
      ws.recordSyncWrite('new.md');
      expect(ws.isRecentSyncWrite('old.md')).toBe(false);
      expect(ws.isRecentSyncWrite('new.md')).toBe(true);
    });
  });

  describe('recordRemoteRename / getRecentRemoteRename', () => {
    it('records and retrieves a rename', () => {
      const ws = createWriteSuppressor();
      ws.recordRemoteRename('old-id', 'new-id');
      const result = ws.getRecentRemoteRename('old-id');
      expect(result).not.toBeNull();
      expect(result!.toId).toBe('new-id');
    });

    it('returns null for unknown ids', () => {
      const ws = createWriteSuppressor();
      expect(ws.getRecentRemoteRename('unknown')).toBeNull();
    });

    it('expires after 5 seconds', () => {
      const ws = createWriteSuppressor();
      ws.recordRemoteRename('old-id', 'new-id');
      vi.advanceTimersByTime(5001);
      expect(ws.getRecentRemoteRename('old-id')).toBeNull();
    });

    it('cleans up entries older than 5s on subsequent recordRemoteRename calls', () => {
      const ws = createWriteSuppressor();
      ws.recordRemoteRename('old-1', 'new-1');
      vi.advanceTimersByTime(5100);
      ws.recordRemoteRename('old-2', 'new-2');
      expect(ws.getRecentRemoteRename('old-1')).toBeNull();
      expect(ws.getRecentRemoteRename('old-2')).not.toBeNull();
    });

    it('overwrites a rename for the same source id', () => {
      const ws = createWriteSuppressor();
      ws.recordRemoteRename('old-id', 'new-1');
      ws.recordRemoteRename('old-id', 'new-2');
      const result = ws.getRecentRemoteRename('old-id');
      expect(result!.toId).toBe('new-2');
    });
  });

  describe('independence', () => {
    it('local writes and sync writes are tracked independently', () => {
      const ws = createWriteSuppressor();
      ws.recordWrite('note.md');
      expect(ws.isRecentSyncWrite('note.md')).toBe(false);

      ws.recordSyncWrite('synced.md');
      expect(ws.isRecentWrite('synced.md')).toBe(false);
    });

    it('separate instances do not share state', () => {
      const ws1 = createWriteSuppressor();
      const ws2 = createWriteSuppressor();
      ws1.recordWrite('note.md');
      expect(ws2.isRecentWrite('note.md')).toBe(false);
    });
  });
});
