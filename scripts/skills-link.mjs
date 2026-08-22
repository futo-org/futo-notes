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
// (the lockfile records source + hash for each skill). So this script links only
// what is already on disk and NAMES what is missing rather than leaving a broken
// link behind; a dangling link is worse than an absent skill, because the slash
// command appears and then fails to load.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCKFILE = path.join(ROOT, 'skills-lock.json');
const SOURCE_DIR = path.join(ROOT, '.agents', 'skills');
const TARGET_DIR = path.join(ROOT, '.claude', 'skills');

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
  const linked = [];
  const already = [];
  const missing = [];
  const occupied = [];

  for (const name of names) {
    const source = path.join(SOURCE_DIR, name);
    const target = path.join(TARGET_DIR, name);

    if (!fs.existsSync(source)) {
      missing.push(name);
      continue;
    }
    // A real (non-symlink) directory here is a first-party skill that happens to
    // share a name — never clobber it.
    const existing = fs.lstatSync(target, { throwIfNoEntry: false });
    if (existing && !existing.isSymbolicLink()) {
      occupied.push(name);
      continue;
    }
    if (existing) {
      if (fs.realpathSync(target) === fs.realpathSync(source)) {
        already.push(name);
        continue;
      }
      fs.unlinkSync(target);
    }
    fs.symlinkSync(path.relative(TARGET_DIR, source), target);
    linked.push(name);
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
