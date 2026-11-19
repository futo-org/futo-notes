#!/usr/bin/env node
// `just check`, scoped to what this branch changed; `just check-full` runs everything.
//
//   node scripts/check-scoped.mjs            scoped run (prints the plan first)
//   node scripts/check-scoped.mjs --plan     print the plan, run nothing
//   node scripts/check-scoped.mjs --full     every step, whatever changed
//   FUTO_CHECK_BASE=<ref>                    diff base (default origin/main)
//
// The changed set is the diff from merge-base(HEAD, base) plus staged, unstaged
// and untracked files. The rules are deny-by-default: an empty diff, a path no
// rule claims, or a root/tool config change runs every step (a scoped green
// must never stand in for a check that did not run, M11).
//
// What each step runs on:
//   Rust   - crates containing a change, crates whose .rs embeds or reads a
//            changed file outside the crate (include_str!, CARGO_MANIFEST_DIR
//            paths), and every crate that depends on those. test-rust's crate
//            list is intersected with that set; clippy and fmt stay
//            workspace-wide (cargo already rebuilds only what changed).
//   Web    - eslint, svelte-check, tsc and the vite build run whole-program
//            whenever their sources changed: they are a few seconds each, and a
//            whole run keeps type-aware lint rules seeing every caller.
//   Vitest - tests reached through imports from a changed file (`vitest
//            related`), plus every test that reads files outside its import
//            graph (fs reads, child processes, globs), which imports cannot
//            reveal. A deleted or renamed JS module runs the whole suite.
//   Format - prettier on the changed files only (it is file-local).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planCheck } from './check-scoped/plan-check.mjs';
import {
  appGlobs,
  cargoPackages,
  changedFiles,
  fsReadingTests,
  rustExternalInputs,
  strictClosure,
} from './check-scoped/repo-inputs.mjs';
import { commandsFor, DIFFERENTIAL } from './check-scoped/step-commands.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function main() {
  const argv = process.argv.slice(2);
  const planOnly = argv.includes('--plan');
  const baseRef = process.env.FUTO_CHECK_BASE || 'origin/main';
  const t0 = Date.now();

  const diff = changedFiles(ROOT, baseRef);
  const packages = cargoPackages(ROOT);
  const rust = { packages, inputs: rustExternalInputs(ROOT, packages) };
  const forced = argv.includes('--full') ? 'requested with --full' : null;
  const plan = planCheck({
    changed: diff.changed ?? [],
    rust,
    differentialInputs: strictClosure(ROOT, DIFFERENTIAL),
    globs: appGlobs(ROOT),
    full: forced ?? diff.error ?? null,
  });
  const fsTests = fsReadingTests(ROOT);

  const head = diff.base
    ? `${diff.changed.length} changed file(s) vs ${baseRef} (merge-base ${diff.base.slice(0, 9)})`
    : diff.error;
  console.log(`\n==> check: ${head}`);
  console.log(
    plan.full ? `    FULL run: ${plan.full}` : '    scoped run (`just check-full` runs everything)',
  );
  for (const s of plan.steps) {
    console.log(`    ${s.run ? 'RUN ' : 'skip'}  ${s.id.padEnd(17)} ${s.why}`);
  }
  console.log(`    planned in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  if (planOnly) return;

  fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
  const timings = [];
  for (const step of plan.steps.filter((s) => s.run)) {
    const started = Date.now();
    console.log(`==> ${step.id}`);
    for (const [cmd, args] of commandsFor(step, fsTests)) {
      const result = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
      if (result.status !== 0) {
        console.error(`\ncheck FAILED at ${step.id}: ${cmd} ${args.slice(0, 6).join(' ')}`);
        process.exit(result.status || 1);
      }
    }
    timings.push(`${step.id} ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }
  const mode = plan.full ? 'full' : 'scoped';
  console.log(
    `\ncheck green (${mode}, ${((Date.now() - t0) / 1000).toFixed(0)}s): ${timings.join(' · ')}`,
  );
}

if (import.meta.main) main();
