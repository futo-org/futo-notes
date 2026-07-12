// TS side of the cross-language constants gate (architecture-hardening.md
// PKT-7 gate 3 / findings F7, F21). Reads the SAME
// tests/conformance/constants.json the Rust side is pinned to
// (crates/futo-notes-model/tests/conformance.rs's `constants_conformance`,
// apps/tauri/src-tauri/src/filesystem_watcher.rs's suppression-window test)
// and asserts the TS copies agree. A copy drifting in either language fails
// here or there.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { IMAGE_EXTENSIONS } from '@futo-notes/shared';
import { MAX_TITLE_LENGTH } from '@futo-notes/editor';
import { LOCAL_WRITE_TTL_MS, SYNC_WRITE_TTL_MS } from './writeSuppression';

const CONSTANTS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../tests/conformance/constants.json',
);

const constants = JSON.parse(readFileSync(CONSTANTS_PATH, 'utf8'));

describe('cross-language constants conformance', () => {
  it('@futo-notes/shared IMAGE_EXTENSIONS matches the fixture', () => {
    expect([...IMAGE_EXTENSIONS]).toEqual(constants.imageExtensions);
  });

  it('rules MAX_TITLE_LENGTH matches the fixture', () => {
    expect(MAX_TITLE_LENGTH).toBe(constants.maxTitleLength);
  });

  it('writeSuppression TTLs match the fixture (and the Rust watcher window)', () => {
    expect(LOCAL_WRITE_TTL_MS).toBe(constants.writeSuppressionLocalTtlMs);
    expect(SYNC_WRITE_TTL_MS).toBe(constants.writeSuppressionSyncTtlMs);
    expect(SYNC_WRITE_TTL_MS).toBe(constants.watcherSuppressionWindowMs);
  });
});
