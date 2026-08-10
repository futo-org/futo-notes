import { describe, expect, it } from 'vitest';

import {
  classifyDataDir,
  classifyExecPath,
  classifyVault,
  parseWorktreeRoots,
  verifyTarget,
} from './qa-target.mjs';

// Regression coverage for 2026-08-10: a QA agent resolved a PID by matching the
// process name `futo-notes-tauri`, which EVERY build shares — including
// /Applications/FUTO Notes.app/Contents/MacOS/futo-notes-tauri, whose vault is
// the user's real, sync-connected ~/Documents/futo-notes. Real Cmd+Z keystrokes
// went to it. These tests pin the refusals that make name collision harmless:
// the resolver decides from the executable's real path, the repo's worktree
// list, and the instance's own data dir / vault — never from a name.

const HOME = '/Users/dev';
const SELF = '/repo/.claude/worktrees/mr-42';
const OTHER = '/repo/.claude/worktrees/mr-7';
const CONTEXT = { worktreeRoots: ['/repo', SELF, OTHER], selfRoot: SELF, home: HOME };

describe('parseWorktreeRoots', () => {
  it('reads every worktree path out of `git worktree list --porcelain`', () => {
    const porcelain = [
      'worktree /repo',
      'HEAD abc',
      'branch refs/heads/main',
      '',
      `worktree ${SELF}`,
      'HEAD def',
      'detached',
      '',
    ].join('\n');
    expect(parseWorktreeRoots(porcelain)).toEqual(['/repo', SELF]);
  });
});

describe('classifyExecPath', () => {
  it('REFUSES the installed production bundle — the exact process the incident hit', () => {
    const verdict = classifyExecPath(
      '/Applications/FUTO Notes.app/Contents/MacOS/futo-notes-tauri',
      CONTEXT,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe('production-bundle');
    expect(verdict.detail).toContain('Documents/futo-notes');
  });

  it('REFUSES a system-installed package build (deb/rpm /usr/bin)', () => {
    const verdict = classifyExecPath('/usr/bin/futo-notes-tauri', CONTEXT);
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe('system-install');
  });

  it('REFUSES an identically-named binary from outside the repo', () => {
    const verdict = classifyExecPath('/tmp/downloads/futo-notes-tauri', CONTEXT);
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe('outside-repo');
  });

  it('REFUSES a release-profile build even inside the worktree (release config = real vault, M3)', () => {
    const verdict = classifyExecPath(`${SELF}/target/release/futo-notes-tauri`, CONTEXT);
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe('release-profile');
  });

  it("REFUSES another worktree's debug build, and says so differently from the prod refusal", () => {
    const verdict = classifyExecPath(`${OTHER}/target/debug/futo-notes-tauri`, CONTEXT);
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe('other-worktree');
    expect(verdict.detail).toContain(OTHER);
  });

  it('REFUSES rather than guesses when the executable path is unreadable', () => {
    expect(classifyExecPath(null, CONTEXT).code).toBe('exec-path-unknown');
  });

  it("accepts this worktree's debug build", () => {
    const verdict = classifyExecPath(`${SELF}/target/debug/futo-notes-tauri`, CONTEXT);
    expect(verdict.ok).toBe(true);
    expect(verdict.owningRoot).toBe(SELF);
  });
});

describe('classifyDataDir', () => {
  it('fails closed when the instance has no FUTO_NOTES_DATA_DIR', () => {
    expect(classifyDataDir(null, CONTEXT).code).toBe('data-dir-unset');
  });

  it('refuses a data dir outside the repo', () => {
    expect(
      classifyDataDir(`${HOME}/Library/Application Support/com.futo.notes`, CONTEXT).code,
    ).toBe('data-dir-outside-repo');
  });

  it('accepts a per-worktree data dir', () => {
    expect(classifyDataDir(`${SELF}/.tauri-data`, CONTEXT).ok).toBe(true);
  });
});

describe('classifyVault', () => {
  it("REFUSES the user's real vault", () => {
    const verdict = classifyVault(`${HOME}/Documents/futo-notes`, CONTEXT);
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe('production-vault');
  });

  it('REFUSES a note directory nested inside the real vault', () => {
    expect(classifyVault(`${HOME}/Documents/futo-notes/Projects`, CONTEXT).ok).toBe(false);
  });

  it('warns without refusing for the machine-global dev vault', () => {
    const verdict = classifyVault(`${HOME}/Documents/fake-notes`, CONTEXT);
    expect(verdict.ok).toBe(true);
    expect(verdict.warning).toContain('shared with every other session');
  });

  it('is silent for a vault inside the worktree', () => {
    const verdict = classifyVault(`${SELF}/.tauri-data/notes`, CONTEXT);
    expect(verdict.ok).toBe(true);
    expect(verdict.warning).toBeNull();
  });
});

describe('verifyTarget', () => {
  it('refuses the production app and names the real vault in its reasons', () => {
    const result = verifyTarget(
      {
        pid: 4321,
        execPath: '/Applications/FUTO Notes.app/Contents/MacOS/futo-notes-tauri',
        dataDir: null,
        notesDir: `${HOME}/Documents/futo-notes`,
      },
      CONTEXT,
    );
    expect(result.verdict).toBe('REFUSED');
    expect(result.refusals.map((refusal) => refusal.code)).toEqual([
      'production-bundle',
      'production-vault',
    ]);
  });

  it("verifies this worktree's isolated debug instance", () => {
    const result = verifyTarget(
      {
        pid: 1234,
        execPath: `${SELF}/target/debug/futo-notes-tauri`,
        dataDir: `${SELF}/.tauri-data`,
        notesDir: `${SELF}/.tauri-data/notes`,
      },
      CONTEXT,
    );
    expect(result).toMatchObject({ verdict: 'verified', refusals: [], warnings: [] });
  });

  it('refuses a worktree debug build whose data dir was never isolated', () => {
    const result = verifyTarget(
      {
        pid: 1234,
        execPath: `${SELF}/target/debug/futo-notes-tauri`,
        dataDir: null,
        notesDir: null,
      },
      CONTEXT,
    );
    expect(result.verdict).toBe('REFUSED');
    expect(result.refusals[0].code).toBe('data-dir-unset');
  });
});
