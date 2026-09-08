import { describe, expect, it } from 'vitest';

import { decide, evaluateCommand, isLinkedWorktree } from './guard-bash.mjs';

// Red proofs: every deny rule fires on the shape that caused an incident and
// names its rule, and the sanctioned alternative passes. A guard that only
// ever says yes is the silent-green failure AGENTS.md M11 describes.

const inWorktree = { linkedWorktree: true };
const inPrimary = { linkedWorktree: false };

describe('process identity (M25 / M24)', () => {
  it('DENIES a process-name kill of a dev server — the pc_44008fcf1d5a shape', () => {
    const verdict = evaluateCommand('pkill -f vite', inWorktree);
    expect(verdict?.id).toBe('process-name-kill');
    expect(verdict?.instead).toContain('just qa-target kill');
  });

  it('DENIES killing the app by its binary name, which every build shares', () => {
    const verdict = evaluateCommand('pkill -f futo-notes-tauri', inWorktree);
    expect(verdict?.id).toBe('app-process-name-lookup');
  });

  it('DENIES the pgrep|xargs kill idiom', () => {
    const verdict = evaluateCommand("pgrep -f 'cargo tauri dev' | xargs kill", inWorktree);
    expect(verdict?.id).toBe('process-name-kill');
  });

  it('ALLOWS a kill by recorded PID — identity, the sanctioned form', () => {
    expect(evaluateCommand('kill 4242', inWorktree)).toBeNull();
    expect(evaluateCommand('kill -TERM "$(cat /tmp/tauri.pid)"', inWorktree)).toBeNull();
  });

  it('ALLOWS a pattern kill anchored to this checkout', () => {
    expect(evaluateCommand('pkill -f "$PWD"', inWorktree)).toBeNull();
  });

  it('DENIES OS-level input tools', () => {
    expect(evaluateCommand('cliclick c:100,200', inWorktree)?.id).toBe('cliclick');
    expect(
      evaluateCommand(
        'osascript -e \'tell application "System Events" to keystroke "z"\'',
        inWorktree,
      )?.id,
    ).toBe('system-events-ui-scripting');
  });

  it('reports the FIRST offending line of a multi-line command', () => {
    const verdict = evaluateCommand('echo starting\npkill -f gradle\necho done', inWorktree);
    expect(verdict?.id).toBe('process-name-kill');
    expect(verdict?.line).toBe('pkill -f gradle');
  });
});

describe('git stash in a linked worktree', () => {
  it('DENIES stash push and pop inside a linked worktree', () => {
    expect(evaluateCommand('git stash', inWorktree)?.id).toBe('git-stash-in-worktree');
    expect(evaluateCommand('git stash pop', inWorktree)?.id).toBe('git-stash-in-worktree');
    expect(evaluateCommand('git -C ../x stash push -m wip', inWorktree)?.id).toBe(
      'git-stash-in-worktree',
    );
  });

  it('ALLOWS `git stash list` (read-only) and stash in the primary checkout', () => {
    expect(evaluateCommand('git stash list', inWorktree)).toBeNull();
    expect(evaluateCommand('git stash', inPrimary)).toBeNull();
  });

  it('does not confuse a word containing "stash" with the subcommand', () => {
    expect(evaluateCommand('git log --oneline -- docs/stash-notes.md', inWorktree)).toBeNull();
  });
});

describe('foregrounding an app', () => {
  it('DENIES `open -a Simulator` and AppleScript activate', () => {
    expect(evaluateCommand('open -a Simulator', inWorktree)?.id).toBe('foreground-app');
    expect(
      evaluateCommand('osascript -e \'tell app "FUTO Notes" to activate\'', inWorktree)?.id,
    ).toBe('foreground-app');
  });

  it('ALLOWS xdg-open, reopen, and --open flags', () => {
    expect(evaluateCommand('xdg-open -a file.txt', inWorktree)).toBeNull();
    expect(evaluateCommand('pnpm run dev --open -b', inWorktree)).toBeNull();
  });
});

describe('everyday commands pass', () => {
  it.each([
    'just check',
    'git status && git diff --stat',
    'pnpm exec vitest run scripts/hooks',
    'node scripts/qa-target.mjs kill',
    'cargo test -p futo-notes-model',
    'find . -newermt "2026-08-10 12:00:00" -name "*.md"',
    '',
  ])('allows %s', (command) => {
    expect(evaluateCommand(command, inWorktree)).toBeNull();
  });
});

describe('decide (hook envelope)', () => {
  it('returns a deny decision with the rule and the alternative in the reason', () => {
    const decision = decide({
      tool_name: 'Bash',
      tool_input: { command: 'pkill -f vite' },
      cwd: '/definitely/not/a/repo',
    });
    expect(decision?.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(decision?.hookSpecificOutput.permissionDecisionReason).toContain('process-name-kill');
    expect(decision?.hookSpecificOutput.permissionDecisionReason).toContain('Instead:');
  });

  it('returns null (no decision) for other tools and for clean commands', () => {
    expect(decide({ tool_name: 'Read', tool_input: { file_path: 'x' } })).toBeNull();
    expect(decide({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/' })).toBeNull();
  });
});

describe('isLinkedWorktree', () => {
  it('is true when the nearest .git is a file, false when it is a directory', () => {
    const fakeFs = (kind) => ({
      statSync: (p) => {
        if (p === '/repo/wt/.git' && kind === 'file') return { isFile: () => true };
        if (p === '/repo/.git' && kind === 'dir') return { isFile: () => false };
        throw new Error('ENOENT');
      },
    });
    expect(isLinkedWorktree('/repo/wt/src/deep', fakeFs('file'))).toBe(true);
    expect(isLinkedWorktree('/repo/src', fakeFs('dir'))).toBe(false);
  });
});
