#!/usr/bin/env node
/**
 * Which past fixes can still become scenarios?
 *
 *   node find-candidates.mjs [--limit 400]
 *
 * A scenario is today's codebase with one old fix undone, so the only usable
 * fixes are the ones that still revert cleanly onto HEAD. Everything else has
 * been overtaken by later work, and hand-resolving the conflict would invent a
 * bug rather than restore the real one. This tries every `fix(...)` commit and
 * prints the pool, richest first.
 */
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync, writeFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const stagingDir = join(here, 'work', '.candidate-scan');

const git = (args, cwd = repoRoot) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const limit = process.argv.includes('--limit')
  ? process.argv[process.argv.indexOf('--limit') + 1]
  : '400';

const isTestPath = (path) =>
  /(^|\/)tests?\//.test(path) ||
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) ||
  /Tests?\.(swift|kt)$/.test(path) ||
  /(^|\/)src\/test\//.test(path);

const platformOf = (paths) => {
  if (paths.some((p) => p.startsWith('apps/android/'))) return 'android';
  if (paths.some((p) => p.startsWith('apps/ios/'))) return 'ios';
  return 'desktop';
};

const commits = git(['log', '--no-merges', `-${limit}`, '--format=%H %s'])
  .split('\n')
  .filter((line) => /^[0-9a-f]+ fix\(/.test(line))
  .map((line) => ({ sha: line.slice(0, 40), subject: line.slice(41) }));

rmSync(stagingDir, { recursive: true, force: true });
git(['worktree', 'prune']);
git(['worktree', 'add', '--detach', '--quiet', stagingDir, 'HEAD']);

const clean = [];
try {
  for (const commit of commits) {
    git(['reset', '--hard', '--quiet', 'HEAD'], stagingDir);
    git(['clean', '-qfd'], stagingDir);
    let applies = true;
    try {
      git(['revert', '--no-commit', commit.sha], stagingDir);
    } catch {
      applies = false;
      try {
        git(['revert', '--quit'], stagingDir);
      } catch {}
    }
    if (!applies) continue;

    const touched = git(['show', '--name-status', '--format=', commit.sha])
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\t').pop());
    const sourceFiles = touched.filter((p) => !isTestPath(p) && !p.startsWith('docs/'));
    const testFiles = touched.filter(isTestPath);
    if (!sourceFiles.length) continue;

    clean.push({
      sha: commit.sha.slice(0, 8),
      subject: commit.subject,
      platform: platformOf(touched),
      sourceFiles: sourceFiles.length,
      testFiles: testFiles.length,
      specKept: touched.filter((p) => p.startsWith('docs/spec/')).length,
    });
  }
} finally {
  git(['worktree', 'remove', '--force', stagingDir]);
}

writeFileSync(join(here, 'candidates.json'), `${JSON.stringify(clean, null, 2)}\n`);
console.log(`${clean.length} of ${commits.length} fix commits still revert cleanly onto HEAD\n`);
for (const c of clean) {
  console.log(
    `${c.sha}  ${c.platform.padEnd(7)}  ${String(c.sourceFiles).padStart(2)} src  ` +
      `${String(c.testFiles).padStart(2)} test  ${c.specKept ? 'spec' : '    '}  ${c.subject}`,
  );
}
