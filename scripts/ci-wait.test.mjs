import { describe, expect, it } from 'vitest';

import {
  exitCodeFor,
  findPipeline,
  formatMrLine,
  formatResult,
  makeApi,
  parseTarget,
  summarizeJobs,
  tailLines,
  waitForPipeline,
} from './ci-wait.mjs';

describe('parseTarget', () => {
  it('tells an MR, a sha, and a branch apart', () => {
    expect(parseTarget('mr:291')).toEqual({ kind: 'mr', iid: 291 });
    expect(parseTarget('!291')).toEqual({ kind: 'mr', iid: 291 });
    expect(parseTarget('6d59965d')).toEqual({ kind: 'sha', sha: '6d59965d' });
    expect(parseTarget('chore/agent-dx')).toEqual({ kind: 'ref', ref: 'chore/agent-dx' });
    expect(parseTarget(undefined)).toBeNull();
  });
});

describe('exitCodeFor', () => {
  it('is 0 only for success, 1 for every other terminal state, 2 otherwise', () => {
    expect(exitCodeFor('success')).toBe(0);
    for (const s of ['failed', 'canceled', 'skipped', 'manual']) expect(exitCodeFor(s)).toBe(1);
    expect(exitCodeFor('running')).toBe(2);
  });
});

describe('summarizeJobs / tailLines', () => {
  it('counts done jobs and lists only failures that were not allowed to fail', () => {
    const sum = summarizeJobs([
      { name: 'a', status: 'success' },
      { name: 'b', status: 'failed', allow_failure: true },
      { name: 'c', status: 'failed', allow_failure: false },
      { name: 'd', status: 'running' },
    ]);
    expect(sum.done).toBe(3);
    expect(sum.total).toBe(4);
    expect(sum.failed.map((j) => j.name)).toEqual(['c']);
  });

  it('keeps the last N lines and drops trailing blanks and CRs', () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i}\r`).join('\n') + '\n\n';
    const tail = tailLines(text, 3).split('\n');
    expect(tail).toEqual(['line 47', 'line 48', 'line 49']);
  });
});

function fakeApi(script) {
  // script: ordered responses keyed by path prefix
  const calls = [];
  return {
    calls,
    async json(p) {
      calls.push(p);
      for (const [prefix, responses] of script) {
        if (p.startsWith(prefix)) {
          const r = responses.length > 1 ? responses.shift() : responses[0];
          return typeof r === 'function' ? r() : r;
        }
      }
      throw new Error(`unexpected ${p}`);
    },
    async text(p) {
      calls.push(p);
      return 'l1\nl2\nERROR: boom\n';
    },
  };
}

describe('findPipeline', () => {
  it('uses the MR head pipeline, falling back to the MR pipelines list', async () => {
    const api = fakeApi([
      ['/merge_requests/5/pipelines', [[{ id: 9, status: 'running' }]]],
      ['/merge_requests/5', [{ iid: 5, head_pipeline: null }]],
    ]);
    expect(await findPipeline({ kind: 'mr', iid: 5 }, api)).toEqual({ id: 9, status: 'running' });
  });

  it('queries by sha and by ref', async () => {
    const api = fakeApi([['/pipelines?', [[{ id: 1 }]]]]);
    await findPipeline({ kind: 'sha', sha: 'abc1234' }, api);
    await findPipeline({ kind: 'ref', ref: 'feat/x y' }, api);
    expect(api.calls[0]).toContain('sha=abc1234');
    expect(api.calls[1]).toContain('ref=feat%2Fx%20y');
  });
});

describe('waitForPipeline', () => {
  const jobsRunning = [{ id: 1, name: 'test', status: 'running' }];
  const jobsDone = [
    { id: 1, name: 'test', status: 'failed', allow_failure: false, duration: 61 },
    { id: 2, name: 'lint', status: 'success', duration: 10 },
  ];

  it('polls until terminal, then fetches traces for the real failures', async () => {
    const api = fakeApi([
      ['/pipelines?', [[{ id: 42, status: 'running' }]]],
      ['/pipelines/42/jobs', [jobsRunning, jobsDone]],
      [
        '/pipelines/42',
        [
          { id: 42, status: 'running', web_url: 'u' },
          { id: 42, status: 'failed', web_url: 'u' },
        ],
      ],
    ]);
    const sleeps = [];
    const result = await waitForPipeline(
      { kind: 'sha', sha: 'abc1234' },
      {
        api,
        sleep: async (ms) => sleeps.push(ms),
        timeoutMs: 60_000,
        intervalMs: 5,
        log: () => {},
      },
    );
    expect(result.status).toBe('failed');
    expect(result.timedOut).toBe(false);
    expect(sleeps).toEqual([5]);
    expect(result.failed.map((j) => j.name)).toEqual(['test']);
    expect(result.failed[0].traceTail).toContain('ERROR: boom');
    const text = formatResult(result);
    expect(text).toContain('pipeline 42 failed');
    expect(text).toContain('--- test (job 1) last lines ---');
  });

  it('reports a timeout instead of looping forever', async () => {
    let t = 0;
    const api = fakeApi([
      ['/pipelines?', [[{ id: 7, status: 'running' }]]],
      ['/pipelines/7/jobs', [jobsRunning]],
      ['/pipelines/7', [{ id: 7, status: 'running' }]],
    ]);
    const result = await waitForPipeline(
      { kind: 'ref', ref: 'main' },
      {
        api,
        sleep: async () => {},
        now: () => (t += 30_000),
        timeoutMs: 45_000,
        intervalMs: 1,
        log: () => {},
      },
    );
    expect(result.timedOut).toBe(true);
    expect(result.status).toBe('running');
  });

  it('gives up when no pipeline appears within the grace period', async () => {
    let t = 0;
    const api = fakeApi([['/pipelines?', [[]]]]);
    const result = await waitForPipeline(
      { kind: 'sha', sha: 'deadbeef' },
      {
        api,
        sleep: async () => {},
        now: () => (t += 61_000),
        timeoutMs: 600_000,
        intervalMs: 1,
        log: () => {},
      },
    );
    expect(result.pipeline).toBeNull();
    expect(result.status).toBe('not-found');
  });
});

describe('formatMrLine', () => {
  it('shows draft state, head pipeline, and conflicts on one line', () => {
    const line = formatMrLine({
      iid: 290,
      draft: false,
      head_pipeline: { status: 'success' },
      created_at: '2026-09-04T18:00:00Z',
      source_branch: 'chore/repo-fat-audit',
      title: 'chore(repo): trim historical docs and agent scaffolding',
      has_conflicts: true,
    });
    expect(line).toMatch(/^!290\s+ready\s+success\s+2026-09-04\s+chore\/repo-fat-audit/);
    expect(line).toContain('CONFLICTS');
  });
});

describe('makeApi', () => {
  it('sends the token and turns 403 into an actionable error', async () => {
    const seen = [];
    const api = makeApi('tok', async (url, init) => {
      seen.push([url, init.headers]);
      return { ok: false, status: 403 };
    });
    await expect(api.json('/pipelines')).rejects.toThrow(/GITLAB_TOKEN/);
    expect(seen[0][0]).toBe(
      'https://gitlab.futo.org/api/v4/projects/futo-notes%2Ffuto-notes/pipelines',
    );
    expect(seen[0][1]['PRIVATE-TOKEN']).toBe('tok');
  });
});
