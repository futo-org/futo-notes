#!/usr/bin/env node
// Bounded Package Manager presence/readiness probes. Installs and recordings
// keep their own lifecycle; this does not put a global timeout on adb.
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { assertAndroidTarget } from './android-target.mjs';

export const PACKAGE_PROBE_TIMEOUT_MS = 5_000;
const TRANSPORT_PROBE_TIMEOUT_MS = 2_000;
const PACKAGE_NAME = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;

function validateProbe(args) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string'))
    throw new Error('Expected Package Manager probe arguments');
  const [command, value, filter] = args;
  if (
    command === 'list' &&
    value === 'packages' &&
    args.length <= 3 &&
    (!filter || PACKAGE_NAME.test(filter))
  )
    return;
  if (command === 'path' && args.length === 2 && PACKAGE_NAME.test(value)) return;
  if (command === 'install-create' && args.length === 1) return;
  if (command === 'install-abandon' && args.length === 2 && /^\d+$/.test(value)) return;
  throw new Error('Expected a Package Manager list/path or install-session readiness probe');
}

export function runPackageProbe(
  pmArgs,
  {
    serial = process.env.ANDROID_SERIAL,
    expectedAvd = process.env.ANDROID_AVD_NAME,
    allowPending = false,
    adbPath = 'adb',
    execFile = execFileSync,
    timeoutMs = PACKAGE_PROBE_TIMEOUT_MS,
  } = {},
) {
  validateProbe(pmArgs);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new Error('Package probe timeout must be a positive integer');
  const execAdb = (_command, args, options) =>
    execFile(adbPath, args, { ...options, killSignal: 'SIGKILL' });
  const target = assertAndroidTarget({ serial, expectedAvd, allowPending, execFile: execAdb });
  const execute = (args, timeout) =>
    execFile(adbPath, ['-s', target, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
      // Terminate only this probe child even if it ignores SIGTERM; otherwise
      // execFileSync can keep waiting beyond its timeout.
      killSignal: 'SIGKILL',
      maxBuffer: 4 * 1024 * 1024,
    });
  try {
    return execute(['shell', 'pm', ...pmArgs], timeoutMs);
  } catch (error) {
    if (error.code !== 'ETIMEDOUT') {
      throw new Error(
        `Android Package Manager probe failed (pm ${pmArgs.join(' ')}): ${error.stderr || error.message}`,
        { cause: error },
      );
    }
    // Recheck ownership before the diagnostic too: a dead emulator's serial
    // can be recycled while pm is blocked. Identity errors must escape intact.
    assertAndroidTarget({ serial: target, expectedAvd, allowPending, execFile: execAdb });
    let transport;
    try {
      const state = execute(['get-state'], TRANSPORT_PROBE_TIMEOUT_MS).trim();
      transport = `adb get-state=${state || '<empty>'}`;
      if (state === 'device')
        transport += '; adb is responding, Package Manager may be busy with an install';
    } catch (transportError) {
      transport =
        transportError.code === 'ETIMEDOUT'
          ? `adb transport probe also timed out after ${TRANSPORT_PROBE_TIMEOUT_MS} ms`
          : `adb get-state failed: ${transportError.stderr || transportError.message}`;
    }
    throw new Error(
      `Android Package Manager probe timed out after ${timeoutMs} ms (pm ${pmArgs.join(' ')}); ${transport}`,
      { cause: error },
    );
  }
}

// An install session exercises StorageManager too; service registration alone
// is too early. Retry PM failures, but let ownership/identity errors escape.
export function isAndroidPackageInstallerReady(options) {
  let created;
  try {
    created = runPackageProbe(['install-create'], options);
  } catch (error) {
    if (error.cause) return false;
    throw error;
  }
  const session = created.match(/\[(\d+)\]/);
  if (!created.includes('Success') || !session) return false;
  runPackageProbe(['install-abandon', session[1]], options);
  return true;
}

export function isAndroidPackageInstalled(packageName, options) {
  if (typeof packageName !== 'string' || !PACKAGE_NAME.test(packageName))
    throw new Error('Expected an Android package name');
  // A successful filtered query with no exact match means absent. Transport,
  // PM service and timeout failures are errors, never "not installed".
  return runPackageProbe(['list', 'packages', packageName], options)
    .split(/\r?\n/)
    .some((line) => line === `package:${packageName}`);
}

if (import.meta.main) {
  try {
    const { values, positionals } = parseArgs({
      options: {
        serial: { type: 'string' },
        adb: { type: 'string' },
        avd: { type: 'string' },
        'timeout-ms': { type: 'string' },
        installed: { type: 'string' },
        help: { type: 'boolean' },
      },
      allowPositionals: true,
    });
    if (values.help || (!values.installed && positionals.length === 0)) {
      console.log(
        'usage: android-package-probe.mjs [--serial id] [--adb path] [--avd name] [--timeout-ms n] --installed package | -- <pm probe args>',
      );
    } else {
      const options = {
        serial: values.serial,
        adbPath: values.adb,
        expectedAvd: values.avd,
        ...(values['timeout-ms'] === undefined ? {} : { timeoutMs: Number(values['timeout-ms']) }),
      };
      if (values.installed) {
        if (positionals.length) throw new Error('Use either --installed or a PM command');
        if (!isAndroidPackageInstalled(values.installed, options)) {
          console.error(`${values.installed} is not installed`);
          process.exitCode = 1;
        }
      } else {
        process.stdout.write(runPackageProbe(positionals, options));
      }
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
