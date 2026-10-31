#!/usr/bin/env node
// Opt-in native reconnaissance on an explicitly claimed physical phone.
// AGP's connected-test installer adds -d and normally uninstalls afterward.
// Build normally, then use preserving install -r and the existing result contract.
import { spawnSync } from 'node:child_process';
import console from 'node:console';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseInstrumentationResult } from './android-native32.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = 'com.futo.notes.dev';
const CLASS = 'com.futo.notes.editor.NativeEditorPerformanceReconTest';
const METHOD = 'recordProtectedNativeCallsAndExplicitFlushes';

export function reconMode(args) {
  if (args.length === 0) return 'full';
  if (args.length === 1 && args[0] === '--bounded-followup') return 'bounded-followup';
  if (args.length === 1 && args[0] === '--post-fix-checkpoint') return 'post-fix-checkpoint';
  throw new Error(
    'Only --bounded-followup or --post-fix-checkpoint is supported; the full default is unchanged',
  );
}

export function assertReconApks(app, tests, manifestTree) {
  if (
    !/^package: name='com\.futo\.notes\.dev' /m.test(app) ||
    !/^application-debuggable\s*$/m.test(app) ||
    !/^package: name='com\.futo\.notes\.dev\.test'/m.test(tests)
  )
    throw new Error('Expected only the dev debug app and its exact test runner');
  // badging omits instrumentation; inspect only direct attributes of its XML-tree node.
  const lines = manifestTree.split(/\r?\n/);
  const nodes = lines.flatMap((line, index) => {
    const found = line.match(/^( *)E: instrumentation\b/);
    return found ? [{ index, depth: found[1].length }] : [];
  });
  if (nodes.length !== 1) throw new Error('Expected exactly one compiled instrumentation node');
  const { index, depth } = nodes[0];
  const attributes = [];
  const prefix = `${' '.repeat(depth + 2)}A: http://schemas.android.com/apk/res/android:`;
  for (const line of lines.slice(index + 1)) {
    if (line.trim() && line.match(/^ */)[0].length <= depth) break;
    if (!line.startsWith(prefix)) continue;
    const found = line.slice(prefix.length).match(/^(name|targetPackage)\(0x[0-9a-f]+\)="([^"]*)"/);
    if (found) attributes.push([found[1], found[2]]);
  }
  const fields = Object.fromEntries(attributes);
  if (
    attributes.length !== 2 ||
    fields.name !== 'androidx.test.runner.AndroidJUnitRunner' ||
    fields.targetPackage !== 'com.futo.notes.dev'
  )
    throw new Error('Compiled instrumentation must run only the exact dev target');
}

export function validateReconReport(report, runId, mode = 'full') {
  if (
    report.formatVersion !== 1 ||
    report.runId !== runId ||
    !Array.isArray(report.fixtures) ||
    (report.probeMode ?? 'full') !== mode
  )
    throw new Error('Probe report identity/format does not match this run');
  const bounded = mode === 'bounded-followup';
  const checkpoint = mode === 'post-fix-checkpoint';
  const samples = bounded || checkpoint ? 4 : 100;
  const pairs = bounded || checkpoint ? 2 : 20;
  const checkpointOrder = [
    '20000-items-single-list',
    '20000-lines-paragraphs',
    '20000-lines-single-paragraph',
    '20000-code-lines-single-fence',
  ];
  if (
    report.outcome === 'completed' &&
    (report.fixtures.length !== (bounded ? 1 : 4) ||
      (bounded && report.fixtures[0]?.fixture !== '20000-code-lines-single-fence') ||
      (bounded && report.projectionDiagnostic?.pairs?.length !== 3) ||
      (checkpoint &&
        report.fixtures.some((fixture, index) => fixture.fixture !== checkpointOrder[index])) ||
      report.fixtures.some(
        (fixture) =>
          fixture.warmTypingNs?.length !== samples ||
          fixture.firstKeyAfterJumpNs?.length !== samples ||
          fixture.jumpSelectionNs?.length !== samples ||
          fixture.pairedAppendNs?.length !== pairs ||
          fixture.pairedExplicitFlushNs?.length !== pairs ||
          fixture.appendThroughExplicitFlushNs?.length !== pairs ||
          (checkpoint &&
            (fixture.flushes?.length !== 5 ||
              fixture.returnedProjections?.length !== 5 ||
              fixture.flushes.some(
                (flush, index) =>
                  flush.accepted !== flush.durable ||
                  !(flush.accepted > flush.previousDurable) ||
                  !Number.isSafeInteger(flush.lastFlushLatenessNs) ||
                  flush.lastFlushLatenessNs < 0 ||
                  flush.immediateAfterOneAppend !== (index === 0 || index >= 3),
              ))),
      ))
  )
    throw new Error('Completed probe does not contain all requested samples');
}

