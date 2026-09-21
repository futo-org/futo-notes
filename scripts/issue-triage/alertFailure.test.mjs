import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { reportFailure } from './alertFailure.mjs';
import { ALERT_THROTTLE_MS, loadHealth, recordFailureReason } from './healthState.mjs';
import { HEALTH_TOPIC } from './zulipAlerts.mjs';

const NOW = Date.parse('2026-09-02T12:00:00Z');

describe('reportFailure', () => {
  let dir;
  let postAlert;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'triage-alert-'));
    postAlert = vi.fn(async () => ({ id: 1 }));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function run(nowMs = NOW) {
    return reportFailure({ nowMs, stateDirectory: dir, dependencies: { postAlert } });
  }

  it('posts to the stable health topic, not a per-issue one', async () => {
    await run();
    expect(postAlert).toHaveBeenCalledTimes(1);
    expect(postAlert.mock.calls[0][0].topic).toBe(HEALTH_TOPIC);
  });

  it('says new issues are not arriving, and how to see the full error', async () => {
    await run();
    const { content } = postAlert.mock.calls[0][0];
    expect(content).toContain('NOT reaching this channel');
    expect(content).toContain('journalctl --user -u futo-notes-issue-triage.service');
    // The watermark means nothing is lost; say so, or the reader assumes it is.
    expect(content).toContain('Nothing is lost');
  });

  it('quotes the reason the poller recorded', async () => {
    recordFailureReason('GitHub 401 on /repos/futo-org/futo-notes/issues: Bad credentials', dir);
    await run();
    expect(postAlert.mock.calls[0][0].content).toContain('Bad credentials');
  });

  // The unit failing IS the signal: a crash before poll.mjs's error handler
  // (no node, OOM, unreadable EnvironmentFile) must still reach the channel.
  it('alerts even when nothing recorded a reason', async () => {
    await run();
    expect(postAlert).toHaveBeenCalledTimes(1);
    expect(postAlert.mock.calls[0][0].content).toContain('without recording a reason');
  });

  it('opens the outage and stamps the alert', async () => {
    await run();
    expect(loadHealth(dir)).toMatchObject({
      failing: true,
      firstFailureAt: '2026-09-02T12:00:00.000Z',
      alertCount: 1,
    });
  });

  it('stays quiet on the next tick but keeps the outage open', async () => {
    await run();
    const result = await run(NOW + 15 * 60_000);

    expect(result).toEqual({ alerted: false, throttled: true });
    expect(postAlert).toHaveBeenCalledTimes(1);
    // firstFailureAt must survive the quiet ticks or the recovery message
    // reports the wrong duration.
    expect(loadHealth(dir)).toMatchObject({
      failing: true,
      firstFailureAt: '2026-09-02T12:00:00.000Z',
    });
  });

  it('re-alerts after the throttle window, marked as still failing', async () => {
    await run();
    await run(NOW + ALERT_THROTTLE_MS);

    expect(postAlert).toHaveBeenCalledTimes(2);
    expect(postAlert.mock.calls[1][0].content).toContain('still failing');
    expect(loadHealth(dir).alertCount).toBe(2);
  });

  it('propagates a Zulip failure so the unit goes red instead of looking sent', async () => {
    postAlert.mockRejectedValueOnce(new Error('Zulip post failed (500)'));
    await expect(run()).rejects.toThrow(/Zulip post failed/);
    // The alert was not stamped, so the next tick tries again rather than
    // treating the unsent alarm as delivered.
    expect(loadHealth(dir).lastAlertAt).toBeNull();
  });
});
