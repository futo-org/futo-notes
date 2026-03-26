import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  isRecordingEnabled,
  recordSnapshot,
  getSnapshots,
  clearSnapshots,
  getBufferCapacity,
  dumpFailingSnapshot,
} from '../../src/sync/recording.js';
import type { SyncRequest, SyncResponse } from '@futo-notes/shared';

function makeRequest(noteCount = 0): SyncRequest {
  return {
    notes: Array.from({ length: noteCount }, (_, i) => ({
      uuid: `uuid-${i}`,
      filename: `note-${i}.md`,
      content_hash: `hash-${i}`,
      hash_at_last_sync: '',
      modified_at: Date.now(),
      content: `content-${i}`,
    })),
    inventory: [],
    deleted_uuids: [],
  };
}

function makeResponse(): SyncResponse {
  return { update: [], delete: [], hash_updates: [], conflicts: [] };
}

describe('sync recording', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.SYNC_RECORDING = process.env.SYNC_RECORDING;
    savedEnv.SYNC_RECORDING_BUFFER_SIZE = process.env.SYNC_RECORDING_BUFFER_SIZE;
    savedEnv.NODE_ENV = process.env.NODE_ENV;
    // Reset buffer state
    delete process.env.SYNC_RECORDING_BUFFER_SIZE;
    clearSnapshots();
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  // ── isRecordingEnabled ────────────────────────────────

  it('enabled by default when NODE_ENV is not production', () => {
    delete process.env.SYNC_RECORDING;
    process.env.NODE_ENV = 'test';
    expect(isRecordingEnabled()).toBe(true);
  });

  it('disabled by default when NODE_ENV is production', () => {
    delete process.env.SYNC_RECORDING;
    process.env.NODE_ENV = 'production';
    expect(isRecordingEnabled()).toBe(false);
  });

  it('respects SYNC_RECORDING=true', () => {
    process.env.SYNC_RECORDING = 'true';
    process.env.NODE_ENV = 'production';
    expect(isRecordingEnabled()).toBe(true);
  });

  it('respects SYNC_RECORDING=false', () => {
    process.env.SYNC_RECORDING = 'false';
    process.env.NODE_ENV = 'test';
    expect(isRecordingEnabled()).toBe(false);
  });

  it('respects SYNC_RECORDING=1', () => {
    process.env.SYNC_RECORDING = '1';
    expect(isRecordingEnabled()).toBe(true);
  });

  // ── Ring buffer ───────────────────────────────────────

  it('records and retrieves snapshots in order', () => {
    recordSnapshot(makeRequest(1), makeResponse(), 0, 1);
    recordSnapshot(makeRequest(2), makeResponse(), 1, 2);

    const snaps = getSnapshots();
    expect(snaps).toHaveLength(2);
    expect(snaps[0].request.notes).toHaveLength(1);
    expect(snaps[1].request.notes).toHaveLength(2);
    expect(snaps[0].version_before).toBe(0);
    expect(snaps[1].version_before).toBe(1);
  });

  it('wraps around when buffer overflows', () => {
    process.env.SYNC_RECORDING_BUFFER_SIZE = '3';
    clearSnapshots(); // re-init with new size

    recordSnapshot(makeRequest(1), makeResponse(), 0, 1);
    recordSnapshot(makeRequest(2), makeResponse(), 1, 2);
    recordSnapshot(makeRequest(3), makeResponse(), 2, 3);
    recordSnapshot(makeRequest(4), makeResponse(), 3, 4); // overwrites slot 0

    const snaps = getSnapshots();
    expect(snaps).toHaveLength(3);
    // Oldest is now the one with 2 notes (slot 1), not 1 note (overwritten)
    expect(snaps[0].request.notes).toHaveLength(2);
    expect(snaps[1].request.notes).toHaveLength(3);
    expect(snaps[2].request.notes).toHaveLength(4);
  });

  it('clearSnapshots empties the buffer', () => {
    recordSnapshot(makeRequest(), makeResponse(), 0, 0);
    expect(getSnapshots()).toHaveLength(1);

    clearSnapshots();
    expect(getSnapshots()).toHaveLength(0);
  });

  it('default buffer capacity is 100', () => {
    delete process.env.SYNC_RECORDING_BUFFER_SIZE;
    clearSnapshots();
    expect(getBufferCapacity()).toBe(100);
  });

  it('buffer capacity is configurable', () => {
    process.env.SYNC_RECORDING_BUFFER_SIZE = '50';
    clearSnapshots();
    expect(getBufferCapacity()).toBe(50);
  });

  // ── Dump to disk ──────────────────────────────────────

  it('writes a dump file on invariant failure', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-test-'));
    const dbPath = path.join(tmpDir, 'test.db');

    try {
      dumpFailingSnapshot(
        dbPath,
        makeRequest(1),
        makeResponse(),
        { passed: false, violations: ['test violation'] },
      );

      const files = fs.readdirSync(tmpDir).filter((f) => f.startsWith('sync-recording-'));
      expect(files).toHaveLength(1);

      const content = JSON.parse(fs.readFileSync(path.join(tmpDir, files[0]), 'utf8'));
      expect(content.invariants.violations).toEqual(['test violation']);
      expect(content.request.notes).toHaveLength(1);
      expect(content.dumpedAt).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not throw if dump directory is unwritable', () => {
    // Pass a path that doesn't exist — should silently swallow
    expect(() => {
      dumpFailingSnapshot(
        '/nonexistent/path/test.db',
        makeRequest(),
        makeResponse(),
        { passed: false, violations: ['v'] },
      );
    }).not.toThrow();
  });
});
