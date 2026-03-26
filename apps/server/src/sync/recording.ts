import fs from 'node:fs';
import path from 'node:path';
import type { SyncRequest, SyncResponse } from '@futo-notes/shared';
import type { InvariantResult } from './invariants.js';
import { log } from '../logger.js';

export interface SyncSnapshot {
  timestamp: number;
  request: SyncRequest;
  response: SyncResponse;
  version_before: number;
  version_after: number;
}

// ── Ring buffer ──────────────────────────────────────────

const DEFAULT_BUFFER_SIZE = 100;
let buffer: Array<SyncSnapshot | null> = [];
let writeIndex = 0;
let bufferCapacity = 0;

function ensureBuffer(): void {
  const size = parseInt(process.env.SYNC_RECORDING_BUFFER_SIZE || '', 10) || DEFAULT_BUFFER_SIZE;
  if (bufferCapacity !== size) {
    buffer = new Array(size).fill(null);
    writeIndex = 0;
    bufferCapacity = size;
  }
}

// ── Public API ───────────────────────────────────────────

/**
 * Whether recording is enabled.
 * Default: true when NODE_ENV !== 'production', overridable via SYNC_RECORDING.
 */
export function isRecordingEnabled(): boolean {
  const explicit = process.env.SYNC_RECORDING;
  if (explicit !== undefined) {
    return explicit === 'true' || explicit === '1';
  }
  return process.env.NODE_ENV !== 'production';
}

/** Record a sync snapshot into the ring buffer. */
export function recordSnapshot(
  request: SyncRequest,
  response: SyncResponse,
  versionBefore: number,
  versionAfter: number,
): void {
  ensureBuffer();
  buffer[writeIndex] = {
    timestamp: Date.now(),
    request,
    response,
    version_before: versionBefore,
    version_after: versionAfter,
  };
  writeIndex = (writeIndex + 1) % bufferCapacity;
}

/**
 * Dump a failing snapshot to disk for post-hoc analysis.
 * Written to `path.dirname(databasePath)/sync-recording-<timestamp>.json`.
 * Silently swallows write errors (best-effort diagnostic).
 */
export function dumpFailingSnapshot(
  databasePath: string,
  request: SyncRequest,
  response: SyncResponse,
  invariants: InvariantResult,
): void {
  try {
    const dir = path.dirname(databasePath);
    const filename = `sync-recording-${Date.now()}.json`;
    const fullPath = path.join(dir, filename);
    const payload = { request, response, invariants, dumpedAt: new Date().toISOString() };
    fs.writeFileSync(fullPath, JSON.stringify(payload, null, 2), 'utf8');
    log.error(`Sync recording dumped to ${fullPath}`);
  } catch {
    // Best-effort — never break sync
  }
}

/** Return all snapshots in chronological order (oldest first). */
export function getSnapshots(): SyncSnapshot[] {
  ensureBuffer();
  const result: SyncSnapshot[] = [];
  // Read from writeIndex (oldest) to writeIndex-1 (newest), wrapping around
  for (let i = 0; i < bufferCapacity; i++) {
    const idx = (writeIndex + i) % bufferCapacity;
    if (buffer[idx] !== null) {
      result.push(buffer[idx]);
    }
  }
  return result;
}

/** Clear the ring buffer. */
export function clearSnapshots(): void {
  buffer = new Array(bufferCapacity || DEFAULT_BUFFER_SIZE).fill(null);
  writeIndex = 0;
}

/** Return the current ring buffer capacity. */
export function getBufferCapacity(): number {
  ensureBuffer();
  return bufferCapacity;
}
