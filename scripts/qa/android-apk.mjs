// Prove the installed dev app is this worktree's build before drawing QA
// conclusions. Comparing APK bytes catches changed native code AND editor assets.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync } from 'node:fs';
import path from 'node:path';
import { assertAndroidTarget } from './android-target.mjs';
import { worktreeRoot } from './pool.mjs';

function sha256File(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
  } catch (error) {
    throw new Error(`cannot read QA APK ${file}; run just android-native`, { cause: error });
  }
  try {
    const hash = createHash('sha256');
    const chunk = Buffer.alloc(1024 * 1024);
    let count;
    while ((count = readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      hash.update(chunk.subarray(0, count));
    }
    return hash.digest('hex');
  } finally {
    closeSync(fd);
  }
}

export function verifyAndroidApk({ serial, apkPath, execFile = execFileSync } = {}) {
  const target = assertAndroidTarget({ serial, execFile });
  if (!apkPath) {
    const flavor = process.env.FUTO_ANDROID_FLAVOR || 'direct';
    if (!['direct', 'play'].includes(flavor)) throw new Error(`unknown Android flavor ${flavor}`);
    apkPath = path.join(
      worktreeRoot(),
      'apps/android/app/build/outputs/apk',
      flavor,
      'debug',
      `app-${flavor}-debug.apk`,
    );
  }
  const expected = sha256File(apkPath);
  const options = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 };
  const installed = execFile('adb', ['-s', target, 'shell', 'pm path com.futo.notes.dev'], options)
    .split(/\r?\n/)
    .filter((line) => line.startsWith('package:'))
    .map((line) => line.slice(8));
  // Native dev builds are one APK. Refuse split/unexpected paths rather than
  // hash just one fragment or interpolate untrusted shell syntax.
  if (
    installed.length !== 1 ||
    !/^\/data\/app\/[A-Za-z0-9_./=+~@-]+\/base\.apk$/.test(installed[0])
  ) {
    throw new Error('cannot identify a single installed dev APK; run just android-native');
  }
  assertAndroidTarget({ serial: target, execFile });
  const output = execFile('adb', ['-s', target, 'shell', 'sha256sum', installed[0]], options);
  const actual = output.trim().split(/\s+/)[0];
  if (!/^[a-f0-9]{64}$/.test(actual)) throw new Error('installed APK checksum was not returned');
  if (actual !== expected) {
    throw new Error(
      `${target} has a different APK than ${apkPath}; another install may have replaced it. Run just android-native before QA`,
    );
  }
  return expected;
}
