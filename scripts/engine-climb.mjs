#!/usr/bin/env node
// Engine hill-climb queue. Each attempt at making the editor engine faster is
// pushed to its own `engine-climb/<name>` branch; CI runs `bench:engine-keys`
// for it on the one-job-at-a-time runner (futo_notes_serial), so attempts
// queue instead of sharing a machine, and none cancels another (separate
// branches, non-interruptible job, no auto-cancel on climb branches).
//
//   node scripts/engine-climb.mjs push <name> [--base <rev>]   queue HEAD as an attempt
//   node scripts/engine-climb.mjs results [name-prefix]        print each attempt's verdict
//   node scripts/engine-climb.mjs ci                            (the CI job itself)
//   node scripts/engine-climb.mjs compare <base.json> <cand.json>
//
// The job builds the attempt AND its base (the commit it started from) with
// the attempt's benchmark source, runs both twice interleaved on the same
// machine, and compares. Work counters (bytes parsed, link items) are exact;
// times are only comparable within one job. Tests for the editor and store
// crates must pass or the verdict is BROKEN.
import { execFileSync, spawnSync } from 'node:child_process';
import console from 'node:console';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE_BRANCH = process.env.CLIMB_BASE_BRANCH ?? 'main';
const BENCH = 'crates/futo-notes-store/examples/editor_keys.rs';
const PROJECT = 'futo-notes%2Ffuto-notes';
const JOB = 'bench:engine-keys';
/** Rows under this p50 on the base are timer noise for a verdict. */
const MIN_ROW_NS = 200_000;

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

function sh(command, args, options = {}) {
  console.log(`$ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: ROOT, ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status}`);
}

const rows = (report) =>
  new Map(report.notes.flatMap((n) => n.actions.map((a) => [`${n.label}:${a.action}`, a])));

/** Per row, the faster of the runs (noise only adds time). */
function fastest(reports) {
  const out = new Map();
  for (const report of reports)
    for (const [key, a] of rows(report)) {
      const seen = out.get(key);
      if (!seen || (a.p50Ns ?? Infinity) < (seen.p50Ns ?? Infinity)) out.set(key, a);
    }
  return out;
}

export function compare(baseReports, candReports) {
  const base = fastest(baseReports);
  const cand = fastest(candReports);
  const lines = [];
  const ms = (ns) => (ns === undefined ? '     -' : (ns / 1e6).toFixed(2).padStart(8));
  const work = (a) =>
    a?.work ? a.work.parsedBytes + a.work.materializedBytes + a.work.linkItems : undefined;
  let logSum = 0;
  let counted = 0;
  const slower = [];
  const changedBehavior = [];
  lines.push(
    `${'note:action'.padEnd(32)} ${'base ms'.padStart(8)} ${'cand ms'.padStart(8)}  change  ${'work base'.padStart(10)} ${'work cand'.padStart(10)}`,
  );
  for (const [key, b] of base) {
    const c = cand.get(key);
    if (!c) continue;
    if ((b.refused ?? 0) !== (c.refused ?? 0) || (b.noop ?? 0) !== (c.noop ?? 0))
      changedBehavior.push(`${key}: refused ${b.refused}→${c.refused}, no-op ${b.noop}→${c.noop}`);
    let change = '';
    if (b.p50Ns && c.p50Ns) {
      const ratio = c.p50Ns / b.p50Ns;
      change = `${((ratio - 1) * 100).toFixed(0).padStart(5)}%`;
      if (b.p50Ns >= MIN_ROW_NS) {
        logSum += Math.log(ratio);
        counted++;
        if (ratio > 1.1) slower.push(`${key} ${change.trim()}`);
      }
    }
    lines.push(
      `${key.padEnd(32)} ${ms(b.p50Ns)} ${ms(c.p50Ns)}  ${change.padStart(6)}  ${String(work(b) ?? '-').padStart(10)} ${String(work(c) ?? '-').padStart(10)}`,
    );
  }
  const geomean = counted ? Math.exp(logSum / counted) : 1;
  return { lines, geomean, slower, changedBehavior };
}

