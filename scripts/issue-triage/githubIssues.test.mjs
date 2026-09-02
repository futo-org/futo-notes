import { describe, expect, it, vi } from 'vitest';

import { convertIssue, fetchIssuesSince } from './githubIssues.mjs';

const RAW_ISSUE = {
  number: 8,
  title: 'Black text in dark mode',
  body: 'steps to reproduce',
  user: { login: 'decloyd' },
  state: 'open',
  created_at: '2026-07-23T04:22:28Z',
  updated_at: '2026-07-23T04:36:27Z',
  html_url: 'https://github.com/futo-org/futo-notes/issues/8',
};

function jsonResponse(body, { ok = true, status = 200, headers = {} } = {}) {
  return {
    ok,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('convertIssue', () => {
  it('normalizes a raw issue to the poller shape', () => {
    expect(convertIssue(RAW_ISSUE)).toEqual({
      number: 8,
      title: 'Black text in dark mode',
      body: 'steps to reproduce',
      author: 'decloyd',
      state: 'open',
      createdAt: '2026-07-23T04:22:28Z',
      updatedAt: '2026-07-23T04:36:27Z',
      url: 'https://github.com/futo-org/futo-notes/issues/8',
    });
  });

  it('defaults missing title, body, and author', () => {
    const result = convertIssue({ number: 1, created_at: 'x', updated_at: 'x', html_url: 'u' });
    expect(result).toMatchObject({ title: '', body: '', author: 'unknown' });
  });
});

describe('fetchIssuesSince', () => {
  // The public mirror needs no credential, and sending none is what makes "the
  // bot never writes to GitHub" independent of a token's scope — and unable to
  // expire, which is how 11 days of 401s happened.
  it('sends no Authorization header', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([RAW_ISSUE]));
    await fetchIssuesSince({ repo: 'a/b', since: 'x', fetchImpl });

    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers).not.toHaveProperty('Authorization');
    expect(Object.keys(init.headers).map((k) => k.toLowerCase())).not.toContain('authorization');
  });

  it('does not send a token even when one is passed in', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([RAW_ISSUE]));
    await fetchIssuesSince({ repo: 'a/b', since: 'x', token: 'leftover', fetchImpl });

    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.stringify(init)).not.toContain('leftover');
  });

  it('filters out pull requests', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([RAW_ISSUE, { ...RAW_ISSUE, number: 9, pull_request: { url: 'x' } }]),
    );
    const issues = await fetchIssuesSince({
      repo: 'futo-org/futo-notes',
      since: '1970-01-01T00:00:00Z',
      fetchImpl,
    });
    expect(issues.map((i) => i.number)).toEqual([8]);
  });

  it('throws on a non-ok response (no silent green)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse('nope', { ok: false, status: 403 }));
    await expect(fetchIssuesSince({ repo: 'a/b', since: 'x', fetchImpl })).rejects.toThrow(
      /GitHub 403/,
    );
  });

  // Without the budget in the message, an exhausted anonymous quota reads as a
  // broken credential — and there is no credential any more.
  it('names the rate limit and its reset when the anonymous budget is spent', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse('rate limited', {
        ok: false,
        status: 403,
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1789000000' },
      }),
    );
    await expect(fetchIssuesSince({ repo: 'a/b', since: 'x', fetchImpl })).rejects.toThrow(
      /rate limit exhausted, resets 2026-09-10T/,
    );
  });

  it('does not blame the rate limit for a 403 with budget remaining', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse('blocked', {
        ok: false,
        status: 403,
        headers: { 'x-ratelimit-remaining': '57' },
      }),
    );
    await expect(fetchIssuesSince({ repo: 'a/b', since: 'x', fetchImpl })).rejects.toThrow(
      /GitHub 403 on \/repos\/a\/b\/issues: /,
    );
  });

  it('follows pagination until a short page', async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({ ...RAW_ISSUE, number: i + 1 }));
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(fullPage))
      .mockResolvedValueOnce(jsonResponse([{ ...RAW_ISSUE, number: 101 }]));
    const issues = await fetchIssuesSince({ repo: 'a/b', since: 'x', fetchImpl });
    expect(issues).toHaveLength(101);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
