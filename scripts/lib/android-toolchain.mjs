// Android setup and Rust builds resolve the same SDK and the Gradle-pinned NDK.
// Executed by build-rust-android.sh, prints only the validated NDK directory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** AGP and cargo-ndk must use the same NDK to resolve and strip libraries. */
export function ndkVersionFromGradle(gradleText) {
  const m = /ndkVersion\s*=\s*"([^"]+)"/.exec(gradleText);
  if (!m) throw new Error('no ndkVersion found in apps/android/app/build.gradle.kts');
  return m[1];
}

export function resolveAndroidSdk({
  env = process.env,
  home = os.homedir(),
  platform = process.platform,
} = {}) {
  const sdk =
    env.ANDROID_HOME ||
    env.ANDROID_SDK_ROOT ||
    path.join(home, platform === 'darwin' ? 'Library/Android/sdk' : 'Android/Sdk');
  if (!fs.existsSync(sdk) || !fs.statSync(sdk).isDirectory())
    throw new Error(
      `Android SDK not found at ${sdk}; set ANDROID_HOME to the installed SDK directory`,
    );
  return sdk;
}

export function resolveAndroidNdk({ root = process.cwd(), env = process.env, ...sdkOptions } = {}) {
  const expected = ndkVersionFromGradle(
    fs.readFileSync(path.join(root, 'apps/android/app/build.gradle.kts'), 'utf8'),
  );
  const ndk =
    env.ANDROID_NDK_HOME || path.join(resolveAndroidSdk({ env, ...sdkOptions }), 'ndk', expected);
  const sourceProperties = path.join(ndk, 'source.properties');
  if (!fs.existsSync(sourceProperties))
    throw new Error(
      `NDK ${expected} not found at ${ndk}; install it with SDK Manager or set ANDROID_NDK_HOME`,
    );
  const actual = /^Pkg\.Revision\s*=\s*(\S+)\s*$/m.exec(
    fs.readFileSync(sourceProperties, 'utf8'),
  )?.[1];
  if (actual !== expected)
    throw new Error(
      `ANDROID_NDK_HOME must contain NDK ${expected}; found ${actual ?? 'no Pkg.Revision'} at ${ndk}`,
    );
  return { directory: ndk, version: expected };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(resolveAndroidNdk().directory);
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}
