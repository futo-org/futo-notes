#!/usr/bin/env node
// Run the existing portable-editor consumers in an actual x86 process, keeping
// every requested ABI in the APK. Gradle's normal reinstall clears `--abi x86`,
// so the normal recipe builds first, then this owns the final install and run.
// Complete raw output and exact source-derived method sets prevent silent green.
import { spawnSync } from 'node:child_process';
import console from 'node:console';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { LEGACY_ANDROID_AVDS, POOL } from './qa/pool.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLASSES = [
  'NativeEditorSessionTest',
  'NativeBoundedEditorSessionTest',
  'NativeEditorCompositionTest',
  'NativeEditorContractSurfaceTest',
];
const PACKAGE = 'com.futo.notes.dev';
const RUNNER = `${PACKAGE}.test/androidx.test.runner.AndroidJUnitRunner`;
const ABIS = ['arm64-v8a', 'armeabi-v7a', 'x86_64', 'x86'];

export function parseInstrumentationResult(output, cls, expected) {
  output = output.replaceAll('\r', '');
  const started = [];
  const passed = [];
  let status = {};
  let active;
  let totals = 0;
  for (const line of output.split(/\r?\n/)) {
    const field = line.match(/^INSTRUMENTATION_STATUS: (class|test|numtests)=(.*)$/);
    if (field) status[field[1]] = field[2];
    const code = line.match(/^INSTRUMENTATION_STATUS_CODE: (-?\d+)$/);
    if (!code) continue;
    if (status.class !== cls || !expected.includes(status.test))
      throw new Error(`Unexpected instrumentation method: ${JSON.stringify(status)}`);
    if (status.numtests !== undefined) {
      if (Number(status.numtests) !== expected.length)
        throw new Error('Wrong instrumentation count');
      totals++;
    }
    if (code[1] === '1' && active === undefined) {
      active = status.test;
      started.push(status.test);
    } else if (code[1] === '0' && active === status.test) {
      active = undefined;
      passed.push(status.test);
    } else throw new Error(`Instrumentation method did not pass: ${status.test}, code ${code[1]}`);
    status = {};
  }
  const same = (values) =>
    JSON.stringify([...values].sort()) === JSON.stringify([...expected].sort());
  const summary = output.match(/^OK \((\d+) tests?\)$/m);
  const finished = [...output.matchAll(/^INSTRUMENTATION_CODE: (-?\d+)$/gm)];
  if (
    active !== undefined ||
    !totals ||
    !same(started) ||
    !same(passed) ||
    Number(summary?.[1]) !== expected.length ||
    finished.length !== 1 ||
    finished[0][1] !== '-1'
  )
    throw new Error(`Incomplete instrumentation result for ${cls}`);
  return passed;
}

export function selectedClasses(args) {
  const classes = args.length ? args : CLASSES.map((name) => `com.futo.notes.editor.${name}`);
  if (
    new Set(classes).size !== classes.length ||
    classes.some((cls) => !CLASSES.some((name) => cls === `com.futo.notes.editor.${name}`))
  )
    throw new Error('Expected distinct portable-editor native test class names');
  return classes;
}

export function validateManagedTarget(serial, avd) {
  const pooled = avd?.match(/^futo-qa-(\d+)$/);
  if (
    !/^emulator-\d+$/.test(serial ?? '') ||
    !(LEGACY_ANDROID_AVDS.includes(avd) || (pooled && Number(pooled[1]) < POOL))
  )
    throw new Error('Select a claimed x86-capable QA emulator');
}

