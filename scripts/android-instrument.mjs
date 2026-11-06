#!/usr/bin/env node
// The fast Android instrumentation loop (`just test-android-ui`): install the
// already-built app and test APKs on each claimed emulator only when they
// changed, then run any list of classes, methods or packages straight through
// `am instrument`, with no Gradle in the loop.
//
// Why not `:app:connectedDirectDebugAndroidTest` for this: every call rebuilds,
// reinstalls the whole debug APK and uninstalls it again, so agents running one
// class per call paid the full cycle ~38 times for one pass. And its class
// filter silently dropped every class after the first (see the justfile notes
// on test-android-native-ui), which is why they ran one class per call at all.
//
// M11: the run is red unless the instrumentation finished normally, nothing
// failed or crashed, at least one test ran, and EVERY selector ran at least one
// test. That last check is what turns a filter that drops a class into a
// failure instead of a smaller green run.
//
// Device safety: only emulators this worktree claimed (`just qa-claim android`,
// plus `--extra` claims for sharding). Instrumentation clears the app's data,
// so a physical phone is refused outright, even one claimed with --serial.
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { assertAndroidTarget } from './qa/android-target.mjs';
import { DEV_DIR, readOwner, worktreeRoot } from './qa/pool.mjs';
import {
  assess,
  checkJunit,
  gradleSelectorArg,
  label,
  parseInstrumentation,
  parseSelectors,
  runnerArgs,
} from './lib/android-instrumentation.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const APP_PACKAGE = 'com.futo.notes.dev';
export const TEST_PACKAGE = `${APP_PACKAGE}.test`;
const RUNNER = `${TEST_PACKAGE}/androidx.test.runner.AndroidJUnitRunner`;
const APK_DIR = path.join(ROOT, 'apps/android/app/build/outputs/apk');
export const APP_APK = path.join(APK_DIR, 'direct/debug/app-direct-debug.apk');
export const TEST_APK = path.join(
  APK_DIR,
  'androidTest/direct/debug/app-direct-debug-androidTest.apk',
);
const RESULTS_DIR = path.join(
  ROOT,
  'apps/android/app/build/outputs/androidTest-results/instrument',
);

const USAGE = `usage: android-instrument.mjs [options] [selector ...]

selectors (none = the whole suite):
  com.futo.notes.textfirst.TextFirstCaretTest           a class
  com.futo.notes.textfirst.TextFirstCaretTest#method    one method
  com.futo.notes.textfirst                              every class in a package
  Classes and methods may be mixed; packages may not be mixed with them.

options:
  --shard            split the run across every emulator this worktree claimed
                     (just qa-claim android, then just qa-claim android --extra)
  --arg key=value    extra runner argument (-e key value), repeatable
  --timeout <min>    fail a device's run after this many minutes (default 60)
  --no-install       run against whatever is installed (still checked by SHA)
  --keep-data        do not clear the app's data before the run
  --targets          print the emulators that would run, then exit
  --rebuild          (just test-android-ui only) build even if nothing changed`;

// ── devices ────────────────────────────────────────────────────────────────

const ADB_OPTS = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 };

// Emulators only. A physical phone is refused even when claimed: these tests
// clear the dev app's data, and the Pixel's dev vault was lost exactly that way.
export function assertEmulator(serial, avd) {
  if (!/^emulator-\d+$/.test(serial ?? ''))
    throw new Error(
      `${serial}: instrumentation runs only on claimed emulators, never a physical device`,
    );
  return assertAndroidTarget({ serial, expectedAvd: avd });
}

// This worktree's claimed emulators, ANDROID_SERIAL's first.
export function claimedEmulators({ root = worktreeRoot(), dir = DEV_DIR } = {}) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .sort()
    .flatMap((file) => {
      const m = file.match(/^android-(futo-qa-\d+|futo-api\d+)\.json$/);
      const owner = m && readOwner('android', m[1]);
      return owner?.worktree === root && owner.id && !owner.wipePending
        ? [{ serial: owner.id, avd: m[1] }]
        : [];
    })
    .sort(
      (a, b) =>
        (b.serial === process.env.ANDROID_SERIAL) - (a.serial === process.env.ANDROID_SERIAL),
    );
}

