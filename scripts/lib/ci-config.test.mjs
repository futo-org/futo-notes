import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CIRRUS_STAR, cirrusCiPaths, readCirrusCiSource } from './cirrus-ci.mjs';
import { GITLAB_CI, gitlabCiPaths, readGitlabCiSource } from './gitlab-ci.mjs';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');

describe('the GitLab pipeline reader', () => {
  it('reads every include the root file names', () => {
    // An include written in another shape (quoted, a bare string) would be
    // skipped, and every text check would silently miss its jobs.
    const root = readFileSync(join(ROOT, GITLAB_CI), 'utf8');
    const includeLines = root.split('\n').filter((line) => /\blocal:/.test(line));
    expect(gitlabCiPaths(ROOT).slice(1)).toHaveLength(includeLines.length);
    expect(includeLines.length).toBeGreaterThan(0);
  });

  it('covers every job file under ci/', () => {
    const jobFiles = readdirSync(join(ROOT, 'ci'))
      .filter((name) => name.endsWith('.yml'))
      .map((name) => `ci/${name}`);
    expect(gitlabCiPaths(ROOT).slice(1).sort()).toEqual(jobFiles.sort());
  });

  it('joins the root file and its includes', () => {
    const source = readGitlabCiSource(ROOT);
    expect(source).toMatch(/^stages:$/m);
    expect(source).toMatch(/^release:gate:$/m);
  });
});

describe('the Cirrus config reader', () => {
  it('reads every task file .cirrus.star appends, and every file under ci/cirrus/', () => {
    const star = readFileSync(join(ROOT, CIRRUS_STAR), 'utf8');
    const listed = star.split('\n').filter((line) => /^ {4}"/.test(line));
    const taskFiles = cirrusCiPaths(ROOT).slice(1);
    expect(taskFiles).toHaveLength(listed.length);
    const onDisk = readdirSync(join(ROOT, 'ci/cirrus')).map((name) => `ci/cirrus/${name}`);
    expect([...taskFiles].sort()).toEqual(onDisk.sort());
  });

  it('joins .cirrus.yml and the appended tasks', () => {
    const source = readCirrusCiSource(ROOT);
    expect(source).toMatch(/^test_rust_macos_task:$/m);
    expect(source).toMatch(/^build_ios_native_task:$/m);
  });
});
