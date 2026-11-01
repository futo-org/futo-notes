import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  assertReconApks,
  validateReconReport,
  reconMode,
  reconSelection,
} from './android-performance-recon.mjs';

it('accepts only the explicit bounded modes and leaves the full default intact', () => {
  expect(reconMode([])).toBe('full');
  expect(reconMode(['--bounded-followup'])).toBe('bounded-followup');
  expect(reconMode(['--post-fix-checkpoint'])).toBe('post-fix-checkpoint');
  expect(() => reconMode(['--samples=1000'])).toThrow();
  expect(() => reconMode(['--bounded-followup', '--extra'])).toThrow();
});

it('selects exactly one method for every recon mode, including the finite bounded checkpoint', () => {
  const old =
    'com.futo.notes.editor.NativeEditorPerformanceReconTest#recordProtectedNativeCallsAndExplicitFlushes';
  for (const mode of ['full', 'bounded-followup', 'post-fix-checkpoint'])
    expect(reconSelection(mode).selector).toBe(old);
  expect(reconMode(['--finite-bounded-checkpoint'])).toBe('finite-bounded-checkpoint');
  expect(reconSelection('finite-bounded-checkpoint')).toEqual({
    selector:
      'com.futo.notes.editor.NativeEditorPerformanceReconTest#recordFiniteBoundedCallsAndExplicitFlushes',
    method: 'recordFiniteBoundedCallsAndExplicitFlushes',
  });
});

const app = "package: name='com.futo.notes.dev' versionCode='1'\napplication-debuggable\n";
const tests = "package: name='com.futo.notes.dev.test'\napplication-debuggable\n";
// Actual compiled-test APK aapt2 xmltree fields; badging does not list instrumentation.
const tree = `N: android=http://schemas.android.com/apk/res/android (line=2)
  E: manifest (line=2)
    A: package="com.futo.notes.dev.test" (Raw: "com.futo.notes.dev.test")
      E: instrumentation (line=9)
        A: http://schemas.android.com/apk/res/android:label(0x01010001)="Tests for com.futo.notes.dev" (Raw: "Tests for com.futo.notes.dev")
        A: http://schemas.android.com/apk/res/android:name(0x01010003)="androidx.test.runner.AndroidJUnitRunner" (Raw: "androidx.test.runner.AndroidJUnitRunner")
        A: http://schemas.android.com/apk/res/android:targetPackage(0x01010021)="com.futo.notes.dev" (Raw: "com.futo.notes.dev")
      E: application (line=24)
        A: http://schemas.android.com/apk/res/android:debuggable(0x0101000f)=true
`;

it('requires the dev debug app and its exact instrumentation target before install', () => {
  expect(() => assertReconApks(app, tests, tree)).not.toThrow();
  expect(() =>
    assertReconApks(app.replace('com.futo.notes.dev', 'com.futo.notes'), tests, tree),
  ).toThrow();
  expect(() => assertReconApks(app.replace('application-debuggable', ''), tests, tree)).toThrow();
  expect(() =>
    assertReconApks(
      app,
      tests,
      tree.replace(
        ':targetPackage(0x01010021)="com.futo.notes.dev"',
        ':targetPackage(0x01010021)="com.futo.notes"',
      ),
    ),
  ).toThrow();
});

it('does not borrow an instrumentation target from a different XML element', () => {
  const misplaced =
    tree.replace(':targetPackage(0x01010021)', ':otherAttribute(0x01010021)') +
    '        A: http://schemas.android.com/apk/res/android:targetPackage(0x01010021)="com.futo.notes.dev"\n';
  expect(() => assertReconApks(app, tests, misplaced)).toThrow();
  expect(() => assertReconApks(app, tests, `${tree}${tree}`)).toThrow();
});

it('matches reports to the host UUID and rejects incomplete successful sample sets', () => {
  const partial = { formatVersion: 1, runId: 'owned-run', outcome: 'failed', fixtures: [] };
  expect(() => validateReconReport(partial, 'owned-run')).not.toThrow();
  expect(() => validateReconReport(partial, 'foreign-run')).toThrow();
  expect(() => validateReconReport({ ...partial, outcome: 'completed' }, 'owned-run')).toThrow();
});

