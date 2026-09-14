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
//   node scripts/check-node-modules.mjs [dir]   (dir defaults to the repo root)
import { existsSync } from 'node:fs';
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
