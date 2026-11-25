import { describe, expect, it } from 'vitest';

import {
  exitCodeFor,
  findPipeline,
  formatMrLine,
  formatResult,
  makeApi,
  parseTarget,
  resolveToken,
  summarizeJobs,
  tailLines,
  waitForPipeline,
} from './ci-wait.mjs';

describe('parseTarget', () => {
  it('tells a sha and a branch apart, and rejects an MR (MRs get no pipeline)', () => {
    expect(parseTarget('mr:291')).toBeNull();
    expect(parseTarget('!291')).toBeNull();
    expect(parseTarget('6d59965d')).toEqual({ kind: 'sha', sha: '6d59965d' });
    expect(parseTarget('chore/agent-dx')).toEqual({ kind: 'ref', ref: 'chore/agent-dx' });
    expect(parseTarget(undefined)).toBeNull();
  });
});

describe('pipeline ID targets', () => {
  it('accepts bare and explicit IDs, while allowing numeric refs and SHAs explicitly', () => {
    expect(parseTarget('42345')).toEqual({ kind: 'pipeline', id: 42345 });
    expect(parseTarget('pipeline:42345')).toEqual({ kind: 'pipeline', id: 42345 });
    expect(parseTarget('12345678')).toEqual({ kind: 'pipeline', id: 12345678 });
    expect(parseTarget('ref:12345678')).toEqual({ kind: 'ref', ref: '12345678' });
    expect(parseTarget('sha:12345678')).toEqual({ kind: 'sha', sha: '12345678' });
  });

  it('fetches the exact pipeline instead of searching refs', async () => {
    const api = fakeApi([['/pipelines/42345', [{ id: 42345, status: 'success' }]]]);
    expect(await findPipeline(parseTarget('42345'), api)).toEqual({ id: 42345, status: 'success' });
    expect(api.calls).toEqual(['/pipelines/42345']);
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
      // Bridges are a second listing; tests that don't script one have none.
      if (p.includes('/bridges') && !script.some(([k]) => k.includes('/bridges'))) return [];
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

  it('stops at the first blocking failure while the pipeline is still running', async () => {
    const api = fakeApi([
      [
        '/pipelines/9/jobs',
        [
          [
            { id: 1, name: 'build:windows', status: 'failed', allow_failure: false },
            { id: 2, name: 'test:puppet-gates', status: 'failed', allow_failure: true },
            { id: 3, name: 'publish:ios:appstore', status: 'running' },
          ],
        ],
      ],
      ['/pipelines/9', [{ id: 9, status: 'running', web_url: 'u' }]],
    ]);
    const sleeps = [];
    const result = await waitForPipeline(
      { kind: 'pipeline', id: 9 },
      {
        api,
        sleep: async (ms) => sleeps.push(ms),
        timeoutMs: 60_000,
        intervalMs: 5,
        log: () => {},
      },
    );
    expect(sleeps).toEqual([]);
    expect(result.failFast).toBe(true);
    expect(result.status).toBe('running');
    expect(result.failed.map((j) => j.name)).toEqual(['build:windows']);
    expect(result.failed[0].traceTail).toContain('ERROR: boom');
    expect(formatResult(result)).toContain('stopped at the first blocking failure');
  });

  it('keeps waiting past an allowed failure, and past a blocking one with waitAll', async () => {
    const allowed = [{ id: 2, name: 'gates', status: 'failed', allow_failure: true }];
    const blocking = [{ id: 1, name: 'build', status: 'failed', allow_failure: false }];
    for (const [jobs, opts] of [
      [allowed, {}],
      [blocking, { waitAll: true }],
    ]) {
      const api = fakeApi([
        ['/pipelines/5/jobs', [jobs]],
        [
          '/pipelines/5',
          [
            { id: 5, status: 'running' },
            { id: 5, status: 'failed' },
          ],
        ],
      ]);
      const result = await waitForPipeline(
        { kind: 'pipeline', id: 5 },
        { api, sleep: async () => {}, timeoutMs: 60_000, intervalMs: 1, log: () => {}, ...opts },
      );
      expect(result.failFast).toBe(false);
      expect(result.status).toBe('failed');
    }
  });

  it('retries API blips instead of dying, but gives up on auth errors', async () => {
    let calls = 0;
    const flaky = fakeApi([
      ['/pipelines/3/jobs', [[{ id: 1, name: 'a', status: 'success' }]]],
      [
        '/pipelines/3',
        [
          () => {
            if (++calls <= 2) throw new Error('GitLab API 502 for /pipelines/3');
            return { id: 3, status: 'success' };
          },
        ],
      ],
    ]);
    const logs = [];
    const result = await waitForPipeline(
      { kind: 'pipeline', id: 3 },
      {
        api: flaky,
        sleep: async () => {},
        timeoutMs: 60_000,
        intervalMs: 1,
        log: (l) => logs.push(l),
      },
    );
    expect(result.status).toBe('success');
    expect(logs.filter((l) => l.includes('retrying'))).toHaveLength(2);

    const denied = Object.assign(new Error('GitLab API 403'), { fatal: true });
    const auth = fakeApi([
      [
        '/pipelines/4',
        [
          () => {
            throw denied;
          },
        ],
      ],
    ]);
    await expect(
      waitForPipeline(
        { kind: 'pipeline', id: 4 },
        { api: auth, sleep: async () => {}, timeoutMs: 60_000, intervalMs: 1, log: () => {} },
      ),
    ).rejects.toThrow('403');
  });

  it('exits on a blocking failure even when the pipeline reports success', async () => {
    const api = fakeApi([
      ['/pipelines/6/jobs', [[{ id: 1, name: 'late', status: 'failed', allow_failure: false }]]],
      ['/pipelines/6', [{ id: 6, status: 'success' }]],
    ]);
    const result = await waitForPipeline(
      { kind: 'pipeline', id: 6 },
      { api, sleep: async () => {}, timeoutMs: 60_000, intervalMs: 1, log: () => {} },
    );
    expect(result.failed.map((j) => j.name)).toEqual(['late']);
  });

  it('keeps a failure from page 1 when page 2 errors, and watches trigger jobs', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: i,
      name: `j${i}`,
      status: i === 0 ? 'failed' : 'running',
      allow_failure: false,
    }));
    const api = fakeApi([
      ['/pipelines/2/jobs?per_page=100&page=1', [page1]],
      [
        '/pipelines/2/jobs?per_page=100&page=2',
        [
          () => {
            throw new Error('GitLab API 502');
          },
        ],
      ],
      ['/pipelines/2', [{ id: 2, status: 'running' }]],
    ]);
    const result = await waitForPipeline(
      { kind: 'pipeline', id: 2 },
      {
        api,
        sleep: async () => {},
        timeoutMs: 60_000,
        intervalMs: 1,
        log: () => {},
        withTrace: false,
      },
    );
    expect(result.failFast).toBe(true);
    expect(result.failed.map((j) => j.name)).toEqual(['j0']);

    const bridged = fakeApi([
      ['/pipelines/1/jobs', [[{ id: 1, name: 'build', status: 'running' }]]],
      [
        '/pipelines/1/bridges',
        [[{ id: 2, name: 'pkg:trigger', status: 'failed', allow_failure: false }]],
      ],
      ['/pipelines/1', [{ id: 1, status: 'running' }]],
    ]);
    const viaBridge = await waitForPipeline(
      { kind: 'pipeline', id: 1 },
      { api: bridged, sleep: async () => {}, timeoutMs: 60_000, intervalMs: 1, log: () => {} },
    );
    expect(viaBridge.failed.map((j) => j.name)).toEqual(['pkg:trigger']);
  });

  it('honours the timeout while retrying API errors', async () => {
    let t = 0;
    const api = fakeApi([
      [
        '/pipelines/4',
        [
          () => {
            throw new Error('GitLab API 502');
          },
        ],
      ],
    ]);
    const result = await waitForPipeline(
      { kind: 'pipeline', id: 4 },
      {
        api,
        sleep: async (ms) => {
          t += ms;
        },
        now: () => t,
        timeoutMs: 1_000,
        intervalMs: 600,
        log: () => {},
        maxApiErrors: 100,
      },
    );
    expect(result.timedOut).toBe(true);
    expect(t).toBeLessThan(5_000);
  });

  it('reads every page of jobs', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: i,
      name: `j${i}`,
      status: 'success',
    }));
    const api = fakeApi([
      ['/pipelines/8/jobs?per_page=100&page=1', [page1]],
      ['/pipelines/8/jobs?per_page=100&page=2', [[{ id: 100, name: 'late', status: 'success' }]]],
      ['/pipelines/8', [{ id: 8, status: 'success' }]],
    ]);
    const result = await waitForPipeline(
      { kind: 'pipeline', id: 8 },
      { api, sleep: async () => {}, timeoutMs: 60_000, intervalMs: 1, log: () => {} },
    );
    expect(result.jobs).toHaveLength(101);
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
  it('shows draft state and conflicts on one line', () => {
    const line = formatMrLine({
      iid: 290,
      draft: false,
      created_at: '2026-09-04T18:00:00Z',
      source_branch: 'chore/repo-fat-audit',
      title: 'chore(repo): trim historical docs and agent scaffolding',
      has_conflicts: true,
    });
    expect(line).toMatch(/^!290\s+ready\s+2026-09-04\s+chore\/repo-fat-audit/);
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

describe('resolveToken', () => {
  it('prefers the environment without reading glab credentials', () => {
    expect(
      resolveToken({
        env: { GITLAB_TOKEN: 'env-secret' },
        run: () => {
          throw new Error('must not run');
        },
      }),
    ).toBe('env-secret');
  });

  it('captures a configured glab token without forwarding credential output', () => {
    const calls = [];
    expect(
      resolveToken({
        env: {},
        run: (...args) => {
          calls.push(args);
          return { status: 0, stdout: 'configured-secret\n' };
        },
      }),
    ).toBe('configured-secret');
    expect(calls).toEqual([
      [
        'glab',
        ['config', 'get', 'token', '--host', 'gitlab.futo.org'],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      ],
    ]);
  });

  it.each([
    { status: 1, stderr: 'sensitive diagnostic', stdout: 'do-not-use' },
    { status: null, error: new Error('ENOENT') },
    { status: 0, stdout: '  \n' },
  ])('reports a safe repair hint if glab has no usable credential', (result) => {
    expect(() => resolveToken({ env: {}, run: () => result })).toThrow(
      'Set GITLAB_TOKEN (read_api scope) or run glab auth login --hostname gitlab.futo.org',
    );
    expect(() => resolveToken({ env: {}, run: () => result })).not.toThrow(/sensitive|do-not-use/);
  });
});