function main() {
  const classes = selectedClasses(process.argv.slice(2));
  const serial = process.env.ANDROID_SERIAL;
  validateManagedTarget(serial, process.env.ANDROID_AVD_NAME);
  const out = mkdtempSync(path.join(tmpdir(), 'futo-android-native32-'));
  console.log(`Native32 evidence: ${out}`);
  let commandNumber = 0;
  const run = (command, args) => {
    console.log(`==> ${JSON.stringify([command, ...args])}`);
    const result = spawnSync(command, args, {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    writeFileSync(path.join(out, `${++commandNumber}.log`), output);
    process.stdout.write(output);
    if (result.error || result.status !== 0)
      throw result.error ?? new Error(`${command} exited ${result.status}`);
    return output;
  };
  const target = () => run('just', ['qa-android-target']);
  const adb = (...args) => {
    target();
    return run('adb', ['-s', serial, ...args]);
  };
  if (!adb('shell', 'getprop', 'ro.product.cpu.abilist').trim().split(',').includes('x86'))
    throw new Error('The claimed emulator does not support x86');
  const app = path.join(
    ROOT,
    'apps/android/app/build/outputs/apk/direct/debug/app-direct-debug.apk',
  );
  const tests = path.join(
    ROOT,
    'apps/android/app/build/outputs/apk/androidTest/direct/debug/app-direct-debug-androidTest.apk',
  );
  const entries = run('unzip', ['-Z1', app]).split(/\r?\n/);
  for (const abi of ABIS)
    if (!entries.includes(`lib/${abi}/libfuto_notes_ffi.so`))
      throw new Error(`The APK is missing ${abi}`);
  const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
  const receipt = {
    source: run('git', ['rev-parse', 'HEAD']).trim(),
    serial,
    abi: 'x86',
    appSha256: hash(app),
    testSha256: hash(tests),
    classes: {},
  };
  adb('install', '--abi', 'x86', '-r', app);
  adb('install', '--abi', 'x86', '-r', '-t', tests);
  run('just', ['qa-android-apk', app]);
  const installed = adb('shell', 'dumpsys', 'package', PACKAGE);
  if (!/^\s*primaryCpuAbi=x86\s*$/m.test(installed))
    throw new Error('Forced x86 install did not select x86');
  for (const cls of classes) {
    const short = cls.split('.').at(-1);
    const source = readFileSync(
      path.join(ROOT, `apps/android/app/src/androidTest/java/com/futo/notes/editor/${short}.kt`),
      'utf8',
    );
    const expected = [...source.matchAll(/@Test\s+fun\s+(\w+)\s*\(/g)].map((match) => match[1]);
    if (!expected.length || new Set(expected).size !== expected.length)
      throw new Error(`Invalid source method inventory: ${cls}`);
    const started = Date.now() / 1000;
    const output = adb(
      'shell',
      'am',
      'instrument',
      '--abi',
      'x86',
      '-w',
      '-r',
      '-e',
      'class',
      cls,
      '-e',
      'editorRequire32Bit',
      'true',
      RUNNER,
    );
    const passed = parseInstrumentationResult(output, cls, expected);
    receipt.classes[cls] = { expected, passed, started, finished: Date.now() / 1000 };
    if (short === 'NativeEditorSessionTest' || short === 'NativeBoundedEditorSessionTest') {
      const widthMarker =
        short === 'NativeBoundedEditorSessionTest'
          ? 'EDITOR_NATIVE_BOUNDED_32BIT=true'
          : 'EDITOR_NATIVE_CONTRACT_32BIT=true';
      const log = adb('logcat', '-d', '-v', 'epoch', '-s', 'System.out:I');
      const lines = log
        .split(/\r?\n/)
        .filter(
          (line) =>
            Number(line.trim().split(/\s+/)[0]) >= started - 1 && line.includes(widthMarker),
        );
      if (!lines.length) throw new Error('No current Process.is64Bit=false witness');
      receipt.classes[cls].processWidth = lines;
    }
  }
  target();
  run('just', ['qa-android-apk', app]);
  if (hash(app) !== receipt.appSha256 || hash(tests) !== receipt.testSha256)
    throw new Error('Built APK changed during the native run');
  writeFileSync(path.join(out, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(
    `Native32 PASS: ${Object.values(receipt.classes).reduce((n, cls) => n + cls.passed.length, 0)} methods; ${out}/receipt.json`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
