import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ALERT_THROTTLE_MS,
  beginOutage,
  endOutage,
  loadHealth,
  markAlerted,
  outageDuration,
  recordFailureReason,
  saveHealth,
  shouldAlert,
} from './healthState.mjs';

const NOW = Date.parse('2026-09-02T12:00:00Z');

describe('shouldAlert', () => {
  it('alerts on the first failure of an outage', () => {
    expect(shouldAlert(loadHealthDefaults(), NOW)).toBe(true);
  });

  it('stays quiet inside the throttle window', () => {
    const health = { ...loadHealthDefaults(), lastAlertAt: new Date(NOW - 60_000).toISOString() };
    expect(shouldAlert(health, NOW)).toBe(false);
  });

  it('re-alerts once the window has passed', () => {
    const health = {
      ...loadHealthDefaults(),
      lastAlertAt: new Date(NOW - ALERT_THROTTLE_MS).toISOString(),
    };
    expect(shouldAlert(health, NOW)).toBe(true);
  });

  // A 15-minute timer failing for the 11 days the PAT outage actually lasted
  // must not produce ~1,050 Zulip messages.
  it('costs one message per window across a multi-day outage', () => {
    const ticks = (11 * 24 * 60) / 15;
    let health = loadHealthDefaults();
    let alerts = 0;
    for (let tick = 0; tick < ticks; tick += 1) {
      const now = NOW + tick * 15 * 60_000;
      health = beginOutage(health, now);
      if (shouldAlert(health, now)) {
        health = markAlerted(health, now);
        alerts += 1;
      }
    }
    expect(ticks).toBe(1056);
    expect(alerts).toBe((11 * 24 * 3_600_000) / ALERT_THROTTLE_MS);
    expect(alerts).toBe(44);
  });

  it('alerts rather than going silent on an unparseable stamp', () => {
    expect(shouldAlert({ ...loadHealthDefaults(), lastAlertAt: 'not-a-date' }, NOW)).toBe(true);
  });
});

describe('beginOutage', () => {
  it('stamps the start of a new outage', () => {
    expect(beginOutage(loadHealthDefaults(), NOW)).toMatchObject({
      failing: true,
      firstFailureAt: '2026-09-02T12:00:00.000Z',
    });
  });

  it('keeps the original start time when the outage is already open', () => {
    const open = beginOutage(loadHealthDefaults(), NOW);
    const later = beginOutage(open, NOW + 86_400_000);
    expect(later.firstFailureAt).toBe(open.firstFailureAt);
  });
});

describe('outageDuration', () => {
  it.each([
    [45 * 60_000, '45 minutes'],
    [60 * 60_000, '1 hour'],
    [20 * 3_600_000, '20 hours'],
    [11 * 86_400_000, '11 days'],
  ])('renders %ims as %s', (elapsed, expected) => {
    expect(outageDuration(new Date(NOW - elapsed).toISOString(), NOW)).toBe(expected);
  });

  it('does not invent a duration without a start time', () => {
    expect(outageDuration(null, NOW)).toBe('an unknown period');
  });
});

describe('persistence', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'triage-health-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads defaults before the file exists', () => {
    expect(loadHealth(dir)).toMatchObject({ failing: false, alertCount: 0, lastError: null });
  });

  it('round-trips through disk', () => {
    saveHealth(markAlerted(beginOutage(loadHealth(dir), NOW), NOW), dir);
    expect(loadHealth(dir)).toMatchObject({
      failing: true,
      alertCount: 1,
      firstFailureAt: '2026-09-02T12:00:00.000Z',
    });
  });

  it('records a failure reason without opening the outage itself', () => {
    recordFailureReason('GitHub 401 on /repos/futo-org/futo-notes/issues', dir);
    const health = loadHealth(dir);
    expect(health.lastError).toMatch(/GitHub 401/);
    // Opening the outage is alertFailure.mjs's job, so a crash before poll.mjs
    // records anything still alerts.
    expect(health.failing).toBe(false);
  });

  it('writes health.json, never state.json', () => {
    saveHealth(beginOutage(loadHealth(dir), NOW), dir);
    expect(readFileSync(join(dir, 'health.json'), 'utf8')).toContain('failing');
    expect(() => readFileSync(join(dir, 'state.json'), 'utf8')).toThrow();
  });

  describe('endOutage', () => {
    it('returns null when the poller was already healthy', () => {
      expect(endOutage(dir)).toBeNull();
    });

    it('returns the closed outage and clears the file', () => {
      saveHealth(markAlerted(beginOutage(loadHealth(dir), NOW), NOW), dir);
      const closed = endOutage(dir);
      expect(closed).toMatchObject({ failing: true, firstFailureAt: '2026-09-02T12:00:00.000Z' });
      expect(loadHealth(dir)).toMatchObject({ failing: false, alertCount: 0 });
    });

    it('reports recovery only once', () => {
      saveHealth(beginOutage(loadHealth(dir), NOW), dir);
      expect(endOutage(dir)).not.toBeNull();
      expect(endOutage(dir)).toBeNull();
    });
  });

  it('fails loudly on a corrupt file rather than resetting silently', () => {
    writeFileSync(join(dir, 'health.json'), '{ not json');
    expect(() => loadHealth(dir)).toThrow();
  });
});

function loadHealthDefaults() {
  return {
    failing: false,
    firstFailureAt: null,
    lastAlertAt: null,
    alertCount: 0,
    lastError: null,
    lastErrorAt: null,
  };
}
