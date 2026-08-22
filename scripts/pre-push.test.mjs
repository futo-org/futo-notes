import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = join(ROOT, '.githooks/pre-push');
const AVAILABILITY_GATE = join(ROOT, 'scripts/run-ios-stories-if-available.sh');
const ZERO_SHA = '0'.repeat(40);

let scratch;

function git(args, cwd = scratch) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed:\n${result.stderr}`);
  }
  return result.stdout.trim();
}

function writeExecutable(path, contents = '#!/bin/sh\nexit 0\n') {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function commitFile(path, contents, message) {
  const absolutePath = join(scratch, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents);
  git(['add', path]);
  git(['commit', '-m', message]);
  return git(['rev-parse', 'HEAD']);
}

function runHook(input, env = {}) {
  return spawnSync(HOOK, ['origin', 'unused'], {
    cwd: scratch,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    input,
  });
}

function initializeRepository() {
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'pre-push-test@example.invalid']);
  git(['config', 'user.name', 'Pre-push Test']);
  const mainSha = commitFile('apps/ios/existing.swift', '// existing\n', 'initial');
  git(['update-ref', 'refs/remotes/origin/main', mainSha]);
  git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);

  const gatePath = join(scratch, 'scripts/run-ios-stories-if-available.sh');
  mkdirSync(dirname(gatePath), { recursive: true });
  writeExecutable(gatePath, '#!/bin/sh\necho STORY_GATE_RAN\nexit 23\n');
  return mainSha;
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'futo-pre-push-'));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('the pre-push iOS story hook', () => {
  it('scopes a new branch from the remote default branch', () => {
    initializeRepository();
    git(['switch', '-c', 'docs-only']);
    const localSha = commitFile('docs/change.md', 'docs only\n', 'docs');

    const result = runHook(`refs/heads/docs-only ${localSha} refs/heads/docs-only ${ZERO_SHA}\n`);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('pushed changes do not touch');
    expect(result.stdout).not.toContain('STORY_GATE_RAN');
  });

  it('does not run branch-only checks for tag pushes', () => {
    const localSha = initializeRepository();

    const result = runHook(`refs/tags/v1.0.0 ${localSha} refs/tags/v1.0.0 ${ZERO_SHA}\n`);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('no local branch update');
    expect(result.stdout).not.toContain('STORY_GATE_RAN');
  });

  it('still runs the story gate for a new branch with iOS changes', () => {
    initializeRepository();
    git(['switch', '-c', 'ios-change']);
    const localSha = commitFile('apps/ios/new.swift', '// changed\n', 'ios');

    const result = runHook(`refs/heads/ios-change ${localSha} refs/heads/ios-change ${ZERO_SHA}\n`);

    expect(result.status).toBe(23);
    expect(result.stdout).toContain('STORY_GATE_RAN');
  });

  it('explains an unavailable remote object and its explicit bypass', () => {
    const localSha = initializeRepository();
    const unavailableSha = '1'.repeat(40);
    const input = `refs/heads/main ${localSha} refs/heads/main ${unavailableSha}\n`;

    const blocked = runHook(input);
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain('iOS device stories: BLOCKED');
    expect(blocked.stderr).toContain('FUTO_SKIP_IOS_STORIES=1');

    const bypassed = runHook(input, { FUTO_SKIP_IOS_STORIES: '1' });
    expect(bypassed.status).toBe(0);
    expect(bypassed.stdout).toContain('iOS DEVICE STORIES SKIPPED');
  });
});

describe('the iOS story availability gate', () => {
  function runWithTools(tools) {
    const bin = join(scratch, 'bin');
    mkdirSync(bin);
    writeExecutable(join(bin, 'uname'), '#!/bin/sh\necho Darwin\n');
    for (const tool of tools) writeExecutable(join(bin, tool));

    return spawnSync('/bin/bash', [AVAILABILITY_GATE], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, AXE_BIN: 'axe', PATH: bin },
    });
  }

  it('names a missing just executable in the skipped banner', () => {
    const result = runWithTools(['xcodebuild', 'axe']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('`just` is unavailable');
    expect(result.stdout).toContain('iOS DEVICE STORIES SKIPPED');
  });

  it('names a missing Node.js executable in the skipped banner', () => {
    const result = runWithTools(['xcodebuild', 'axe', 'just']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Node.js is unavailable');
    expect(result.stdout).toContain('iOS DEVICE STORIES SKIPPED');
  });
});