function resolveTargets({ shard }) {
  if (!shard) {
    const serial = process.env.ANDROID_SERIAL;
    if (!serial) throw new Error('set ANDROID_SERIAL and ANDROID_AVD_NAME (just qa-claim android)');
    return [
      {
        serial: assertEmulator(serial, process.env.ANDROID_AVD_NAME),
        avd: process.env.ANDROID_AVD_NAME,
      },
    ];
  }
  const targets = claimedEmulators();
  if (targets.length < 2)
    throw new Error(
      `--shard needs at least two claimed emulators; this worktree holds ${targets.length}. ` +
        'Add one with: just qa-claim android --extra',
    );
  for (const t of targets) assertEmulator(t.serial, t.avd);
  return targets;
}

const adb = (serial, ...args) => execFileSync('adb', ['-s', serial, ...args], ADB_OPTS);
export const shellQuote = (arg) =>
  /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;

function sha256(file) {
  if (!fs.existsSync(file))
    throw new Error(
      `${path.relative(ROOT, file)} is missing; run just test-android-ui (it builds)`,
    );
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function installedSha(serial, pkg) {
  const paths = adb(serial, 'shell', `pm path ${pkg}`)
    .split(/\r?\n/)
    .filter((line) => line.startsWith('package:'))
    .map((line) => line.slice(8));
  if (paths.length !== 1 || !/^\/data\/app\/[A-Za-z0-9_./=+~@-]+\/base\.apk$/.test(paths[0]))
    return null;
  return adb(serial, 'shell', 'sha256sum', paths[0]).trim().split(/\s+/)[0];
}

// Install only what changed. Re-checks the claim right before each install.
function ensureInstalled(target, apk, pkg, wanted, { install }) {
  let have = null;
  try {
    have = installedSha(target.serial, pkg);
  } catch {
    have = null; // pm path exits non-zero when the package is absent
  }
  if (have === wanted) return 'current';
  if (!install)
    throw new Error(`${target.serial}: ${pkg} is not this build and --no-install was given`);
  assertEmulator(target.serial, target.avd);
  adb(target.serial, 'install', '-r', '-t', apk);
  if (installedSha(target.serial, pkg) !== wanted)
    throw new Error(`${target.serial}: ${pkg} install did not take`);
  return 'installed';
}

function instrument(target, args, { timeoutMinutes, logFile, onTest }) {
  return new Promise((resolve) => {
    assertEmulator(target.serial, target.avd);
    // adb joins its arguments into one device shell line: quote each one.
    const command = ['am', 'instrument', '-w', '-r', ...args, RUNNER].map(shellQuote).join(' ');
    const child = spawn('adb', ['-s', target.serial, 'shell', command], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const log = fs.createWriteStream(logFile);
    let output = '';
    let stderr = '';
    let reported = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMinutes * 60_000);
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      log.write(chunk);
      output += chunk;
      // Report each finished test as it lands, from complete lines only.
      const { tests } = parseInstrumentation(output.slice(0, output.lastIndexOf('\n') + 1));
      for (; reported < tests.length; reported++) onTest(tests[reported]);
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      log.write(chunk);
      stderr += chunk;
    });
    child.on('close', (exit) => {
      clearTimeout(timer);
      log.end();
      const parsed = parseInstrumentation(output);
      if (exit !== 0 && stderr.trim()) parsed.problems.push(`adb: ${stderr.trim()}`);
      resolve({ serial: target.serial, output, exit, timedOut, parsed });
    });
  });
}

// ── main ───────────────────────────────────────────────────────────────────

export function parseCli(argv) {
  const opts = {
    shard: false,
    extra: [],
    timeoutMinutes: 60,
    install: true,
    keepData: false,
    list: [],
    targets: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--shard') opts.shard = true;
    else if (a === '--no-install') opts.install = false;
    else if (a === '--keep-data') opts.keepData = true;
    else if (a === '--targets') opts.targets = true;
    else if (a === '--gradle-arg') opts.gradleArg = true;
    else if (a === '--assert-emulator') opts.assertEmulator = true;
    else if (a === '--check-junit') {
      opts.checkJunit = argv[++i];
      if (!opts.checkJunit) throw new Error('--check-junit takes a results directory');
    } else if (a === '--arg') {
      const m = (argv[++i] ?? '').match(/^([A-Za-z][A-Za-z0-9_]*)=(.*)$/);
      if (!m || ['class', 'package', 'numShards', 'shardIndex'].includes(m[1]))
        throw new Error('--arg takes key=value (selectors and sharding have their own options)');
      opts.extra.push([m[1], m[2]]);
    } else if (a === '--timeout') {
      opts.timeoutMinutes = Number(argv[++i]);
      if (!(opts.timeoutMinutes > 0)) throw new Error('--timeout takes minutes');
    } else if (a === '-h' || a === '--help') opts.help = true;
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else opts.list.push(a);
  }
  opts.selectors = parseSelectors(opts.list);
  return opts;
}

