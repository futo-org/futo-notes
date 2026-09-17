// The CLI contract, because CI depends on its exit codes and stdout: the tag
// gate reads the exit status, and publish:android/publish:ios:appstore pipe
// stdout straight into the store payloads. A stray log line on stdout would be
// submitted to users as part of the release notes.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'release-notes.mjs');

let workdir;

// The script resolves `release-notes/` relative to the working directory, so
// each case gets a throwaway one rather than the repo's real notes.
function run(args, { cwd = workdir } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, CI_COMMIT_TAG: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return { code: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

function writeNotes(tag, body) {
  writeFileSync(join(workdir, 'release-notes', `${tag}.md`), body);
}

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'release-notes-'));
  mkdirSync(join(workdir, 'release-notes'));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe('--target', () => {
  beforeEach(() => {
    writeNotes(
      'v1.7.2',
      '# v1.7.2\n\nFolder sync works on Windows.\n\n## Short\n\nFixes Windows folder sync.\n',
    );
  });

  it('prints the App Store text with nothing else on stdout', () => {
    const result = run(['--tag', 'v1.7.2', '--target', 'ios']);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('Folder sync works on Windows.');
  });

  it('prints the Play text with nothing else on stdout', () => {
    const result = run(['--tag', 'v1.7.2', '--target', 'play']);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('Fixes Windows folder sync.');
  });

  it('rejects a target it does not know', () => {
    expect(run(['--tag', 'v1.7.2', '--target', 'amazon']).code).toBe(1);
  });
});

describe('--check', () => {
  it('passes a well-formed file', () => {
    writeNotes('v1.7.2', '# v1.7.2\n\nAll good.\n');
    const result = run(['--tag', 'v1.7.2', '--check']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('App Store 9 chars');
  });

  it('fails a missing file and says the notes must be on the tagged commit', () => {
    const result = run(['--tag', 'v1.7.2', '--check']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Missing release-notes/v1.7.2.md');
    expect(result.stderr).toContain('re-tagging');
  });

  it('fails an oversized file', () => {
    writeNotes('v1.7.2', `# v1.7.2\n\n${'x'.repeat(600)}\n`);
    const result = run(['--tag', 'v1.7.2', '--check']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Google Play text is 600 characters');
  });

  // The tag gate runs on every tag pipeline so release:gate can depend on it
  // unconditionally; a prerelease tag publishes to no store.
  it('passes a prerelease tag with no file at all', () => {
    const result = run(['--tag', 'v1.7.2-4', '--check']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('not a stable release tag');
  });

  it('refuses to PRINT notes for a prerelease tag', () => {
    expect(run(['--tag', 'v1.7.2-4', '--target', 'ios']).code).toBe(1);
  });
});

describe('--all', () => {
  it('validates every committed file', () => {
    writeNotes('v1.7.1', '# v1.7.1\n\nOne.\n');
    writeNotes('v1.7.2', '# v1.7.2\n\nTwo.\n');
    const result = run(['--all']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('2 release-notes file(s) validate');
  });

  it('fails on any bad file and names it', () => {
    writeNotes('v1.7.1', '# v1.7.1\n\nFine.\n');
    writeNotes('v1.7.2', `# v1.7.2\n\n${'x'.repeat(600)}\n`);
    const result = run(['--all']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('release-notes/v1.7.2.md');
    expect(result.stderr).not.toContain('v1.7.1');
  });

  it('ignores README.md and anything not named for a stable tag', () => {
    writeFileSync(join(workdir, 'release-notes', 'README.md'), '# not a release\n');
    writeFileSync(join(workdir, 'release-notes', 'v1.7.2-rc.md'), '');
    expect(run(['--all'])).toMatchObject({ code: 0 });
  });
});

it('reads the tag from CI_COMMIT_TAG when --tag is not passed', () => {
  writeNotes('v1.7.2', '# v1.7.2\n\nFrom the environment.\n');
  const stdout = execFileSync(process.execPath, [SCRIPT, '--target', 'ios'], {
    cwd: workdir,
    encoding: 'utf8',
    env: { ...process.env, CI_COMMIT_TAG: 'v1.7.2' },
  });
  expect(stdout).toBe('From the environment.');
});

it('rejects an unknown argument instead of silently ignoring it', () => {
  expect(run(['--tag', 'v1.7.2', '--publish']).code).toBe(1);
});
