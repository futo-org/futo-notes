/**
 * Client launchers, exit cleanup, and the loops that run scenarios against a client pair.
 */

import {
  findAndroidLegDevice,
  startAndroidNativeInstance,
} from '../lib/android-native-instance.mjs';
import { startServer } from '../lib/sync-test-server.mjs';
import { startDesktopTauriInstance } from '../lib/tauri-instance.mjs';
import { REPO_ROOT, allocateServerPort, args, results, timings } from './run-state.mjs';

// ── Main ────────────────────────────────────────────────────────

const managedStops = [];

export const matrixLaunchers = {
  'desktop-desktop': {
    label: 'desktop ↔ desktop',
    // Launch sequentially so the Linux MCP bridge cannot race both processes
    // onto the same discovery port. Hook readiness is condition-polled, so
    // this no longer carries the old fixed five-second delay per client.
    // Register each stop as soon as its client is up: if client-b's startup
    // throws, exit-time cleanup must still terminate the running client-a.
    startClients: async () => {
      const clientA = await startDesktopTauriInstance('client-a', REPO_ROOT);
      managedStops.push(() => clientA.stop());
      const clientB = await startDesktopTauriInstance('client-b', REPO_ROOT);
      managedStops.push(() => clientB.stop());
      return [clientA, clientB];
    },
  },
};

function cleanup() {
  for (const stop of [...managedStops].reverse()) {
    try {
      stop();
    } catch {
      /* ignore */
    }
  }
}

process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(1));
process.on('SIGTERM', () => process.exit(1));

/** Run a list of scenarios against one client pair: fresh server per scenario,
 *  both clients reset in between, one result row each. */
export async function runScenarios(list, clientA, clientB) {
  for (const scenario of list) {
    // main's slot-derived port band, not a bare counter: a hardcoded start had
    // every worktree allocating the same port, so a second run adopted the
    // first's server and database.
    const port = allocateServerPort();
    const serverSetupStartedAt = Date.now();
    const server = await startServer(port, {
      ...(scenario.hosted ? { mode: 'standin' } : {}),
      ...(scenario.serverOptions ?? {}),
    });
    const serverSetupMs = Date.now() - serverSetupStartedAt;
    timings.serverSetupMs += serverSetupMs;
    managedStops.push(() => server.stop());

    const caseStartedAt = Date.now();
    let clientResetMs = 0;
    let scenarioMs = 0;
    try {
      // Reset clients between scenarios
      const clientResetStartedAt = Date.now();
      await clientA.reset();
      await clientB.reset();
      clientResetMs = Date.now() - clientResetStartedAt;
      timings.clientResetMs += clientResetMs;

      const scenarioStartedAt = Date.now();
      try {
        await scenario.fn(clientA, clientB, server);
      } finally {
        scenarioMs = Date.now() - scenarioStartedAt;
        timings.scenarioMs += scenarioMs;
      }

      const ms = Date.now() - caseStartedAt;
      results.push({
        name: scenario.name,
        pass: true,
        ms,
        serverSetupMs,
        clientResetMs,
        scenarioMs,
      });
      console.log(`  ✓ ${scenario.name} (${ms}ms)`);
    } catch (err) {
      const ms = Date.now() - caseStartedAt;
      results.push({
        name: scenario.name,
        pass: false,
        ms,
        serverSetupMs,
        clientResetMs,
        scenarioMs,
        error: err.message,
      });
      console.log(`  ✗ ${scenario.name} (${ms}ms)`);
      console.log(`    ${err.message}`);
    } finally {
      server.stop();
    }
  }
}

/**
 * Attach the native Android leg when a usable device is reachable.
 *
 * On a developer machine with no device attached, no device is a legitimate
 * state, so it skips — but never quietly: the banner says the mesh ran
 * desktop-only and every skipped scenario carries its reason into the report.
 * A device that IS available and then fails to start is a red failure, not a
 * skip (AGENTS.md M11).
 *
 * Under `--android-only` the device is the entire point of the run (the
 * dedicated CI job boots an emulator for it), so an unusable device fails red
 * instead of skipping.
 */
export async function runAndroidLeg(androidScenarios, desktopClient) {
  if (androidScenarios.length === 0) return;

  const device = args['no-android']
    ? { available: false, reason: '--no-android was passed' }
    : findAndroidLegDevice();

  if (!device.available && args['android-only']) {
    console.log('');
    console.log(`  ✗ --android-only requires a usable device: ${device.reason}`);
    for (const scenario of androidScenarios) {
      results.push({
        name: scenario.name,
        pass: false,
        ms: 0,
        error: `no usable Android device: ${device.reason}`,
      });
    }
    return;
  }

  if (!device.available) {
    console.log('');
    console.log('='.repeat(72));
    console.log('SKIP: no Android device — running desktop-only mesh');
    console.log(`  reason: ${device.reason}`);
    console.log('  to include it: just qa-claim android && just android-native');
    console.log(`  skipped: ${androidScenarios.map((s) => s.name).join(', ')}`);
    console.log('='.repeat(72));
    for (const scenario of androidScenarios) {
      results.push({
        name: scenario.name,
        skip: true,
        reason: `no Android device: ${device.reason}`,
      });
    }
    return;
  }

  console.log(`\nStarting native Android client on ${device.serial}...`);
  let android;
  try {
    const startedAt = Date.now();
    android = await startAndroidNativeInstance('client-android', REPO_ROOT, device.serial);
    timings.clientStartupMs += Date.now() - startedAt;
    managedStops.push(() => android.stop());
    console.log(`  Client Android ready (${android.platform}, vault ${android.vaultPath})\n`);
  } catch (err) {
    // The device was there; failing to drive it is a real failure.
    console.log(`  ✗ native Android client failed to start: ${err.message}`);
    for (const scenario of androidScenarios) {
      results.push({
        name: scenario.name,
        pass: false,
        ms: 0,
        error: `android startup: ${err.message}`,
      });
    }
    return;
  }

  await runScenarios(androidScenarios, desktopClient, android);
  android.stop();
}
