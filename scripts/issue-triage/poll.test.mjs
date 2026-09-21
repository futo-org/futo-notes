import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { beginOutage, loadHealth, markAlerted, saveHealth } from './healthState.mjs';
import { runPoll } from './poll.mjs';
import { loadState, saveState, updateState } from './triageState.mjs';
import { HEALTH_TOPIC } from './zulipAlerts.mjs';

const FRESH_ISSUE = {
  number: 9,
  title: 'How do I export notes?',
  body: '',
  author: 'reporter',
  url: 'https://github.com/futo-org/futo-notes/issues/9',
  createdAt: '2026-07-31T00:00:00Z',
  updatedAt: '2026-07-31T00:01:00Z',
};

describe('runPoll state coordination', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'triage-poll-'));
    saveState(
      {
        watermark: '2026-07-30T00:00:00Z',
        issues: {
          8: {
            status: 'queued',
            classifiedAs: 'bug',
            title: 'Existing bug',
          },
        },
      },
      dir,
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('preserves a tier-2 transition while recording a newly posted issue', async () => {
    await runPoll({
      dryRun: false,
      stateDirectory: dir,
      dependencies: {
        fetchIssuesSince: async () => [FRESH_ISSUE],
        postAlert: async () => {
          await updateState((state) => {
            state.issues['8'].status = 'reproducing';
          }, dir);
          return { id: 123 };
        },
      },
    });

    expect(loadState(dir)).toMatchObject({
      watermark: '2026-07-31T00:01:00Z',
      issues: {
        8: { status: 'reproducing' },
        9: { status: 'posted', zulipMessageId: 123 },
      },
    });
  });

  it('reads issues without a GitHub credential', async () => {
    let received;
    await runPoll({
      dryRun: false,
      stateDirectory: dir,
      dependencies: {
        fetchIssuesSince: async (params) => {
          received = params;
          return [];
        },
        postAlert: async () => ({ id: 1 }),
      },
    });
    expect(received).toEqual({ repo: 'futo-org/futo-notes', since: '2026-07-30T00:00:00Z' });
    expect(received).not.toHaveProperty('token');
  });
});

describe('runPoll outage recovery', () => {
  let dir;
  let postAlert;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'triage-poll-recovery-'));
    saveState({ watermark: '2026-07-30T00:00:00Z', issues: {} }, dir);
    postAlert = vi.fn(async () => ({ id: 1 }));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function openOutage(atIso = '2026-08-22T17:06:28Z') {
    const at = Date.parse(atIso);
    saveHealth(markAlerted(beginOutage(loadHealth(dir), at), at), dir);
  }

  function run({ dryRun = false, issues = [] } = {}) {
    return runPoll({
      dryRun,
      stateDirectory: dir,
      dependencies: { fetchIssuesSince: async () => issues, postAlert },
    });
  }

  it('says nothing about health when the poller was never failing', async () => {
    const result = await run();
    expect(result.recovered).toBe(false);
    expect(postAlert).not.toHaveBeenCalled();
  });

  it('posts the all-clear on the first success after an outage', async () => {
    openOutage();
    const result = await run();

    expect(result.recovered).toBe(true);
    expect(postAlert).toHaveBeenCalledTimes(1);
    const { topic, content } = postAlert.mock.calls[0][0];
    expect(topic).toBe(HEALTH_TOPIC);
    expect(content).toContain('working again');
    expect(content).toContain('No issues were missed.');
    expect(loadHealth(dir).failing).toBe(false);
  });

  // The channel has to answer "did I miss anything?" — the 2026-08-22 outage
  // held back nine issues.
  it('reports how many issues the catch-up run posted, after posting them', async () => {
    openOutage();
    await run({ issues: [FRESH_ISSUE] });

    expect(postAlert).toHaveBeenCalledTimes(2);
    expect(postAlert.mock.calls[0][0].topic).toBe('gh#9: How do I export notes?');
    expect(postAlert.mock.calls[1][0].content).toContain('Caught up 1 issue, posted above.');
  });

  it('states the outage duration', async () => {
    openOutage('2026-08-22T17:06:28Z');
    await run();
    expect(postAlert.mock.calls[0][0].content).toMatch(/failing for \d+ days/);
  });

  it('does not clear the outage on a dry run', async () => {
    openOutage();
    const result = await run({ dryRun: true });

    expect(result.recovered).toBe(false);
    expect(postAlert).not.toHaveBeenCalled();
    expect(loadHealth(dir).failing).toBe(true);
  });

  it('posts the all-clear only once', async () => {
    openOutage();
    await run();
    await run();
    expect(postAlert).toHaveBeenCalledTimes(1);
  });
});
