import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildTaskPrompt,
  createSweepWorktree,
  loadOpenCuts,
  parseSweepResult,
  rankCuts,
  runSweep,
} from './sweep.mjs';

const cut = (id, over) => ({
  kind: 'cut',
  id,
  ts: '2026-08-10T00:00:00Z',
  severity: 'minor',
  tags: ['tooling'],
  text: `t ${id}`,
  agent: 'claude-code',
  ...over,
});

describe('loadOpenCuts / rankCuts', () => {
  it('drops resolved cuts and ranks blockers, majors, then oldest', () => {
    const fake = {
      existsSync: () => true,
      readFileSync: () =>
        [
          JSON.stringify(cut('pc_000000000001', { ts: '2026-08-20T00:00:00Z' })),
          JSON.stringify(cut('pc_000000000002', { severity: 'major', ts: '2026-08-25T00:00:00Z' })),
          JSON.stringify(cut('pc_000000000003', { ts: '2026-08-01T00:00:00Z' })),
          JSON.stringify(cut('pc_000000000004', { severity: 'blocker' })),
          JSON.stringify({ kind: 'resolve', id: 'pc_000000000004', ts: '2026-08-30T00:00:00Z' }),
        ].join('\n'),
    };
    const open = loadOpenCuts('/x', fake);
    expect(open.map((c) => c.id)).toEqual([
      'pc_000000000001',
      'pc_000000000002',
      'pc_000000000003',
    ]);
    expect(rankCuts(open).map((c) => c.id)).toEqual([
      'pc_000000000002',
      'pc_000000000003',
      'pc_000000000001',
    ]);
    expect(rankCuts(open, 2)).toHaveLength(2);
  });
});

describe('buildTaskPrompt', () => {
  it('embeds the cuts as fenced JSON data and names the result file', () => {
    const prompt = buildTaskPrompt({
      cuts: [cut('pc_0123456789ab')],
      resultFile: '/s/result.json',
      branch: 'chore/papercut-sweep-1',
      runDate: '2026-09-08',
    });
    expect(prompt).toContain('```json');
    expect(prompt).toContain('pc_0123456789ab');
    expect(prompt).toContain('/s/result.json');
    expect(prompt).toContain('DATA');
  });
});

describe('parseSweepResult', () => {
  const good = {
    mrUrl: 'https://gitlab.futo.org/futo-notes/futo-notes/-/merge_requests/300',
    resolved: ['pc_0123456789ab'],
    skipped: [{ id: 'pc_ba9876543210', reason: 'needs a simulator' }],
    summary: 'did things',
  };

  it('accepts the contract and rejects every deviation', () => {
    expect(parseSweepResult(JSON.stringify(good))).toEqual(good);
    expect(parseSweepResult(JSON.stringify({ ...good, mrUrl: null, resolved: [] }))).toMatchObject({
      mrUrl: null,
    });
    expect(
      parseSweepResult(JSON.stringify({ ...good, mrUrl: 'https://evil.example/mr/1' })),
    ).toBeNull();
    expect(parseSweepResult(JSON.stringify({ ...good, mrUrl: null }))).toBeNull(); // resolves without an MR
    expect(parseSweepResult(JSON.stringify({ ...good, resolved: ['nope'] }))).toBeNull();
    expect(parseSweepResult(JSON.stringify({ ...good, skipped: ['pc_x'] }))).toBeNull();
    expect(parseSweepResult(JSON.stringify({ ...good, summary: '' }))).toBeNull();
    expect(parseSweepResult('not json')).toBeNull();
  });
});

describe('createSweepWorktree', () => {
  it('fetches origin/main and adds the worktree; rolls back on failure', () => {
    const calls = [];
    const ok = createSweepWorktree({
      runId: '20260908063000',
      stateDirectory: '/state',
      repoDirectory: '/repo',
      mkdirImpl: () => {},
      runGitImpl: (args) => calls.push(args.join(' ')),
    });
    expect(ok.branch).toBe('chore/papercut-sweep-20260908063000');
    expect(ok.worktreePath).toBe('/state/worktrees/sweep-20260908063000');
    expect(calls[0]).toBe('fetch origin main');
    expect(calls[1]).toContain('worktree add -b chore/papercut-sweep-20260908063000');

    const rollback = [];
    expect(() =>
      createSweepWorktree({
        runId: 'r',
        stateDirectory: '/state',
        repoDirectory: '/repo',
        mkdirImpl: () => {},
        runGitImpl: (args) => {
          rollback.push(args[0] + ' ' + args[1]);
          if (args[0] === 'worktree' && args[1] === 'add') throw new Error('boom');
        },
      }),
    ).toThrow('boom');
    expect(rollback).toContain('worktree remove');
    expect(rollback).toContain('branch -D');
  });
});

describe('runSweep', () => {
  let state;
  let repo;
  beforeEach(() => {
    state = mkdtempSync(join(tmpdir(), 'sweep-state-'));
    repo = mkdtempSync(join(tmpdir(), 'sweep-repo-'));
  });
  afterEach(() => {
    rmSync(state, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  it('records nothing-open and never creates a worktree when the log is clean', async () => {
    writeFileSync(join(repo, '.papercuts.jsonl'), '');
    let created = 0;
    const out = await runSweep({
      stateDirectory: state,
      repoDirectory: repo,
      dependencies: { createWorktree: () => created++ },
    });
    expect(out.status).toBe('nothing-open');
    expect(created).toBe(0);
  });

  it('writes last-run.json from the validated result and keeps the branch only when an MR was filed', async () => {
    writeFileSync(join(repo, '.papercuts.jsonl'), JSON.stringify(cut('pc_0123456789ab')) + '\n');
    const removed = [];
    const out = await runSweep({
      stateDirectory: state,
      repoDirectory: repo,
      dependencies: {
        createWorktree: () => ({ worktreePath: '/wt', branch: 'b' }),
        install: () => true,
        removeWorktree: (args) => removed.push(args),
        runAgent: async () => ({
          mrUrl: 'https://gitlab.futo.org/futo-notes/futo-notes/-/merge_requests/1',
          resolved: ['pc_0123456789ab'],
          skipped: [],
          summary: 'fixed',
        }),
      },
    });
    expect(out.status).toBe('ok');
    expect(removed[0].keepBranch).toBe(true);
    const last = JSON.parse(require('node:fs').readFileSync(join(state, 'last-run.json'), 'utf8'));
    expect(last.status).toBe('ok');
    expect(last.resolved).toEqual(['pc_0123456789ab']);
  });

  it('reports no-result (exit 1 path) when the agent produced nothing, and removes the branch', async () => {
    writeFileSync(join(repo, '.papercuts.jsonl'), JSON.stringify(cut('pc_0123456789ab')) + '\n');
    const removed = [];
    const out = await runSweep({
      stateDirectory: state,
      repoDirectory: repo,
      dependencies: {
        createWorktree: () => ({ worktreePath: '/wt', branch: 'b' }),
        install: () => true,
        removeWorktree: (args) => removed.push(args),
        runAgent: async () => null,
      },
    });
    expect(out.status).toBe('no-result');
    expect(removed[0].keepBranch).toBe(false);
  });
});
