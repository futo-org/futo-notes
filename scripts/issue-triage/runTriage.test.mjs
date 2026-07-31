import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildAgentEnv,
  formatOutcome,
  parseTriageResult,
  repoDir,
  runAgent,
  runTriage,
  selectIssue,
} from './runTriage.mjs';
import { loadState, saveState } from './triageState.mjs';

const VALID_RESULT = {
  outcome: 'reproduced_fixed',
  platform: 'android',
  mrUrl: 'https://gitlab.futo.org/futo-notes/futo-notes/-/merge_requests/99',
  highStakes: false,
  summary: 'Fixed the dark-mode text color.',
  attemptedSteps: 'android emulator, assembleDebug',
};

describe('repoDir', () => {
  it('defaults to the repository containing the launcher', () => {
    expect(repoDir({})).toBe(resolve(import.meta.dirname, '..', '..'));
  });

  it('honors an explicit repository override', () => {
    expect(repoDir({ FUTO_TRIAGE_REPO_DIR: '/srv/futo-notes' })).toBe('/srv/futo-notes');
  });
});

describe('buildAgentEnv', () => {
  it('passes only task-required credentials and safe toolchain configuration', () => {
    const env = buildAgentEnv(
      {
        PATH: '/bin',
        HOME: '/home/operator',
        GITLAB_TOKEN: 'gitlab-token',
        ANTHROPIC_API_KEY: 'claude-token',
        SSH_AUTH_SOCK: '/tmp/agent.sock',
        GITHUB_PAT: 'github-token',
        ZULIP_TRIAGE_BOT_KEY: 'zulip-token',
        AWS_SECRET_ACCESS_KEY: 'cloud-token',
        RANDOM_UNRELATED_SECRET: 'host-secret',
      },
      { dataDir: '/tmp/notes', resultFile: '/tmp/result.json' },
    );

    expect(env).toMatchObject({
      PATH: '/bin',
      HOME: '/home/operator',
      GITLAB_TOKEN: 'gitlab-token',
      ANTHROPIC_API_KEY: 'claude-token',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      FUTO_NOTES_DATA_DIR: '/tmp/notes',
      TRIAGE_RESULT_FILE: '/tmp/result.json',
    });
    expect(env).not.toHaveProperty('GITHUB_PAT');
    expect(env).not.toHaveProperty('ZULIP_TRIAGE_BOT_KEY');
    expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(env).not.toHaveProperty('RANDOM_UNRELATED_SECRET');
  });
});

describe('parseTriageResult', () => {
  it('accepts a valid fixed result with a GitLab MR URL', () => {
    expect(parseTriageResult(JSON.stringify(VALID_RESULT))).toEqual(VALID_RESULT);
  });

  it('rejects reproduced_fixed without a valid GitLab MR URL', () => {
    expect(parseTriageResult(JSON.stringify({ ...VALID_RESULT, mrUrl: null }))).toBeNull();
    expect(
      parseTriageResult(JSON.stringify({ ...VALID_RESULT, mrUrl: 'https://example.com/mr/99' })),
    ).toBeNull();
  });

  it('rejects an MR URL for any outcome that did not report a fix', () => {
    expect(
      parseTriageResult(
        JSON.stringify({
          ...VALID_RESULT,
          outcome: 'not_reproduced',
        }),
      ),
    ).toBeNull();
  });

  it('rejects unknown outcomes and malformed contract fields', () => {
    expect(parseTriageResult(JSON.stringify({ ...VALID_RESULT, outcome: 'surprise' }))).toBeNull();
    expect(parseTriageResult(JSON.stringify({ ...VALID_RESULT, highStakes: 'yes' }))).toBeNull();
    expect(parseTriageResult('{not json')).toBeNull();
  });
});

describe('runAgent', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'triage-agent-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('treats a child-process spawn error as a missing result', async () => {
    const child = new EventEmitter();
    child.kill = () => {};
    const result = runAgent({
      worktreePath: dir,
      dataDir: join(dir, 'notes'),
      resultFile: join(dir, 'result.json'),
      number: '8',
      entry: { title: 'Dark mode', url: 'https://github.com/futo-org/futo-notes/issues/8' },
      spawnImpl: () => {
        queueMicrotask(() => child.emit('error', new Error('claude executable missing')));
        return child;
      },
      timeoutMs: 100,
    });

    await expect(result).resolves.toBeNull();
  });

  it('terminates a timed-out child and treats it as a missing result', async () => {
    const child = new EventEmitter();
    const signals = [];
    child.kill = (signal) => {
      signals.push(signal);
      if (signal === 'SIGTERM') queueMicrotask(() => child.emit('exit', null, signal));
    };

    await expect(
      runAgent({
        worktreePath: dir,
        dataDir: join(dir, 'notes'),
        resultFile: join(dir, 'result.json'),
        number: '8',
        entry: { title: 'Dark mode', url: 'https://github.com/futo-org/futo-notes/issues/8' },
        spawnImpl: () => child,
        timeoutMs: 1,
      }),
    ).resolves.toBeNull();
    expect(signals).toEqual(['SIGTERM']);
  });
});

