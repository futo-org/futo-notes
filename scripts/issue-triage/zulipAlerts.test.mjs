import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HEALTH_TOPIC,
  formatAlert,
  formatFailureAlert,
  formatRecoveryAlert,
  postAlert,
  topicForIssue,
} from './zulipAlerts.mjs';

const NOW = Date.parse('2026-09-02T12:00:00Z');

describe('topicForIssue', () => {
  it('builds gh#<number>: <title>', () => {
    expect(topicForIssue(8, 'Black text in dark mode')).toBe('gh#8: Black text in dark mode');
  });

  it('trims long titles so the topic fits Zulip 60-char limit, keeping the number', () => {
    const topic = topicForIssue(123, 'x'.repeat(200));
    expect(topic.length).toBeLessThanOrEqual(60);
    expect(topic.startsWith('gh#123: ')).toBe(true);
    expect(topic.endsWith('…')).toBe(true);
  });
});

describe('formatAlert', () => {
  const issue = {
    number: 8,
    title: 'Black text',
    body: 'line1\nline2',
    author: 'decloyd',
    createdAt: '2026-07-23T04:22:28Z',
    url: 'https://github.com/futo-org/futo-notes/issues/8',
  };

  it('includes attribution, link, classification, and a quoted body preview', () => {
    const content = formatAlert({
      issue,
      classification: { kind: 'bug', reason: 'mentions "black text"' },
    });
    expect(content).toContain(
      '[gh#8: Black text](https://github.com/futo-org/futo-notes/issues/8)',
    );
    expect(content).toContain('Opened by `decloyd` on 2026-07-23');
    expect(content).toContain('classification: **bug**');
    expect(content).toContain('> line1');
    expect(content).toContain('> line2');
  });

  it('handles an empty body without throwing', () => {
    const content = formatAlert({
      issue: { ...issue, body: '' },
      classification: { kind: 'other', reason: 'x' },
    });
    expect(content).toContain('_(no description)_');
  });
});

describe('postAlert', () => {
  // Every case here must start from a known credential state: a developer shell
  // (or CI job) that exports ZULIP_TRIAGE_BOT_* would otherwise leak into the
  // absent-credentials case below.
  beforeEach(() => {
    delete process.env.ZULIP_TRIAGE_BOT_EMAIL;
    delete process.env.ZULIP_TRIAGE_BOT_KEY;
  });

  afterEach(() => {
    delete process.env.ZULIP_TRIAGE_BOT_EMAIL;
    delete process.env.ZULIP_TRIAGE_BOT_KEY;
  });

  it('throws when credentials are absent', async () => {
    // Inject a fetch that cannot reach the network. postAlert defaults
    // fetchImpl to the real global fetch, so this case used to POST to the live
    // futo-notes-alerts channel whenever the guard under test did not fire.
    const fetchImpl = vi.fn(() => {
      throw new Error('postAlert must not reach the network in this test');
    });

    await expect(postAlert({ topic: 't', content: 'c', fetchImpl })).rejects.toThrow(
      /ZULIP_TRIAGE_BOT/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns the message id on success', async () => {
    process.env.ZULIP_TRIAGE_BOT_EMAIL = 'bot@zulip';
    process.env.ZULIP_TRIAGE_BOT_KEY = 'key';
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ result: 'success', id: 462662 }),
    }));
    const result = await postAlert({ topic: 't', content: 'c', fetchImpl });
    expect(result.id).toBe(462662);
  });

  it('throws when Zulip reports an error (no silent green)', async () => {
    process.env.ZULIP_TRIAGE_BOT_EMAIL = 'bot@zulip';
    process.env.ZULIP_TRIAGE_BOT_KEY = 'key';
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ result: 'error', msg: 'bad stream' }),
    }));
    await expect(postAlert({ topic: 't', content: 'c', fetchImpl })).rejects.toThrow(/bad stream/);
  });
});

describe('health messages', () => {
  it('keeps every health message on one stable topic', () => {
    // A per-outage topic would scatter the history and could collide with an
    // issue topic; this one is followable and mutable on its own.
    expect(HEALTH_TOPIC).toBe('poller health');
    expect(HEALTH_TOPIC).not.toMatch(/^gh#/);
  });

  describe('formatFailureAlert', () => {
    it('leads with the consequence, not the error', () => {
      const content = formatFailureAlert({
        error: 'GitHub 401: Bad credentials',
        sinceIso: '2026-08-22T17:06:28Z',
        nowMs: NOW,
        alertCount: 0,
      });
      expect(content.split('\n')[0]).toContain('NOT reaching this channel');
      expect(content).toContain('Failing since: 2026-08-22T17:06:28Z');
      expect(content).toContain('GitHub 401: Bad credentials');
    });

    it('marks a repeat as still failing, with the elapsed time', () => {
      const content = formatFailureAlert({
        error: 'GitHub 401',
        sinceIso: '2026-08-22T17:06:28Z',
        nowMs: NOW,
        alertCount: 3,
      });
      expect(content).toContain('still failing');
      expect(content).toMatch(/failing for \d+ days/);
    });

    it('quotes a multi-line reason as one block', () => {
      const content = formatFailureAlert({
        error: 'line one\nline two',
        sinceIso: null,
        nowMs: NOW,
        alertCount: 0,
      });
      expect(content).toContain('> line one\n> line two');
    });

    it('says the reason is missing rather than printing nothing', () => {
      const content = formatFailureAlert({
        error: null,
        sinceIso: null,
        nowMs: NOW,
        alertCount: 0,
      });
      expect(content).toContain('without recording a reason');
    });
  });

  describe('formatRecoveryAlert', () => {
    it('reports the duration and the catch-up count', () => {
      const content = formatRecoveryAlert({
        sinceIso: '2026-08-22T17:06:28Z',
        nowMs: NOW,
        postedCount: 9,
      });
      expect(content).toContain('working again');
      expect(content).toContain('failing for 11 days');
      expect(content).toContain('Caught up 9 issues, posted above.');
    });

    it('says plainly when nothing was missed', () => {
      const content = formatRecoveryAlert({ sinceIso: null, nowMs: NOW, postedCount: 0 });
      expect(content).toContain('No issues were missed.');
    });

    it('singularizes one issue', () => {
      const content = formatRecoveryAlert({ sinceIso: null, nowMs: NOW, postedCount: 1 });
      expect(content).toContain('Caught up 1 issue,');
    });
  });
});
