import { describe, expect, it } from 'vitest';

import {
  classifyDataDir,
  classifyExecPath,
  classifyVault,
  documentsDirFromUserDirs,
  isDesktopExecutableName,
  parseNetstatListener,
  parseTasklist,
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
const CONTEXT = {
  worktreeRoots: ['/repo', SELF, OTHER],
  selfRoot: SELF,
  home: HOME,
  releaseVault: `${HOME}/Documents/futo-notes`,
};

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

describe('isDesktopExecutableName', () => {
  it('enumerates the cargo bin name and the branch-named tauri-dev link', () => {
    expect(isDesktopExecutableName('futo-notes-tauri')).toBe(true);
    expect(isDesktopExecutableName('FUTO Notes (Dev) · claude:dev-app-names')).toBe(true);
    expect(isDesktopExecutableName('FUTO Notes')).toBe(false);
  });

  it('only makes a candidate — a branch-named link is still judged by its path', () => {
    const name = 'FUTO Notes (Dev) · claude:dev-app-names';
    expect(classifyExecPath(`${SELF}/target/debug/${name}`, CONTEXT).ok).toBe(true);
    expect(classifyExecPath(`${OTHER}/target/debug/${name}`, CONTEXT).code).toBe('other-worktree');
    expect(classifyExecPath(`/Applications/${name}`, CONTEXT).code).toBe('production-bundle');
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

  it('REFUSES a relative exec path — the false-ACCEPT this tool must never make', () => {
    // Observed live: mr-208 launched its instance as
    // `./target/debug/futo-notes-tauri`, and resolving that against the
    // RESOLVER's cwd made a sibling worktree's process verify as this
    // worktree's own. A wrong "REFUSED" costs a minute; a wrong "verified" is
    // how the incident happened.
    const verdict = classifyExecPath('./target/debug/futo-notes-tauri', CONTEXT);
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe('exec-path-not-absolute');
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

  it('reports an unreadable environment as its own reason, not as "unset"', () => {
    // Saying "this process has no FUTO_NOTES_DATA_DIR" when we merely could not
    // read its environment is the same class of false statement as the
    // -newermt all-clear that started this.
    const verdict = classifyDataDir(null, { ...CONTEXT, envReadable: false });
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe('env-unreadable');
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

  // The release app's vault is in the OS Documents folder, which XDG can localize.
  it('REFUSES the real vault in a Documents folder elsewhere, inside it or around it', () => {
    const context = { ...CONTEXT, releaseVault: `${HOME}/Dokumente/futo-notes` };
    for (const notesDir of [
      `${HOME}/Dokumente/futo-notes/Projects`,
      `${HOME}/Dokumente`,
      `${HOME}/Documents/futo-notes`,
    ]) {
      expect(classifyVault(notesDir, context).code, notesDir).toBe('production-vault');
    }
  });

  it('REFUSES every vault when where the release vault lives could not be read', () => {
    expect(
      classifyVault(`${SELF}/.tauri-data/notes`, { ...CONTEXT, releaseVault: null }).code,
    ).toBe('release-vault-unknown');
  });
});

describe('documentsDirFromUserDirs', () => {
  it('reads XDG_DOCUMENTS_DIR as the app does, home-relative or absolute', () => {
    const userDirs = (value) =>
      `# written by xdg-user-dirs-update\nXDG_DESKTOP_DIR="$HOME/Desktop"\nXDG_DOCUMENTS_DIR=${value}\n`;
    expect(documentsDirFromUserDirs(userDirs('"$HOME/Dokumente"'), HOME)).toBe(`${HOME}/Dokumente`);
    expect(documentsDirFromUserDirs(userDirs('"/data/My\\ Docs"'), HOME)).toBe('/data/My Docs');
    // "$HOME/" disables the folder; an unquoted or relative value is not read.
    for (const value of ['"$HOME/"', '$HOME/Documents', '"Documents"']) {
      expect(documentsDirFromUserDirs(userDirs(value), HOME), value).toBeNull();
    }
    expect(documentsDirFromUserDirs('', HOME)).toBeNull();
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

  it('refuses a correct-looking worktree instance whose vault points at the real one', () => {
    // The recorded harness failure: a reused .tauri-data carried a stale
    // notes-dir-override.json, and a persisted explicit override beats
    // FUTO_NOTES_DATA_DIR. Exec path and data dir both look right, so the vault
    // check is the only layer that can catch it.
    const result = verifyTarget(
      {
        pid: 1234,
        execPath: `${SELF}/target/debug/futo-notes-tauri`,
        dataDir: `${SELF}/.tauri-data`,
        notesDir: `${HOME}/Documents/futo-notes`,
      },
      CONTEXT,
    );
    expect(result.verdict).toBe('REFUSED');
    expect(result.refusals.map((refusal) => refusal.code)).toEqual(['production-vault']);
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

// Windows: the same verdicts from Windows paths (drive letters, backslashes, any case), which
// are judged by Windows path rules on every OS, plus the process listings Windows gives.
describe('on Windows', () => {
  const WIN_SELF = 'C:\\src\\futo-notes';
  const WIN = {
    worktreeRoots: ['C:/src/futo-notes', 'C:/src/futo-notes-mr-7'],
    selfRoot: 'C:/src/futo-notes',
    home: 'C:\\Users\\dev',
    releaseVault: 'C:\\Users\\dev\\OneDrive\\Documents\\futo-notes',
  };

  it("verifies this checkout's debug build and its isolated vault, whatever the slashes or case", () => {
    const result = verifyTarget(
      {
        pid: 8212,
        execPath: `${WIN_SELF}\\target\\debug\\futo-notes-tauri.exe`,
        dataDir: `c:\\src\\futo-notes\\.tauri-data`,
        notesDir: `${WIN_SELF}\\.tauri-data\\notes`,
      },
      WIN,
    );
    expect(result).toMatchObject({ verdict: 'verified', refusals: [] });
  });

  it('REFUSES the installed app, per-user or in Program Files', () => {
    for (const execPath of [
      'C:\\Users\\dev\\AppData\\Local\\FUTO Notes\\futo-notes-tauri.exe',
      'C:\\Program Files\\FUTO Notes\\futo-notes-tauri.exe',
    ]) {
      expect(classifyExecPath(execPath, WIN).code).toBe('system-install');
    }
  });

  it("REFUSES another checkout's build, a release build, and the real vault", () => {
    expect(
      classifyExecPath('C:\\src\\futo-notes-mr-7\\target\\debug\\futo-notes-tauri.exe', WIN).code,
    ).toBe('other-worktree');
    expect(classifyExecPath(`${WIN_SELF}\\target\\release\\futo-notes-tauri.exe`, WIN).code).toBe(
      'release-profile',
    );
    for (const notesDir of [
      'C:\\Users\\dev\\Documents\\futo-notes',
      // Documents backed up to OneDrive, as GetFolderPath('MyDocuments') reports it.
      'c:/users/dev/onedrive/documents/futo-notes/Work',
    ]) {
      expect(classifyVault(notesDir, WIN).code, notesDir).toBe('production-vault');
    }
  });

  it('reads the listener and the candidates out of netstat and tasklist', () => {
    const netstat = [
      'Active Connections',
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1012',
      '  TCP    127.0.0.1:11223        0.0.0.0:0              LISTENING       8212',
      '  TCP    127.0.0.1:51000        127.0.0.1:11223        ESTABLISHED     9001',
    ].join('\r\n');
    expect(parseNetstatListener(netstat, 11223)).toBe(8212);
    expect(parseNetstatListener(netstat, 1122)).toBeNull();
    expect(
      parseTasklist(
        '"futo-notes-tauri.exe","8212","Console","1","120,000 K"\r\n"svchost.exe","4","Services","0","1 K"',
      ),
    ).toEqual([
      { image: 'futo-notes-tauri.exe', pid: 8212 },
      { image: 'svchost.exe', pid: 4 },
    ]);
  });
});
