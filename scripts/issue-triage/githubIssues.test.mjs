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

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
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
  it('throws without a token so a misconfigured run fails loudly', async () => {
    await expect(fetchIssuesSince({ repo: 'a/b', since: 'x', token: '' })).rejects.toThrow(
      /read-only fine-grained PAT/,
    );
  });

  it('filters out pull requests', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([RAW_ISSUE, { ...RAW_ISSUE, number: 9, pull_request: { url: 'x' } }]),
    );
    const issues = await fetchIssuesSince({
      repo: 'futo-org/futo-notes',
      since: '1970-01-01T00:00:00Z',
      token: 'tok',
      fetchImpl,
    });
    expect(issues.map((i) => i.number)).toEqual([8]);
  });

  it('throws on a non-ok response (no silent green)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse('nope', { ok: false, status: 403 }));
    await expect(
      fetchIssuesSince({ repo: 'a/b', since: 'x', token: 'tok', fetchImpl }),
    ).rejects.toThrow(/GitHub 403/);
  });

  it('follows pagination until a short page', async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({ ...RAW_ISSUE, number: i + 1 }));
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(fullPage))
      .mockResolvedValueOnce(jsonResponse([{ ...RAW_ISSUE, number: 101 }]));
    const issues = await fetchIssuesSince({ repo: 'a/b', since: 'x', token: 'tok', fetchImpl });
    expect(issues).toHaveLength(101);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