function verdictLine({ geomean, slower, changedBehavior }, testsPassed) {
  if (!testsPassed) return 'BROKEN: editor/store tests failed';
  const pct = `${((geomean - 1) * 100).toFixed(1)}%`;
  const notes = [
    slower.length ? `slower rows: ${slower.join(', ')}` : '',
    changedBehavior.length ? `behavior changed: ${changedBehavior.join('; ')}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const word = geomean < 0.97 && !slower.length ? 'FASTER' : geomean > 1.03 ? 'SLOWER' : 'SAME';
  return `${word} ${pct} geomean p50 vs base${notes ? ` · ${notes}` : ''}`;
}

function ci() {
  const out = path.join(ROOT, 'engine-climb');
  mkdirSync(out, { recursive: true });
  let base = process.env.CLIMB_BASE;
  if (!base) {
    sh('git', ['fetch', '--quiet', 'origin', BASE_BRANCH]);
    base = git('merge-base', 'HEAD', 'FETCH_HEAD');
  }
  const head = git('rev-parse', 'HEAD');
  console.log(`attempt ${head.slice(0, 9)} vs base ${base.slice(0, 9)}`);
  const tests = spawnSync(
    'cargo',
    ['test', '-q', '-p', 'futo-notes-editor', '-p', 'futo-notes-store'],
    {
      cwd: ROOT,
      stdio: 'inherit',
    },
  );
  const testsPassed = tests.status === 0;
  const build = (dir) =>
    sh(
      'cargo',
      ['build', '--release', '-q', '-p', 'futo-notes-store', '--example', 'editor_keys'],
      {
        cwd: dir,
        env: { ...process.env, CARGO_TARGET_DIR: path.join(ROOT, 'target') },
      },
    );
  build(ROOT);
  const binary = path.join(ROOT, 'target/release/examples/editor_keys');
  copyFileSync(binary, path.join(out, 'editor_keys-attempt'));
  // The base measured with the attempt's benchmark, so both run the same keys.
  const baseDir = path.join(ROOT, '.engine-climb-base');
  spawnSync('git', ['worktree', 'remove', '--force', baseDir], { cwd: ROOT });
  sh('git', ['worktree', 'add', '--detach', baseDir, base]);
  copyFileSync(path.join(ROOT, BENCH), path.join(baseDir, BENCH));
  build(baseDir);
  copyFileSync(binary, path.join(out, 'editor_keys-base'));
  const keys = process.env.CLIMB_KEYS ?? '20';
  const reports = { base: [], attempt: [] };
  for (let round = 0; round < 2; round++)
    for (const side of ['base', 'attempt']) {
      const file = path.join(out, `${side}-${round}.json`);
      sh(path.join(out, `editor_keys-${side}`), ['--keys', keys, '--json', file]);
      reports[side].push(JSON.parse(readFileSync(file, 'utf8')));
    }
  const result = compare(reports.base, reports.attempt);
  const verdict = verdictLine(result, testsPassed);
  const subject = git('log', '-1', '--format=%s');
  const summary = [
    `${process.env.CI_COMMIT_BRANCH ?? 'local'} ${head.slice(0, 9)} "${subject}" vs ${base.slice(0, 9)}`,
    verdict,
    ...result.lines,
  ].join('\n');
  writeFileSync(path.join(out, 'summary.txt'), `${summary}\n`);
  console.log(`\n${summary}`);
  if (!testsPassed) process.exitCode = 1;
}

async function api(route) {
  const result = spawnSync('glab', ['api', route], { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`glab api ${route}: ${result.stderr}`);
  return result.stdout;
}

async function results(prefix = '') {
  const branches = JSON.parse(
    await api(
      `projects/${PROJECT}/repository/branches?search=^engine-climb/${encodeURIComponent(prefix)}&per_page=100`,
    ),
  );
  for (const branch of branches.sort((a, b) =>
    a.commit.committed_date.localeCompare(b.commit.committed_date),
  )) {
    const pipelines = JSON.parse(
      await api(`projects/${PROJECT}/pipelines?ref=${encodeURIComponent(branch.name)}&per_page=1`),
    );
    if (!pipelines.length) {
      console.log(`${branch.name}: no pipeline yet`);
      continue;
    }
    const jobs = JSON.parse(await api(`projects/${PROJECT}/pipelines/${pipelines[0].id}/jobs`));
    const job = jobs.find((j) => j.name === JOB);
    if (!job || job.status !== 'success') {
      console.log(`${branch.name}: ${job?.status ?? 'no job'} ${job?.web_url ?? ''}`);
      if (job?.status !== 'failed') continue;
    }
    const summary = await api(
      `projects/${PROJECT}/jobs/${job.id}/artifacts/engine-climb/summary.txt`,
    ).catch(() => '');
    console.log(summary.trim() ? `${summary.trim()}\n` : `${branch.name}: no summary\n`);
  }
}

function push(name, base) {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name ?? '')) throw new Error('push <name> (a-z0-9._-)');
  // .papercuts.jsonl collects notes from any session; it is not part of an attempt.
  if (git('status', '--porcelain', '--untracked-files=no', '--', '.', ':!.papercuts.jsonl'))
    throw new Error('commit the attempt first: the queue measures the pushed commit');
  const resolved = base
    ? git('rev-parse', base)
    : (sh('git', ['fetch', '--quiet', 'origin', BASE_BRANCH]),
      git('merge-base', 'HEAD', 'FETCH_HEAD'));
  sh('git', [
    'push',
    '--force-with-lease',
    '-o',
    `ci.variable=CLIMB_BASE=${resolved}`,
    'origin',
    `HEAD:refs/heads/engine-climb/${name}`,
  ]);
  console.log(
    `queued engine-climb/${name} vs ${resolved.slice(0, 9)}; read with: just engine-climb results ${name}`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (command === 'ci') ci();
    else if (command === 'results') await results(rest[0]);
    else if (command === 'push') {
      const at = rest.indexOf('--base');
      push(rest[0], at < 0 ? undefined : rest[at + 1]);
    } else if (command === 'compare') {
      const read = (f) => [JSON.parse(readFileSync(f, 'utf8'))];
      const result = compare(read(rest[0]), read(rest[1]));
      console.log([verdictLine(result, true), ...result.lines].join('\n'));
    } else
      throw new Error('usage: engine-climb.mjs push <name> | results [prefix] | ci | compare a b');
  } catch (error) {
    console.error(error.message ?? error);
    process.exitCode = 1;
  }
}
