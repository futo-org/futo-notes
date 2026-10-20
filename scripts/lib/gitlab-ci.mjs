// The root .gitlab-ci.yml holds the pipeline settings and includes the job
// files under ci/. Text checks read every file through here, in include
// order, so a job's text is found wherever it lives. Paths are relative to
// `root`.
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const GITLAB_CI = '.gitlab-ci.yml';

export function gitlabCiPaths(root) {
  const source = readFileSync(path.join(root, GITLAB_CI), 'utf8');
  const includes = [...source.matchAll(/^ {2}- local: (\S+)$/gm)].map((match) => match[1]);
  return [GITLAB_CI, ...includes];
}

// Each file's text, keyed by path, for checks that report a file and line.
export function readGitlabCiSources(root) {
  return Object.fromEntries(
    gitlabCiPaths(root).map((file) => [file, readFileSync(path.join(root, file), 'utf8')]),
  );
}

// The whole pipeline as one text, root first, for checks that grep jobs.
export function readGitlabCiSource(root) {
  return Object.values(readGitlabCiSources(root)).join('\n');
}
