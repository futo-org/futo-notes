import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveSigningTeam } from './ios-signing-team.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });

function writeTeam(root, team) {
  mkdirSync(join(root, 'apps', 'ios'), { recursive: true });
  writeFileSync(join(root, 'apps', 'ios', '.signing-team'), `${team}\n`);
}

describe('resolveSigningTeam', () => {
  let dir;
  let primary;
  let worktree;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'signing-team-'));
    primary = join(dir, 'primary');
    worktree = join(dir, 'wt');
    mkdirSync(primary);
    git(primary, 'init', '-q');
    git(
      primary,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'x',
    );
    git(primary, 'worktree', 'add', '-q', '-b', 'wt', worktree);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("falls back to the primary checkout's gitignored team file from a fresh worktree", () => {
    writeTeam(primary, 'PRIMARY123');
    expect(resolveSigningTeam({ root: worktree, env: {} })).toEqual({
      team: 'PRIMARY123',
      source: join(primary, 'apps', 'ios', '.signing-team'),
    });
  });

  it("prefers FUTO_DEV_TEAM, then the worktree's own file", () => {
    writeTeam(primary, 'PRIMARY123');
    writeTeam(worktree, 'WORKTREE12');
    expect(resolveSigningTeam({ root: worktree, env: {} }).team).toBe('WORKTREE12');
    expect(resolveSigningTeam({ root: worktree, env: { FUTO_DEV_TEAM: 'ENVTEAM123' } })).toEqual({
      team: 'ENVTEAM123',
      source: 'FUTO_DEV_TEAM',
    });
  });

  it('reports nothing when no checkout has a team', () => {
    expect(resolveSigningTeam({ root: worktree, env: {} })).toEqual({ team: '', source: null });
    expect(resolveSigningTeam({ root: primary, env: {} }).team).toBe('');
  });
});
