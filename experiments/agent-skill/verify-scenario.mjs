#!/usr/bin/env node
/**
 * Prove a built scenario is actually broken before anyone runs an agent at it.
 *
 *   node verify-scenario.mjs [<scenario-id>] [--arm baseline|treatment]
 *
 * A scenario whose withheld test passes against the broken tree is not a
 * scenario: the revert missed, or the test never covered the bug. Either way a
 * run against it measures nothing, and sixty of those is a wasted afternoon.
 * This is the red-proof, the same discipline the repo asks of a bug fix.
 *
 * Scenarios with no withheld test (a purely visual bug) cannot be proved this
 * way and are reported as such rather than silently passing.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWithheldTests, scenarioDir } from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(here, '../..');
const flags = process.argv.slice(2);
const arm = flags.includes('--arm') ? flags[flags.indexOf('--arm') + 1] : 'baseline';
const only = flags.find((f) => !f.startsWith('--') && f !== arm);

const scenarios = JSON.parse(readFileSync(join(here, 'scenarios.json'), 'utf8')).filter(
  (s) => !only || s.id === only,
);

let failures = 0;
for (const scenario of scenarios) {
  let outDir;
  try {
    outDir = scenarioDir(join(here, 'work'), scenario.id, arm);
  } catch {
    console.log(`${scenario.id}: NOT BUILT`);
    failures += 1;
    continue;
  }
  const repoDir = join(outDir, 'repo');
  if (!existsSync(join(repoDir, 'node_modules'))) {
    execFileSync('cp', ['-Rc', join(sourceRoot, 'node_modules'), join(repoDir, 'node_modules')]);
  }
  mkdirSync(join(repoDir, 'dist'), { recursive: true });

  const answer = JSON.parse(readFileSync(join(outDir, 'answer/answer.json'), 'utf8'));
  if (!answer.withheldTests.length) {
    console.log(`${scenario.id}: no withheld test — grade by diff overlap and the model only`);
    continue;
  }

  const results = runWithheldTests(repoDir, join(outDir, 'answer'), answer.withheldTests);
  // Red-proof: at least one withheld test must FAIL, or the bug is not live.
  const anyFailed = results.some((r) => r.passed === false);
  console.log(
    `${scenario.id}: ${anyFailed ? 'RED (bug is live)' : 'GREEN — NOT BROKEN, unusable'}\n` +
      results.map((r) => `    ${r.passed === false ? 'fails' : 'passes'}  ${r.path}`).join('\n'),
  );
  if (!anyFailed) failures += 1;
}

process.exit(failures ? 1 : 0);