describe('runTriage lifecycle', () => {
  let dir;
  let cleaned;
  let cleanupKeepBranch;
  let postedContent;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'triage-run-'));
    cleaned = false;
    cleanupKeepBranch = undefined;
    postedContent = undefined;
    saveState(
      {
        watermark: '2026-07-23T04:36:27Z',
        issues: {
          8: {
            status: 'queued',
            classifiedAs: 'bug',
            title: 'Dark mode is broken',
            url: 'https://github.com/futo-org/futo-notes/issues/8',
            author: 'reporter',
            zulipTopic: 'gh#8: Dark mode is broken',
            mrUrl: null,
          },
        },
      },
      dir,
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function dependencies(overrides = {}) {
    return {
      createWorktree: () => ({
        worktreePath: join(dir, 'worktree'),
        dataDir: join(dir, 'worktree', 'notes'),
        branch: 'triage/gh-8-test',
      }),
      cleanupWorktree: ({ keepBranch }) => {
        cleaned = true;
        cleanupKeepBranch = keepBranch;
      },
      postAlert: async ({ content }) => {
        postedContent = content;
      },
      now: () => new Date('2026-07-31T12:00:00Z'),
      ...overrides,
    };
  }

  it('reports needs_human and cleans up when the agent launcher throws', async () => {
    await expect(
      runTriage({
        explicitNumber: '8',
        dryRun: false,
        stateDirectory: dir,
        dependencies: dependencies({
          runAgent: async () => {
            throw new Error('spawn failed');
          },
        }),
      }),
    ).resolves.toBeUndefined();

    expect(loadState(dir).issues['8'].status).toBe('needs_human');
    expect(postedContent).toContain('needs a human');
    expect(cleaned).toBe(true);
    expect(cleanupKeepBranch).toBe(false);
  });

  it('leaves a retryable state and cleans up when the Zulip follow-up fails', async () => {
    await expect(
      runTriage({
        explicitNumber: '8',
        dryRun: false,
        stateDirectory: dir,
        dependencies: dependencies({
          runAgent: async () => VALID_RESULT,
          postAlert: async () => {
            throw new Error('Zulip unavailable');
          },
        }),
      }),
    ).rejects.toThrow(/Zulip unavailable/);

    expect(loadState(dir).issues['8']).toMatchObject({
      status: 'needs_human',
      mrUrl: VALID_RESULT.mrUrl,
    });
    expect(cleaned).toBe(true);
    expect(cleanupKeepBranch).toBe(true);
  });

  it('preserves a poller update made while tier 2 starts reproducing', async () => {
    await runTriage({
      explicitNumber: '8',
      dryRun: false,
      stateDirectory: dir,
      dependencies: dependencies({
        createWorktree: () => {
          const current = loadState(dir);
          current.issues['9'] = { status: 'queued', classifiedAs: 'bug' };
          saveState(current, dir);
          return {
            worktreePath: join(dir, 'worktree'),
            dataDir: join(dir, 'worktree', 'notes'),
            branch: 'triage/gh-8-test',
          };
        },
        runAgent: async () => null,
      }),
    });

    expect(loadState(dir).issues['9']).toEqual({ status: 'queued', classifiedAs: 'bug' });
  });
});

describe('selectIssue', () => {
  const state = {
    issues: {
      3: { status: 'posted', classifiedAs: 'feature' },
      8: { status: 'queued', classifiedAs: 'bug' },
      12: { status: 'queued', classifiedAs: 'bug' },
    },
  };

  it('picks the oldest queued bug by number', () => {
    expect(selectIssue(state)?.number).toBe('8');
  });

  it('returns null when nothing is queued', () => {
    expect(selectIssue({ issues: { 3: { status: 'posted' } } })).toBeNull();
  });

  it('honors an explicit issue number', () => {
    expect(selectIssue(state, '12')?.number).toBe('12');
  });

  it('throws for an unknown explicit issue', () => {
    expect(() => selectIssue(state, '999')).toThrow(/not in the triage state/);
  });
});

describe('formatOutcome', () => {
  it('reports needs_human when the agent produced no result', () => {
    const content = formatOutcome({ number: '8', result: null });
    expect(content).toContain('needs a human');
    expect(content).toContain('gh#8');
  });

  it('surfaces the MR link and high-stakes warning on a fix', () => {
    const content = formatOutcome({
      number: '8',
      result: {
        outcome: 'reproduced_fixed',
        platform: 'android',
        mrUrl: 'https://gitlab.futo.org/futo-notes/futo-notes/-/merge_requests/99',
        highStakes: true,
        summary: 'Fixed the dark-mode text color.',
        attemptedSteps: 'android emulator, assembleDebug',
      },
    });
    expect(content).toContain('Reproduced and fixed');
    expect(content).toContain('merge_requests/99');
    expect(content).toContain('High-stakes');
    expect(content).toContain('Fixed the dark-mode text color.');
  });

  it('falls back to needs_human for an unknown outcome value', () => {
    const content = formatOutcome({ number: '8', result: { outcome: 'weird', summary: 'x' } });
    expect(content).toContain('Needs a human');
  });
});
