#!/usr/bin/env node
// Query the desktop instance journal (docs/plan/agentic-first.md §3.3).
//
// The journal is JSONL written by futo_notes_core::journal — one event per
// line, `{"v","ts","type","data"}` — under the app data dir, never inside a
// vault. This reads it; nothing here writes or deletes.
//
// Node-only by design: no dependencies, so it runs from any checkout without
// an install step, and `jq` stays a first-class alternative (`cat <dir>/*.jsonl
// | jq …` answers anything this cannot).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const USAGE = `Usage: just journal [command] [options]

Commands:
  tail [N]            the last N events (default 20), oldest first
  type <name>         only events of one type (e.g. sync_run, journal_drops)
  last-sync           a readable summary of the most recent sync run
  where               print the journal directory this would read

Options:
  --dir <path>        read this journal directory instead of resolving one
  --release           resolve the release app's journal, not the dev build's
  --json              print raw JSONL lines instead of a formatted view
`;

// Mirrors the desktop resolution in apps/tauri/src-tauri/src/instance_journal.rs:
// $FUTO_NOTES_DATA_DIR wins (that is what `just tauri-dev` sets, per worktree),
// then the platform app-data dir under the build's bundle identifier.
function appDataRoots({ release }) {
  const fromEnvironment = process.env.FUTO_NOTES_DATA_DIR;
  if (fromEnvironment) return [fromEnvironment];

  const roots = [];
  const worktreeDataDir = repoRoot() && join(repoRoot(), '.tauri-data');
  if (worktreeDataDir) roots.push(worktreeDataDir);

  const identifiers = release
    ? ['com.futo.notes']
    : [devWorktreeIdentifier(), 'com.futo.notes.dev', 'com.futo.notes'].filter(Boolean);
  const base =
    platform() === 'darwin'
      ? join(homedir(), 'Library', 'Application Support')
      : join(homedir(), '.local', 'share');
  roots.push(...identifiers.map((identifier) => join(base, identifier)));
  return roots;
}

function repoRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

// `just tauri-dev` gives each worktree its own bundle id (scripts/tauri-dev.mjs
// derives the same slot); recompute it so this finds that instance's journal.
function devWorktreeIdentifier() {
  const root = repoRoot();
  if (!root) return null;
  const slot = parseInt(createHash('md5').update(root).digest('hex').slice(0, 8), 16) % 50;
  return `com.futo.notes.dev.wt${slot}`;
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function resolveJournalDir(options) {
  if (options.dir) return options.dir;
  const candidates = appDataRoots(options).map((root) => join(root, 'journal'));
  const found = candidates.find(isDirectory);
  if (found) return found;
  console.error('No journal directory found. Looked in:');
  for (const candidate of candidates) console.error(`  ${candidate}`);
  console.error('\nThe desktop app writes one on startup; run `just tauri-dev` once,');
  console.error('or pass --dir <path> if the journal lives somewhere else.');
  process.exit(1);
}

function readEvents(directory) {
  const segments = readdirSync(directory)
    .filter((name) => /^journal-\d+\.jsonl$/.test(name))
    .sort();
  const events = [];
  for (const segment of segments) {
    for (const line of readFileSync(join(directory, segment), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push({ line, event: JSON.parse(line) });
      } catch {
        // A torn final line after a crash must not hide the rest.
      }
    }
  }
  return events;
}

function formatEvent({ event }) {
  const when = new Date(event.ts).toISOString().replace('T', ' ').replace('Z', '');
  return `${when}  ${event.type}  ${JSON.stringify(event.data)}`;
}

function printEvents(events, options) {
  for (const entry of events) console.log(options.json ? entry.line : formatEvent(entry));
}

function printLastSyncRun(events) {
  const runs = events.filter(({ event }) => event.type === 'sync_run');
  const last = runs[runs.length - 1];
  if (!last) {
    console.log('No sync runs journaled yet.');
    return;
  }
  const run = last.event.data;
  console.log(`sync run at ${new Date(last.event.ts).toISOString()}`);
  console.log(`  trigger:    ${run.trigger}`);
  console.log(`  outcome:    ${run.outcome}${run.error ? ` — ${run.error}` : ''}`);
  console.log(
    `  phases:     bootstrap ${run.phases.bootstrap_ms}ms, push ${run.phases.push_ms}ms, ` +
      `pull ${run.phases.pull_ms}ms, total ${run.phases.total_ms}ms`,
  );
  console.log(`  counts:     ${JSON.stringify(run.counts)}`);
  console.log(`  before:     ${JSON.stringify(run.watermarks.before)}`);
  console.log(`  after:      ${JSON.stringify(run.watermarks.after)}`);
  const decisions = run.decisions ?? [];
  console.log(`  decisions:  ${decisions.length}`);
  for (const decision of decisions) {
    const detail = decision.detail ? ` → ${decision.detail}` : '';
    console.log(
      `    [${decision.phase}] ${decision.filename}: ${decision.decision} (${decision.reason})${detail}`,
    );
  }
  console.log(`  total runs journaled: ${runs.length}`);
}

function parseArguments(argv) {
  const options = { json: false, release: false, dir: null };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') options.json = true;
    else if (argument === '--release') options.release = true;
    else if (argument === '--dir') options.dir = argv[(index += 1)];
    else if (argument === '-h' || argument === '--help') options.help = true;
    else positional.push(argument);
  }
  return { options, positional };
}

const { options, positional } = parseArguments(process.argv.slice(2));
if (options.help) {
  console.log(USAGE);
  process.exit(0);
}

const [command = 'tail', argument] = positional;
const directory = resolveJournalDir(options);

if (command === 'where') {
  console.log(directory);
} else if (command === 'tail') {
  const count = Number.parseInt(argument ?? '20', 10);
  printEvents(readEvents(directory).slice(-count), options);
} else if (command === 'type') {
  if (!argument) {
    console.error('`just journal type` needs an event type, e.g. sync_run.');
    process.exit(1);
  }
  printEvents(
    readEvents(directory).filter(({ event }) => event.type === argument),
    options,
  );
} else if (command === 'last-sync') {
  printLastSyncRun(readEvents(directory));
} else {
  console.error(`Unknown command: ${command}\n`);
  console.error(USAGE);
  process.exit(1);
}
