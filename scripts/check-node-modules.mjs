#!/usr/bin/env node
// Fail a fresh worktree fast, before pnpm gets a chance to misreport why.
//
// A new `git worktree` has no node_modules, so the first JS-side recipe in
// `just check` dies with `undefined` followed by
// `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command "tsx" not found` — which names
// tsx, never the missing install, and sends the reader looking for a broken
// dependency (pc_40406aa84bc1, and pc_cd6fa6e7aa76 for the vitest spelling of
// the same error). `just test-one` solves this by installing; `check` is a
// gate, so it refuses instead of mutating the tree it is about to verify.
//
// It also verifies that every `patchedDependencies` entry (pnpm-workspace.yaml,
// package.json "pnpm") is actually APPLIED in the installed copies the app resolves
// (RC-69). An incremental `pnpm install` over an existing node_modules can link a
// `<pkg>_patch_hash=<hash>` directory holding the UNPATCHED package, or drop an earlier
// patch, so a dev/agent checkout silently runs unpatched code while CI (fresh install)
// stays green. The check is pure JS (no git/patch binary, so it works everywhere),
// read-only, and takes a few ms: for each hunk of each patched file it requires the
// hunk's post-image (context + added lines) to be present in the installed file, i.e. the
// question `git apply --check --reverse` answers.
//
//   node scripts/check-node-modules.mjs [dir]   (dir defaults to the repo root)
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = process.argv[2] ? path.resolve(process.argv[2]) : repoRoot;

if (!existsSync(path.join(root, 'node_modules'))) {
  console.error(`node_modules is missing in ${root}`);
  console.error('  A fresh git worktree has no dependencies installed yet, so every recipe');
  console.error('  after this one fails inside pnpm naming a binary (tsx, vitest) rather');
  console.error('  than the install.');
  console.error('  Run: just install');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// patchedDependencies: is each patch present in what the app resolves?
// ---------------------------------------------------------------------------

const YAML_ENTRY =
  /^\s+(?:"([^"]+)"|'([^']+)'|([^\s:'"]+))\s*:\s*(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/;

/** `name@version` -> patch path (relative to root), from pnpm-workspace.yaml and package.json. */
function readPatchedDependencies(rootDir) {
  const entries = {};
  const yamlPath = path.join(rootDir, 'pnpm-workspace.yaml');
  if (existsSync(yamlPath)) {
    let inBlock = false;
    for (const line of readFileSync(yamlPath, 'utf8').split('\n')) {
      if (/^patchedDependencies:\s*$/.test(line)) {
        inBlock = true;
        continue;
      }
      if (!inBlock) continue;
      if (/^\S/.test(line)) break; // next top-level key
      const m = YAML_ENTRY.exec(line);
      if (m) entries[m[1] ?? m[2] ?? m[3]] = m[4] ?? m[5] ?? m[6];
    }
  }
  const pkgPath = path.join(rootDir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      Object.assign(
        entries,
        JSON.parse(readFileSync(pkgPath, 'utf8')).pnpm?.patchedDependencies ?? {},
      );
    } catch {
      // A malformed package.json is somebody else's error to report.
    }
  }
  return entries;
}

/** Unified diff -> [{ path, deleted, hunks: [post-image lines[]] }]. */
function parsePatch(text) {
  const lines = text.split('\n');
  const files = [];
  let file = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      file = { path: null, deleted: false, hunks: [] };
      files.push(file);
    } else if (file && file.hunks.length === 0 && line.startsWith('+++ ')) {
      const target = line.slice(4).trim();
      file.deleted = target === '/dev/null';
      file.path = target.replace(/^b\//, '');
    } else if (file && line.startsWith('@@ ')) {
      const h = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
      if (!h) continue;
      // Consume exactly the counted lines, so a body line starting with `---` is not a header.
      let oldLeft = h[1] === undefined ? 1 : Number(h[1]);
      let newLeft = h[2] === undefined ? 1 : Number(h[2]);
      const post = [];
      while ((oldLeft > 0 || newLeft > 0) && ++i < lines.length) {
        const body = lines[i];
        if (body[0] === '+') {
          post.push(body.slice(1));
          newLeft--;
        } else if (body[0] === '-') {
          oldLeft--;
        } else if (body[0] !== '\\') {
          post.push(body.slice(1)); // context line (an empty one means an empty source line)
          oldLeft--;
          newLeft--;
        }
      }
      file.hunks.push(post);
    }
  }
  return files.filter((f) => f.path);
}

