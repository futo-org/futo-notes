#!/usr/bin/env node
// Release-like keystroke latency on an explicitly claimed physical phone. Installs a separate
// non-debuggable, profileable dev app (com.futo.notes.perf.dev) so the claimed dev app and its
// data are untouched, reads the report from that app's external files, then uninstalls it.
import { spawnSync } from 'node:child_process';
import console from 'node:console';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseInstrumentationResult } from './android-native32.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = 'com.futo.notes.perf.dev';
const CLASS = 'com.futo.notes.editor.NativeEditorKeystrokeLatencyTest';
const METHOD = 'measureWarmKeystrokes';
const SAMPLES = 100;

export function assertLatencyApks(app, tests) {
  if (
    !new RegExp(`^package: name='${PACKAGE.replaceAll('.', '\\.')}' `, 'm').test(app) ||
    /^application-debuggable\s*$/m.test(app) ||
    !new RegExp(`^package: name='${PACKAGE.replaceAll('.', '\\.')}\\.test'`, 'm').test(tests)
  )
    throw new Error(`Expected the non-debuggable ${PACKAGE} app and its test runner`);
}

export function validateLatencyReport(report, runId) {
  if (report.formatVersion !== 1 || report.runId !== runId || report.debuggable !== false)
    throw new Error('Latency report identity does not match this non-debuggable run');
  if (
    !Array.isArray(report.shapes) ||
    report.shapes.length === 0 ||
    report.shapes.some((shape) => shape.samples < 50 || shape.ns?.length !== shape.samples)
  )
    throw new Error('Latency report lacks at least 50 samples per shape');
}

function main() {
  const serial = process.env.ANDROID_SERIAL;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(serial ?? '') || serial.startsWith('emulator-'))
    throw new Error('Select an explicitly claimed physical Android phone');
  const out = mkdtempSync(path.join(tmpdir(), 'futo-android-keystroke-latency-'));
  const run = (command, args, allowFailure = false) => {
    const result = spawnSync(command, args, {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 600_000,
    });
    if (!allowFailure && (result.error || result.status !== 0))
      throw result.error ?? new Error(`${command} ${args.join(' ')} exited ${result.status}`);
    return `${result.stdout ?? ''}${result.stderr ?? ''}`;
  };
  const adb = (...args) => run('adb', ['-s', serial, ...args]);
  const apks = 'apps/android/app/build/outputs/apk';
  const app = path.join(ROOT, apks, 'direct/debug/app-direct-debug.apk');
  const tests = path.join(ROOT, apks, 'androidTest/direct/debug/app-direct-debug-androidTest.apk');
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!sdk) throw new Error('ANDROID_HOME is required for APK verification');
  const tools = path.join(sdk, 'build-tools');
  const version = readdirSync(tools)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .find((entry) => existsSync(path.join(tools, entry, 'aapt2')));
  if (!version) throw new Error('Android build-tools aapt2 is missing');
  const aapt = path.join(tools, version, 'aapt2');
  assertLatencyApks(run(aapt, ['dump', 'badging', app]), run(aapt, ['dump', 'badging', tests]));
  const runId = randomUUID();
  const name = `editor-keystroke-latency-${runId}.json`;
  try {
    adb('install', '-r', app);
    adb('install', '-r', '-t', tests);
    const output = adb(
      'shell',
      'am',
      'instrument',
      '-w',
      '-r',
      '-e',
      'class',
      `${CLASS}#${METHOD}`,
      '-e',
      'editorKeystrokeLatency',
      'true',
      '-e',
      'editorKeystrokeRunId',
      runId,
      '-e',
      'editorKeystrokeSamples',
      String(SAMPLES),
      `${PACKAGE}.test/androidx.test.runner.AndroidJUnitRunner`,
    );
    writeFileSync(path.join(out, 'instrumentation.log'), output);
    parseInstrumentationResult(output, CLASS, [METHOD]);
    const raw = adb('exec-out', 'cat', `/sdcard/Android/data/${PACKAGE}/files/${name}`);
    writeFileSync(path.join(out, name), raw);
    const report = JSON.parse(raw);
    validateLatencyReport(report, runId);
    console.log(`${report.model} (sdk ${report.sdk}, ${report.supportedAbis[0]}), non-debuggable`);
    console.log(`${report.warmupKeys} warmup keys, then ${SAMPLES} timed keys per shape:`);
    for (const shape of report.shapes)
      console.log(
        `${shape.shape.padEnd(32)} p50 ${(shape.p50Ns / 1e6).toFixed(2)} ms  p95 ${(shape.p95Ns / 1e6).toFixed(2)} ms`,
      );
    console.log(`Evidence: ${out}`);
  } finally {
    run('adb', ['-s', serial, 'uninstall', `${PACKAGE}.test`], true);
    run('adb', ['-s', serial, 'uninstall', PACKAGE], true);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