async function main() {
  const opts = parseCli(process.argv.slice(2));
  if (opts.help) return console.log(USAGE);
  // Helpers for the Gradle recipe.
  if (opts.gradleArg) {
    for (const arg of gradleSelectorArg(opts.selectors)) console.log(arg);
    return;
  }
  if (opts.assertEmulator) {
    assertEmulator(process.env.ANDROID_SERIAL, process.env.ANDROID_AVD_NAME);
    return;
  }
  if (opts.checkJunit) {
    const verdict = checkJunit(opts.checkJunit, opts.selectors);
    const { tests, pass, fail, skip } = verdict.totals;
    console.log(
      `${verdict.ok ? 'PASS' : 'FAIL'}: ${tests} tests, ${pass} passed, ${fail} failed, ${skip} skipped (JUnit XML)`,
    );
    for (const p of verdict.problems) console.error(`  - ${p}`);
    if (!verdict.ok) process.exitCode = 1;
    return;
  }
  const targets = resolveTargets(opts);
  if (opts.targets) {
    for (const t of targets) console.log(`${t.serial} ${t.avd}`);
    return;
  }
  const appSha = sha256(APP_APK);
  const testSha = sha256(TEST_APK);
  const t0 = Date.now();
  await Promise.all(
    targets.map(async (target) => {
      const app = ensureInstalled(target, APP_APK, APP_PACKAGE, appSha, opts);
      const test = ensureInstalled(target, TEST_APK, TEST_PACKAGE, testSha, opts);
      console.log(`==> ${target.serial} (${target.avd}): app ${app}, test APK ${test}`);
      if (!opts.keepData) {
        // A Gradle run starts from a fresh install; match that.
        assertEmulator(target.serial, target.avd);
        adb(target.serial, 'shell', 'pm', 'clear', APP_PACKAGE);
      }
    }),
  );
  const tInstall = Date.now();
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const what = opts.selectors.length
    ? opts.selectors.map((s) => s.value).join(' ')
    : 'the whole suite';
  console.log(`==> running ${what} on ${targets.length} emulator(s)`);
  const runs = await Promise.all(
    targets.map((target, index) =>
      instrument(
        target,
        runnerArgs(opts.selectors, { shard: { count: targets.length, index }, extra: opts.extra }),
        {
          timeoutMinutes: opts.timeoutMinutes,
          logFile: path.join(RESULTS_DIR, `${target.serial}.txt`),
          onTest: (t) =>
            console.log(
              `${t.outcome.toUpperCase().padEnd(4)} ${label(t)}${targets.length > 1 ? `  [${target.serial}]` : ''}`,
            ),
        },
      ),
    ),
  );
  const verdict = assess(opts.selectors, runs);
  const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
  for (const t of verdict.failed) console.log(`\n--- ${label(t)}\n${t.stack ?? '(no stack)'}`);
  const { tests, pass, fail, skip } = verdict.totals;
  console.log(
    `\n${verdict.ok ? 'PASS' : 'FAIL'}: ${tests} tests, ${pass} passed, ${fail} failed, ${skip} skipped ` +
      `on ${targets.length} emulator(s); install ${secs(tInstall - t0)}, run ${secs(Date.now() - tInstall)}`,
  );
  console.log(`raw output: ${path.relative(ROOT, RESULTS_DIR)}/<serial>.txt`);
  if (!verdict.ok) {
    for (const p of verdict.problems.filter((p) => !p.startsWith('FAILED ')))
      console.error(`  - ${p}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`android-instrument: ${error.message}`);
    process.exit(1);
  });
}
