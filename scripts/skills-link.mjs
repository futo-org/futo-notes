// Link the third-party skills recorded in skills-lock.json from the gitignored
// `.agents/skills/<name>` into `.claude/skills/<name>`, where Claude Code
// discovers them (`just skills-link`).
//
// Why a recipe instead of committed symlinks: `.agents/` is gitignored with zero
// tracked files, so a COMMITTED symlink into it resolves only in the one checkout
// that happens to have `.agents/` populated and dangles in every fresh clone and
// every `git worktree add` — which is where parallel QA legs and CI run. MR !207
// shipped 22 such links. The links this script creates are gitignored (see
// .gitignore's "Third-party skills" block) and are therefore per-checkout state,
// not repo content.
//
// Nothing in this repo fetches `.agents/skills/` — an external installer does
// (the lockfile records source + hash for each skill). A worktree can link an
// installed skill from a sibling checkout only when both lockfiles match, so
// every checkout sees the same pinned skill versions.

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCKFILE = path.join(ROOT, 'skills-lock.json');
const SOURCE_DIR = path.join(ROOT, '.agents', 'skills');
const TARGET_DIR = path.join(ROOT, '.claude', 'skills');

export function skillSourceFor(name, { root = ROOT, lockText, worktreeRoots = [] } = {}) {
  const currentLock = lockText ?? fs.readFileSync(path.join(root, 'skills-lock.json'), 'utf8');
  for (const checkout of [root, ...worktreeRoots]) {
    if (path.resolve(checkout) !== path.resolve(root)) {
      try {
        if (fs.readFileSync(path.join(checkout, 'skills-lock.json'), 'utf8') !== currentLock)
          continue;
      } catch {
        continue;
      }
    }
    const source = path.join(checkout, '.agents', 'skills', name);
    if (fs.existsSync(path.join(source, 'SKILL.md'))) return source;
  }
  return null;
}

export function linkSkill(name, { root = ROOT, lockText, worktreeRoots = [] } = {}) {
  let source = skillSourceFor(name, { root, lockText, worktreeRoots });
  if (!source) return 'missing';

  const localSource = path.join(root, '.agents', 'skills', name);
  if (path.resolve(source) !== path.resolve(localSource)) {
    if (fs.existsSync(localSource)) {
      throw new Error(
        `incomplete local skill cache at ${localSource} (missing SKILL.md); remove that directory and retry`,
      );
    }
    const localSkillsDir = path.dirname(localSource);
    fs.mkdirSync(localSkillsDir, { recursive: true });
    const stagingDir = fs.mkdtempSync(path.join(localSkillsDir, '.skills-link-'));
    try {
      const stagedSkill = path.join(stagingDir, name);
      fs.cpSync(source, stagedSkill, { recursive: true, errorOnExist: true });
      if (!fs.existsSync(path.join(stagedSkill, 'SKILL.md'))) {
        throw new Error(`installed source skill is incomplete at ${source} (missing SKILL.md)`);
      }
      fs.renameSync(stagedSkill, localSource);
    } finally {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
  }

  const target = path.join(root, '.claude', 'skills', name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const existing = fs.lstatSync(target, { throwIfNoEntry: false });
  if (existing && !existing.isSymbolicLink()) return 'occupied';
  if (existing) {
    const destination = path.resolve(path.dirname(target), fs.readlinkSync(target));
    if (destination === path.resolve(localSource)) return 'already';
    fs.unlinkSync(target);
  }
  fs.symlinkSync(path.relative(path.dirname(target), localSource), target);
  return 'linked';
}

export function lockedSkillNames(lockfileText) {
  const lock = JSON.parse(lockfileText);
  return Object.keys(lock.skills ?? {}).sort();
}

function main() {
  if (!fs.existsSync(LOCKFILE)) {
    console.error(`no skills-lock.json at ${path.relative(ROOT, LOCKFILE)} — nothing to link.`);
    process.exit(1);
  }

  const names = lockedSkillNames(fs.readFileSync(LOCKFILE, 'utf8'));
  const lockText = fs.readFileSync(LOCKFILE, 'utf8');
  const worktreeRoots = execFileSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .flatMap((line) => (line.startsWith('worktree ') ? [line.slice('worktree '.length)] : []));
  const linked = [];
  const already = [];
  const missing = [];
  const occupied = [];

  for (const name of names) {
    const result = linkSkill(name, {
      root: ROOT,
      lockText,
      worktreeRoots,
    });
    if (result === 'missing') missing.push(name);
    else if (result === 'occupied') occupied.push(name);
    else if (result === 'already') already.push(name);
    else linked.push(name);
  }

  console.log(
    `skills-link: ${linked.length} linked, ${already.length} already correct, ` +
      `${missing.length} not installed, ${occupied.length} skipped.`,
  );
  if (linked.length > 0) console.log(`  linked:        ${linked.join(', ')}`);
  if (occupied.length > 0) {
    console.log(`  skipped (a real directory already owns the name): ${occupied.join(', ')}`);
  }
  if (missing.length > 0) {
    console.log(`  not installed: ${missing.join(', ')}`);
    console.log(
      `  → these are absent from ${path.relative(ROOT, SOURCE_DIR)}. Install them with the\n` +
        `    tool that produced skills-lock.json (they are third-party, not vendored here),\n` +
        `    then re-run \`just skills-link\`. Left unlinked on purpose: a dangling skill\n` +
        `    link is worse than a missing one.`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
