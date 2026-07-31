import { afterEach, describe, expect, it, vi } from 'vitest';

import { formatAlert, postAlert, topicForIssue } from './zulipAlerts.mjs';

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
  afterEach(() => {
    delete process.env.ZULIP_TRIAGE_BOT_EMAIL;
    delete process.env.ZULIP_TRIAGE_BOT_KEY;
  });

  it('throws when credentials are absent', async () => {
    await expect(postAlert({ topic: 't', content: 'c' })).rejects.toThrow(/ZULIP_TRIAGE_BOT/);
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
