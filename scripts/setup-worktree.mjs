#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ndkVersionFromGradle } from './remote-test.mjs';

const USAGE = 'Usage: just setup [portable|desktop|ios|android] [--check]';
if (process.argv.slice(2).some((arg) => arg === '--help' || arg === '-h')) {
  console.log(USAGE);
  process.exit(0);
}
let values, positionals;
try {
  ({ values, positionals } = parseArgs({
    options: { check: { type: 'boolean' } },
    allowPositionals: true,
  }));
} catch (error) {
  console.error(USAGE);
  console.error(error.message);
  process.exit(2);
}
const target = positionals[0] ?? 'portable';
if (positionals.length > 1 || !['portable', 'desktop', 'ios', 'android'].includes(target)) {
  console.error(USAGE);
  process.exit(2);
}
const root = process.cwd();
const failures = [];
const check = (label, fn) => {
  try {
    const detail = fn();
    console.log(`OK ${label}${detail ? ': ' + detail : ''}`);
  } catch (error) {
    failures.push(label);
    console.error(`MISSING ${label}: ${error.message}`);
  }
};
const output = (command, args) =>
  execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15000,
  }).trim();
const requiredFile = (file) => {
  if (!fs.existsSync(file)) throw new Error(file);
  return file;
};
// Invoked from inside `pnpm run …` (e.g. `pnpm run test:cross-platform` →
// `just build-desktop-test` → scripts/dev-env.sh → this script), a nested
// `pnpm --version` can resolve a DIFFERENT pnpm than the one running the
// outer command — a self-managing pnpm newer than the pin, ahead of (or
// instead of) the Corepack shim on PATH — and falsely report MISSING pnpm
// pin even though the outer pnpm matches. When already running under pnpm,
// read the version pnpm itself put in the user agent instead of spawning.
const pnpmVersion = () => {
  const userAgent = process.env.npm_config_user_agent ?? '';
  const underPnpm = userAgent.startsWith('pnpm/') || /pnpm/i.test(process.env.npm_execpath ?? '');
  const fromUserAgent = /^pnpm\/(\S+)/.exec(userAgent)?.[1];
  if (underPnpm && fromUserAgent) return fromUserAgent;
  return output('pnpm', ['--version']);
};

console.log(`Setup: ${root} (${process.platform}, ${target})`);
check('Node pin', () => {
  const expected = 'v' + fs.readFileSync('.nvmrc', 'utf8').trim();
  if (process.version !== expected)
    throw new Error(`expected ${expected}, got ${process.version}; use scripts/dev-env.sh`);
  return process.version;
});
for (const command of ['git', 'just', 'cargo', 'rustc'])
  check(command, () => output(command, ['--version']));
check('pnpm pin', () => {
  const expected = JSON.parse(fs.readFileSync('package.json', 'utf8')).packageManager.split('@')[1];
  const actual = pnpmVersion();
  if (actual !== expected)
    throw new Error(`expected ${expected}, got ${actual}; activate the packageManager version`);
  return actual;
});
if (target === 'ios') {
  check('macOS', () => {
    if (process.platform !== 'darwin') throw new Error('iOS requires the Mac');
  });
  check('Xcode', () => output('xcrun', ['xcodebuild', '-version']));
  check('xcodegen', () => output('xcodegen', ['--version']));
  check('simulator runtimes', () => {
    const runtimes = JSON.parse(output('xcrun', ['simctl', 'list', 'runtimes', '--json'])).runtimes;
    if (!runtimes.some((r) => r.isAvailable && r.identifier.includes('iOS')))
      throw new Error('install an iOS runtime in Xcode');
  });
}
if (target === 'desktop' && process.platform === 'linux') {
  check('WebKitGTK development packages', () =>
    output('pkg-config', ['--modversion', 'webkit2gtk-4.1', 'gtk+-3.0']),
  );
  check('desktop display', () => {
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY)
      throw new Error('no DISPLAY or WAYLAND_DISPLAY');
  });
}
if (target === 'android') {
  check('JDK 17 or 21', () => {
    const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin/java') : 'java';
    const result = spawnSync(java, ['-XshowSettings:properties', '-version'], {
      encoding: 'utf8',
      timeout: 15000,
    });
    const version = /java.version\s*=\s*(\d+)/.exec(result.stderr ?? '')?.[1];
    if (result.status !== 0 || !['17', '21'].includes(version))
      throw new Error('set JAVA_HOME to JDK 17 or 21');
    return version;
  });
  check('Android SDK', () =>
    requiredFile(
      process.env.ANDROID_HOME ??
        `Set ANDROID_HOME (usually ${path.join(os.homedir(), process.platform === 'darwin' ? 'Library/Android/sdk' : 'Android/Sdk')})`,
    ),
  );
  check('Android NDK pin', () => {
    const expected = ndkVersionFromGradle(
      fs.readFileSync('apps/android/app/build.gradle.kts', 'utf8'),
    );
    if (!process.env.ANDROID_NDK_HOME)
      throw new Error(`set ANDROID_NDK_HOME to the installed NDK ${expected}`);
    const properties = fs.readFileSync(
      path.join(process.env.ANDROID_NDK_HOME, 'source.properties'),
      'utf8',
    );
    if (!properties.includes(`Pkg.Revision = ${expected}`))
      throw new Error(`ANDROID_NDK_HOME must contain NDK ${expected}`);
    return expected;
  });
  check('cargo-ndk', () => output('cargo', ['ndk', '--version']));
}
if (failures.length) {
  console.error(`Setup blocked before builds: ${failures.join(', ')}`);
  process.exit(1);
}
if (values.check) check('workspace dependencies', () => requiredFile('node_modules/.bin/vite'));
if (failures.length) {
  console.error('Run just setup to install workspace dependencies.');
  process.exit(1);
}
if (!values.check) {
  execFileSync('pnpm', ['install', '--frozen-lockfile'], { stdio: 'inherit' });
  fs.mkdirSync('dist', { recursive: true });
}
console.log(
  values.check
    ? 'Prerequisites checked; build/device readiness not verified.'
    : 'Dependencies installed. No app or device was launched.',
);
console.log(
  `Next: ${target === 'ios' ? 'just qa-claim ios, then just verify-run test-ios-stories' : target === 'android' ? 'just qa-claim android, then just verify-run test-android-native' : target === 'desktop' ? 'just verify-run test-desktop-journeys' : 'just verify-run check'}`,
);
