import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

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
