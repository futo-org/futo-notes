// `just journal` is how anyone — human or agent — reads what a running instance
// actually did, so its arithmetic has to be right: a launch-relative number that
// silently drifts would send an investigation the wrong way.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'journal.mjs');

let directory;

function line(ts, type, data) {
  return JSON.stringify({ v: 1, ts, type, data });
}

function launch(ts, version = '1.2.3') {
  return line(ts, 'app_launch', { version, identifier: 'com.futo.notes.dev' });
}

// A cycle is journaled when it FINISHES, so a run that started 500ms after
// launch and took 200ms is recorded at launch + 700ms.
function syncRun(ts, { trigger = 'manual', totalMs = 0, outcome = 'ok' } = {}) {
  return line(ts, 'sync_run', {
    trigger,
    outcome,
    phases: { bootstrap_ms: 0, push_ms: 0, pull_ms: 0, total_ms: totalMs },
    counts: {},
    watermarks: {
      before: { max_version: 0, pull_cursor: 0, tracked_objects: 0, oversize_skipped: 0 },
      after: { max_version: 0, pull_cursor: 0, tracked_objects: 0, oversize_skipped: 0 },
    },
    decisions: [],
  });
}

function writeJournal(lines) {
  writeFileSync(join(directory, 'journal-0001.jsonl'), lines.join('\n') + '\n');
}

function run(...args) {
  return execFileSync('node', [SCRIPT, ...args, '--dir', directory], { encoding: 'utf8' });
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'futo-journal-test-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('just journal startup', () => {
  it('reports each launch and how long after it that session first synced', () => {
    writeJournal([
      launch(1_000_000),
      syncRun(1_000_700, { trigger: 'manual', totalMs: 200 }),
      syncRun(1_005_000, { trigger: 'safety_poll', totalMs: 50 }),
      launch(2_000_000, '1.2.4'),
      syncRun(2_000_400, { trigger: 'live_catch_up', totalMs: 100 }),
    ]);

    const rows = run('startup', '--json')
      .trim()
      .split('\n')
      .map((row) => JSON.parse(row));

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      version: '1.2.3',
      first_sync_after_ms: 500,
      first_sync_trigger: 'manual',
      first_sync_total_ms: 200,
    });
    // The second session's row must not adopt the first session's runs.
    expect(rows[1]).toMatchObject({
      version: '1.2.4',
      first_sync_after_ms: 300,
      first_sync_trigger: 'live_catch_up',
    });
  });

  it('says so when a session journaled no sync run at all', () => {
    writeJournal([launch(1_000_000)]);

    const rows = run('startup', '--json')
      .trim()
      .split('\n')
      .map((row) => JSON.parse(row));

    expect(rows).toHaveLength(1);
    expect(rows[0].first_sync_after_ms).toBeNull();
    expect(run('startup')).toContain('none journaled in this session');
  });

  it('stays readable against a ring written before the launch marker existed', () => {
    writeJournal([syncRun(1_000_700, { totalMs: 200 })]);

    expect(run('startup')).toContain('No launches journaled yet');
    // last-sync must still work; it just cannot show a launch-relative number.
    expect(run('last-sync')).not.toContain('after app launch');
  });
});

describe('just journal last-sync', () => {
  it('reports the newest run against the launch it belongs to', () => {
    writeJournal([
      launch(1_000_000),
      syncRun(1_000_700, { totalMs: 200 }),
      syncRun(1_005_000, { trigger: 'safety_poll', totalMs: 50 }),
    ]);

    expect(run('last-sync')).toContain('+4950ms after app launch');
  });
});