it('requires the exact bounded followup sample sets and three projection pairs', () => {
  const fixture = {
    fixture: '20000-code-lines-single-fence',
    warmTypingNs: [1, 2, 3, 4],
    firstKeyAfterJumpNs: [1, 2, 3, 4],
    jumpSelectionNs: [1, 2, 3, 4],
    pairedAppendNs: [1, 2],
    pairedExplicitFlushNs: [1, 2],
    appendThroughExplicitFlushNs: [1, 2],
  };
  const report = {
    formatVersion: 1,
    runId: 'owned-run',
    probeMode: 'bounded-followup',
    outcome: 'completed',
    fixtures: [fixture],
    projectionDiagnostic: { pairs: [{}, {}, {}] },
  };
  expect(() => validateReconReport(report, 'owned-run', 'bounded-followup')).not.toThrow();
  expect(() => validateReconReport(report, 'owned-run')).toThrow();
  expect(() =>
    validateReconReport(
      { ...report, fixtures: [{ ...fixture, fixture: '20000-items-single-list' }] },
      'owned-run',
      'bounded-followup',
    ),
  ).toThrow();
  expect(() =>
    validateReconReport({ ...report, fixtures: [] }, 'owned-run', 'bounded-followup'),
  ).toThrow();
  expect(() =>
    validateReconReport(
      { ...report, projectionDiagnostic: { pairs: [{}] } },
      'owned-run',
      'bounded-followup',
    ),
  ).toThrow();
});

it('requires the small list-first checkpoint and fresh immediate/batch flush feedback', () => {
  const fixture = {
    warmTypingNs: [1, 2, 3, 4],
    firstKeyAfterJumpNs: [1, 2, 3, 4],
    jumpSelectionNs: [1, 2, 3, 4],
    pairedAppendNs: [1, 2],
    pairedExplicitFlushNs: [1, 2],
    appendThroughExplicitFlushNs: [1, 2],
    returnedProjections: [{}, {}, {}, {}, {}],
    flushes: [1, 5, 9, 10, 11].map((revision, index) => ({
      previousDurable: [0, 1, 5, 9, 10][index],
      accepted: revision,
      durable: revision,
      lastFlushLatenessNs: index,
      immediateAfterOneAppend: index === 0 || index >= 3,
    })),
  };
  const report = {
    formatVersion: 1,
    runId: 'owned-run',
    probeMode: 'post-fix-checkpoint',
    outcome: 'completed',
    fixtures: [
      '20000-items-single-list',
      '20000-lines-paragraphs',
      '20000-lines-single-paragraph',
      '20000-code-lines-single-fence',
    ].map((name) => ({ ...fixture, fixture: name })),
  };
  const validate = (value) => validateReconReport(value, 'owned-run', 'post-fix-checkpoint');
  expect(() => validate(report)).not.toThrow();
  expect(() => validate({ ...report, fixtures: [...report.fixtures].reverse() })).toThrow();
  const stale = JSON.parse(JSON.stringify(report));
  stale.fixtures[0].flushes[0].previousDurable = 1;
  expect(() => validate(stale)).toThrow();
  const missingClock = JSON.parse(JSON.stringify(report));
  delete missingClock.fixtures[0].flushes[0].lastFlushLatenessNs;
  expect(() => validate(missingClock)).toThrow();
});

it('validates finite bounded phases separately and retains partial failures', () => {
  const fixture = (name, suffix) => ({
    fixture: name,
    createNs: [1],
    openNs: [1],
    entryPreparationNs: [1],
    coldFirstAppendNs: [2],
    coldImmediateExplicitFlushNs: [3],
    warmTypingNs: Array(20).fill(4),
    warmBatchExplicitFlushNs: [5],
    jumpSelectionNs: Array(20).fill(6),
    firstKeyAfterJumpNs: Array(20).fill(7),
    jumpBatchExplicitFlushNs: [8],
    pairedAppendNs: Array(10).fill(9),
    pairedExplicitFlushNs: Array(10).fill(10),
    appendThroughExplicitFlushNs: Array(10).fill(20),
    acceptedSourceCopyNs: [11],
    fullMaterializationNs: [12],
    acceptedRevisions: Array.from({ length: suffix ? 53 : 51 }, (_, i) => i + 1),
    flushes: [1, 21, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, ...(suffix ? [53] : [])].map(
      (revision, i, revisions) => ({
        previousDurable: revisions[i - 1] ?? 0,
        accepted: revision,
        durable: revision,
        paused: false,
        lastFlushLatenessNs: 0,
        remainingDelayNs: i >= 3 && i < 13 ? null : 1,
        remainingDelayObservation:
          i >= 3 && i < 13
            ? 'not queried inside append-through-flush timer'
            : 'before explicit flush',
      }),
    ),
    ...(suffix
      ? {
          removeCloserNs: [13],
          firstFarUnitSelectionNs: [14],
          firstFarUnitKeyNs: [15],
          continuationNs: [16, 17],
          continuationFrameCount: 2,
          continuationCompletionNs: [40],
          frontierBatchExplicitFlushNs: [18],
        }
      : {}),
  });
  const report = {
    formatVersion: 1,
    runId: 'owned-run',
    probeMode: 'finite-bounded-checkpoint',
    outcome: 'completed',
    fixtures: [
      fixture('20000-code-lines-single-fence', false),
      fixture('short-fence-20000-lines-independent-paragraphs', true),
    ],
  };
  const validate = (value) => validateReconReport(value, 'owned-run', 'finite-bounded-checkpoint');
  expect(() => validate(report)).not.toThrow();
  const missing = structuredClone(report);
  missing.fixtures[0].warmTypingNs.pop();
  expect(() => validate(missing)).toThrow();
  const stale = structuredClone(report);
  stale.fixtures[1].flushes[13].paused = true;
  expect(() => validate(stale)).toThrow();
  const lostRevision = structuredClone(report);
  lostRevision.fixtures[0].acceptedRevisions[30] = 32;
  expect(() => validate(lostRevision)).toThrow();
  const unfinished = structuredClone(report);
  unfinished.fixtures[1].continuationFrameCount = 3;
  expect(() => validate(unfinished)).toThrow();
  expect(() => validate({ ...missing, outcome: 'budget-limited' })).not.toThrow();
});