/** Why the patch is NOT applied in pkgDir (empty when it is). */
function unappliedReasons(pkgDir, files) {
  const reasons = [];
  for (const f of files) {
    const target = path.join(pkgDir, f.path);
    if (f.deleted) {
      if (existsSync(target)) reasons.push(`${f.path} should have been deleted`);
      continue;
    }
    if (!existsSync(target)) {
      reasons.push(`${f.path} is missing`);
      continue;
    }
    const content = '\n' + readFileSync(target, 'utf8').replace(/\r\n/g, '\n') + '\n';
    const missing = f.hunks.filter(
      (post) => post.length && !content.includes('\n' + post.join('\n') + '\n'),
    ).length;
    if (missing) reasons.push(`${f.path}: ${missing} of ${f.hunks.length} hunks not applied`);
  }
  return reasons;
}

/** Every distinct on-disk directory that `name` resolves to under root's node_modules. */
function resolvedCopies(rootDir, name) {
  const found = new Set();
  const add = (p) => {
    try {
      found.add(realpathSync(p));
    } catch {
      // absent or dangling
    }
  };
  // Direct links: the root and each workspace package (apps/*, packages/*).
  const linkers = [rootDir];
  for (const group of ['apps', 'packages']) {
    try {
      for (const e of readdirSync(path.join(rootDir, group), { withFileTypes: true })) {
        if (e.isDirectory()) linkers.push(path.join(rootDir, group, e.name));
      }
    } catch {
      // no such group
    }
  }
  for (const dir of linkers) add(path.join(dir, 'node_modules', name));
  // Transitive links: every package in the virtual store that depends on `name`.
  const store = path.join(rootDir, 'node_modules', '.pnpm');
  add(path.join(store, 'node_modules', name));
  let entries = [];
  try {
    entries = readdirSync(store);
  } catch {
    // no virtual store (non-pnpm layout)
  }
  for (const e of entries) add(path.join(store, e, 'node_modules', name));
  return [...found];
}

function checkPatchedDependencies(rootDir) {
  const failures = [];
  const realRoot = realpathSync(rootDir); // realpath'd copies must be shown relative to this
  for (const [spec, patchRel] of Object.entries(readPatchedDependencies(rootDir))) {
    const at = spec.lastIndexOf('@');
    if (at <= 0) continue;
    const name = spec.slice(0, at);
    const version = spec.slice(at + 1);
    const patchPath = path.resolve(rootDir, patchRel);
    if (!existsSync(patchPath)) continue; // pnpm itself reports a missing patch file
    const files = parsePatch(readFileSync(patchPath, 'utf8'));
    for (const dir of resolvedCopies(rootDir, name)) {
      let installed;
      try {
        installed = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
      } catch {
        continue;
      }
      if (installed !== version) continue; // another version; this patch does not target it
      const reasons = unappliedReasons(dir, files);
      if (reasons.length)
        failures.push({ spec, patchRel, dir: path.relative(realRoot, dir), reasons });
    }
  }
  return failures;
}

const unpatched = checkPatchedDependencies(root);
if (unpatched.length) {
  for (const f of unpatched) {
    console.error(`${f.spec}: ${f.patchRel} is NOT applied in the installed copy`);
    console.error(`  ${f.dir}`);
    for (const r of f.reasons) console.error(`    ${r}`);
  }
  console.error('  An incremental `pnpm install` can link a patch-hash directory holding the');
  console.error('  unpatched package (or keep an older patch), so this checkout would run');
  console.error('  unpatched code while CI, which installs fresh, stays green.');
  console.error('  Run: rm -rf node_modules && pnpm install');
  process.exit(1);
}