function main() {
  const mode = reconMode(process.argv.slice(2));
  const serial = process.env.ANDROID_SERIAL;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(serial ?? '') || serial.startsWith('emulator-'))
    throw new Error('Select an explicitly claimed physical Android phone');
  const out = mkdtempSync(path.join(tmpdir(), 'futo-android-performance-recon-'));
  console.log(`Reconnaissance evidence: ${out}`);
  let sequence = 0;
  const run = (command, args, visible = true) => {
    console.log(`==> ${JSON.stringify([command, ...args])}`);
    const result = spawnSync(command, args, {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 180_000,
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    writeFileSync(path.join(out, `${++sequence}.log`), output);
    if (visible) process.stdout.write(output);
    if (result.error || result.status !== 0)
      throw result.error ?? new Error(`${command} exited ${result.status}`);
    return output;
  };
  const adb = (...args) => {
    run('just', ['qa-android-target']);
    return run('adb', ['-s', serial, ...args]);
  };
  const app = path.join(
    ROOT,
    'apps/android/app/build/outputs/apk/direct/debug/app-direct-debug.apk',
  );
  const tests = path.join(
    ROOT,
    'apps/android/app/build/outputs/apk/androidTest/direct/debug/app-direct-debug-androidTest.apk',
  );
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!sdk) throw new Error('ANDROID_HOME is required for APK manifest verification');
  const tools = path.join(sdk, 'build-tools');
  const version = readdirSync(tools)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .find((entry) => existsSync(path.join(tools, entry, 'aapt2')));
  if (!version) throw new Error('Android build-tools aapt2 is missing');
  const aapt = path.join(tools, version, 'aapt2');
  assertReconApks(
    run(aapt, ['dump', 'badging', app], false),
    run(aapt, ['dump', 'badging', tests], false),
    run(aapt, ['dump', 'xmltree', '--file', 'AndroidManifest.xml', tests], false),
  );
  const entries = run('unzip', ['-Z1', app], false).split(/\r?\n/);
  for (const abi of ['arm64-v8a', 'armeabi-v7a', 'x86_64', 'x86'])
    if (!entries.includes(`lib/${abi}/libfuto_notes_ffi.so`)) throw new Error(`APK missing ${abi}`);
  const digest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
  const receipt = {
    source: run('git', ['rev-parse', 'HEAD']).trim(),
    serial,
    appSha256: digest(app),
    testSha256: digest(tests),
    reports: [],
  };
  adb('install', '-r', app);
  adb('install', '-r', '-t', tests);
  run('just', ['qa-android-apk', app]);
  adb('shell', 'dumpsys', 'battery');
  adb('shell', 'dumpsys', 'thermalservice');
  const runId = randomUUID();
  receipt.runId = runId;
  receipt.probeMode = mode;
  let nativeError;
  try {
    const output = adb(
      'shell',
      'am',
      'instrument',
      '-w',
      '-r',
      '-e',
      'class',
      CLASS,
      '-e',
      'editorPerformanceRecon',
      'true',
      '-e',
      'editorPerformanceRunId',
      runId,
      '-e',
      'editorPerformanceMode',
      mode,
      `${PACKAGE}.test/androidx.test.runner.AndroidJUnitRunner`,
    );
    parseInstrumentationResult(output, CLASS, [METHOD]);
  } catch (error) {
    nativeError = error;
  }
  // The host knows the exact run-owned filename even if native output/transport fails.
  try {
    const name = `editor-perf-recon-${runId}.json`;
    const raw = adb('exec-out', 'run-as', PACKAGE, 'cat', `cache/${name}`);
    writeFileSync(path.join(out, name), raw);
    const report = JSON.parse(raw);
    validateReconReport(report, runId, mode);
    receipt.reports.push({
      file: name,
      sha256: createHash('sha256').update(raw).digest('hex'),
      outcome: report.outcome,
    });
    if (report.outcome !== 'completed')
      nativeError ??= new Error(`Probe ${report.outcome}; partial raw report retained`);
  } catch (error) {
    receipt.retrievalFailure = String(error);
    nativeError ??= error;
  }
  try {
    adb('shell', 'dumpsys', 'battery');
    adb('shell', 'dumpsys', 'thermalservice');
    run('just', ['qa-android-apk', app]);
    if (digest(app) !== receipt.appSha256 || digest(tests) !== receipt.testSha256)
      throw new Error('Built APK changed during the probe');
  } catch (error) {
    receipt.postcheckFailure = String(error);
    nativeError ??= error;
  }
  if (nativeError) receipt.nativeFailure = String(nativeError);
  writeFileSync(path.join(out, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  if (nativeError) throw nativeError;
  console.log(`Reconnaissance completed: 1 passed, 0 skipped; ${out}/receipt.json`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
