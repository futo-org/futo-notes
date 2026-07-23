import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadState, nextWatermark, saveState } from './triageState.mjs';

describe('triageState persistence', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'triage-state-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the default watermark when no state file exists', () => {
    const state = loadState(dir);
    // Not the Unix epoch — GitHub's `since` filter rejects that value.
    expect(state.watermark).toBe('2000-01-01T00:00:00Z');
    expect(state.issues).toEqual({});
  });

  it('round-trips state through an atomic write', () => {
    const state = {
      watermark: '2026-07-23T04:36:27Z',
      issues: { 8: { status: 'queued', classifiedAs: 'bug' } },
    };
    saveState(state, dir);
    expect(loadState(dir)).toEqual(state);
  });
});

describe('nextWatermark', () => {
  it('returns the max updatedAt across current and new issues', () => {
    const result = nextWatermark('2026-07-01T00:00:00Z', [
      { updatedAt: '2026-07-05T00:00:00Z' },
      { updatedAt: '2026-07-23T04:36:27Z' },
      { updatedAt: '2026-07-10T00:00:00Z' },
    ]);
    expect(result).toBe('2026-07-23T04:36:27Z');
  });

  it('keeps the current watermark when no issue is newer', () => {
    expect(nextWatermark('2026-08-01T00:00:00Z', [{ updatedAt: '2026-07-05T00:00:00Z' }])).toBe(
      '2026-08-01T00:00:00Z',
    );
  });

  it('keeps the current watermark for an empty batch', () => {
    expect(nextWatermark('2026-07-01T00:00:00Z', [])).toBe('2026-07-01T00:00:00Z');
  });
});