it('retains a partial raw report and original command failure when instrumentation exits nonzero', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'recon-route-test-'));
  try {
    const output = path.join(scratch, 'output');
    mkdirSync(output);
    const loader = path.join(scratch, 'fake-tools.cjs');
    writeFileSync(
      loader,
      `
const fs = require('node:fs');
const cp = require('node:child_process');
const crypto = require('node:crypto');
crypto.randomUUID = () => '00000000-0000-0000-0000-000000000001';
const { syncBuiltinESMExports } = require('node:module');
const output = ${JSON.stringify(output)};
const trace = ${JSON.stringify(path.join(scratch, 'trace.jsonl'))};
const read = fs.readFileSync, exists = fs.existsSync, list = fs.readdirSync;
fs.mkdtempSync = () => output;
fs.readFileSync = (p, ...args) => String(p).endsWith('.apk') ? Buffer.from('fake-apk') : read(p, ...args);
fs.existsSync = (p) => String(p).endsWith('/aapt2') || exists(p);
fs.readdirSync = (p, ...args) => String(p).endsWith('/build-tools') ? ['37.0.0'] : list(p, ...args);
cp.spawnSync = (command, args) => {
  fs.appendFileSync(trace, JSON.stringify([command, ...args])+'\\n');
  let stdout = '';
  let status = 0;
  if (command.endsWith('aapt2')) stdout = args.includes('xmltree') ? ${JSON.stringify(tree)} : args.at(-1).endsWith('androidTest.apk') ? ${JSON.stringify(tests)} : ${JSON.stringify(app)};
  if (command === 'unzip') stdout = ['arm64-v8a','armeabi-v7a','x86_64','x86'].map(a => 'lib/'+a+'/libfuto_notes_ffi.so').join('\\n');
  if (command === 'git') stdout = 'fixture-source\\n';
  if (command === 'adb') {
    if (args.includes('date')) stdout = '100\\n';
    if (args.includes('instrument')) { status = 1; stdout = 'instrumentation transport failed\\n'; }
    if (args.includes('logcat')) stdout = '101 123 456 I System.out: EDITOR_PERF_RECON_REPORT=/data/user/0/com.futo.notes.dev/cache/editor-perf-recon-00000000-0000-0000-0000-000000000001.json\\n';
    if (args.includes('exec-out')) stdout = JSON.stringify({formatVersion:1,runId:'00000000-0000-0000-0000-000000000001',outcome:'failed',fixtures:[{warmTypingNs:[12,34]}]});
  }
  return {status, stdout, stderr:''};
};
syncBuiltinESMExports();
`,
    );
    const result = spawnSync(
      process.execPath,
      ['--import', loader, path.resolve('scripts/android-performance-recon.mjs')],
      {
        env: {
          ...process.env,
          ANDROID_SERIAL: 'claimed-phone',
          ANDROID_HOME: path.join(scratch, 'sdk'),
        },
        encoding: 'utf8',
      },
    );
    expect(result.status).toBe(1);
    const raw = JSON.parse(
      readFileSync(
        path.join(output, 'editor-perf-recon-00000000-0000-0000-0000-000000000001.json'),
        'utf8',
      ),
    );
    expect(raw.fixtures[0].warmTypingNs).toEqual([12, 34]);
    const receipt = JSON.parse(readFileSync(path.join(output, 'receipt.json'), 'utf8'));
    expect(receipt.nativeFailure).toContain('adb exited 1');
    const calls = readFileSync(path.join(scratch, 'trace.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse);
    expect(calls.find((call) => call.includes('instrument'))).toContain(
      'com.futo.notes.editor.NativeEditorPerformanceReconTest#recordProtectedNativeCallsAndExplicitFlushes',
    );
    for (const [index, call] of calls.entries()) {
      if (call[0] === 'adb') expect(calls[index - 1]).toEqual(['just', 'qa-android-target']);
      if (call.includes('install')) expect(call).not.toContain('-d');
      expect(call).not.toContain('uninstall');
      expect(call).not.toContain('clear');
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
