// The scenario repo for one bug: the checkout on disk plus the bug's patch, and its vault.
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  claudeMd,
  fixture,
  git,
  gitDir,
  here,
  KEEP,
  outDir,
  patchFor,
  repoDir,
  sh,
  sourceRoot,
  variant,
} from './config.mjs';

// The checkout as it is on disk — committed or not — is what gets the bug: tracked files plus
// untracked ones git does not ignore. The key changes whenever any of them does. Never this
// harness (bugs/ is the answer key) or docs/learnings/ (prose naming root causes).
const WITHHELD = ['experiments/', 'docs/learnings/'];
const sourceFiles = () =>
  git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    .split('\0')
    .filter(
      (path) =>
        path &&
        !WITHHELD.some((prefix) => path.startsWith(prefix)) &&
        existsSync(join(sourceRoot, path)),
    );
const sourceState = () =>
  sh('sh', [
    '-c',
    `cd "${sourceRoot}" && { git rev-parse HEAD; git diff HEAD; git ls-files -o --exclude-standard -z | xargs -0 shasum; } | shasum`,
  ]).trim();
const buildKey = (bug) =>
  JSON.stringify([bug.id, readFileSync(patchFor(bug), 'utf8'), variant, claudeMd, sourceState()]);

/** The checkout on disk + the bug, as a one-commit linked worktree of its own bare repo (tauri-dev and qa-target need both). */
function build(bug) {
  mkdirSync(outDir, { recursive: true });
  const stamp = join(outDir, '.built');
  if (existsSync(stamp) && readFileSync(stamp, 'utf8') === buildKey(bug) && existsSync(repoDir)) {
    // Undo anything the last agent edited or left behind (scripts, screenshots), so runs are independent.
    sh('git', ['checkout', '--', '.'], { cwd: repoDir });
    sh('git', ['clean', '-fdq'], { cwd: repoDir });
    rmSync(join(repoDir, 'test-screenshots'), { recursive: true, force: true });
    return;
  }
  const kept = join(outDir, 'kept');
  rmSync(kept, { recursive: true, force: true });
  mkdirSync(kept);
  if (existsSync(repoDir)) {
    for (const name of KEEP)
      if (existsSync(join(repoDir, name))) renameSync(join(repoDir, name), join(kept, name));
    rmSync(repoDir, { recursive: true, force: true });
  }
  rmSync(gitDir, { recursive: true, force: true });
  const content = join(outDir, 'content');
  rmSync(content, { recursive: true, force: true });
  mkdirSync(content);
  const list = join(outDir, 'files');
  writeFileSync(list, sourceFiles().join('\n'));
  execFileSync('sh', ['-c', `tar -C "${sourceRoot}" -cf - -T "${list}" | tar -x -C "${content}"`]);
  git(['init', '--quiet', '--bare', '--initial-branch=main', gitDir]);
  const inContent = ['--git-dir', gitDir, '--work-tree', content];
  // Explicit git-dir: run bare, `git apply` finds THIS checkout (content/ lives inside it) and
  // silently skips every path outside its cwd — the first run diagnosed an app with no bug in it.
  for (const patch of [
    patchFor(bug),
    ...(variant ? [join(here, 'variants', `${variant}.patch`)] : []),
  ]) {
    sh('git', [...inContent, 'apply', '--verbose', patch], {
      cwd: content,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const patched = [...readFileSync(patch, 'utf8').matchAll(/^\+\+\+ b\/(.+)$/gm)].map(
      (m) => m[1],
    );
    const unchanged = patched.filter(
      (path) =>
        existsSync(join(content, path)) &&
        readFileSync(join(content, path), 'utf8') === readFileSync(join(sourceRoot, path), 'utf8'),
    );
    if (unchanged.length) throw new Error(`${patch}: did not change ${unchanged.join(', ')}`);
  }
  if (claudeMd)
    writeFileSync(
      join(content, 'CLAUDE.md'),
      `${readFileSync(join(content, 'CLAUDE.md'), 'utf8').trimEnd()}\n\n${claudeMd}\n`,
    );
  git([...inContent, 'add', '-A']);
  git([
    ...inContent,
    '-c',
    'user.name=FUTO Notes',
    '-c',
    'user.email=dev@futo.org',
    'commit',
    '--quiet',
    '-m',
    'FUTO Notes',
  ]);
  git(['--git-dir', gitDir, 'worktree', 'add', '--quiet', repoDir, 'main']);
  rmSync(content, { recursive: true, force: true });
  for (const name of KEEP) {
    if (existsSync(join(kept, name))) renameSync(join(kept, name), join(repoDir, name));
    // First build: APFS clones of this checkout's, which share blocks until they diverge.
    else if (name !== 'dist' && existsSync(join(sourceRoot, name)))
      sh('cp', ['-Rc', join(sourceRoot, name), join(repoDir, name)]);
  }
  rmSync(kept, { recursive: true, force: true });
  // futo-puppet bakes its checkout's path in at compile time: a copy built elsewhere would read
  // and drive THAT checkout's app. Removing it makes the scenario build its own.
  rmSync(join(repoDir, 'target/debug/futo-puppet'), { force: true });
  mkdirSync(join(repoDir, 'dist'), { recursive: true });
  sh('pnpm', ['install', '--frozen-lockfile', '--silent'], { cwd: repoDir, stdio: 'inherit' });
  writeFileSync(stamp, buildKey(bug));
}

function seedVault() {
  const vault = join(repoDir, '.tauri-data/notes');
  rmSync(vault, { recursive: true, force: true });
  mkdirSync(vault, { recursive: true });
  cpSync(fixture, vault, { recursive: true });
}

export { build, seedVault };
