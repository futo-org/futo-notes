#!/usr/bin/env node
/**
 * Cross-platform sync integration tests.
 *
 * Boots two Tauri test clients and a sync server, then runs deterministic
 * multi-client sync scenarios through the full client stack:
 *   editor/UI → note session save pipeline → autoSync/syncManager →
 *   Rust core → HTTP → server → and back.
 *
 * A second leg pairs a desktop client with the REAL native Android app when a
 * usable device is reachable, covering the Android shell glue the desktop pair
 * cannot see (FFI wiring, live-loop lifecycle, open-note reconciliation, list
 * refresh). With no device it prints a loud SKIP and runs the desktop-only mesh
 * — see runAndroidLeg.
 *
 * Usage:
 *   node tests/cross-platform-sync.mjs
 *   node tests/cross-platform-sync.mjs --scenario "five notes roundtrip"
 *   node tests/cross-platform-sync.mjs --no-android    (desktop mesh only)
 *   node tests/cross-platform-sync.mjs --android-only  (Android leg only; CI job)
 *
 * Requires:
 *   - Debug Tauri binary:  cd apps/tauri && cargo tauri build --debug --no-bundle
 *   - E2EE sync server:    downloaded on first use (the release pinned in
 *                          scripts/sync-server-pin.json); no checkout needed
 *   - Frontend built with: VITE_INCLUDE_TEST_HOOKS=true pnpm run build
 *   - Android leg only:    a booted device/emulator with the debug app
 *                          (just qa-claim android && just android-native)
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { standinModeAvailable } from '../scripts/lib/sync-server.mjs';
import { ANDROID_MATRIX } from './cross-platform-sync/android-leg-scenarios.mjs';
import { ensureDesktopDebugBinary } from './cross-platform-sync/desktop-build-bootstrap.mjs';
import { args, results, suiteStartedAt, timings } from './cross-platform-sync/run-state.mjs';
import { scenarios } from './cross-platform-sync/scenario-registry.mjs';
import {
  matrixLaunchers,
  runAndroidLeg,
  runScenarios,
} from './cross-platform-sync/scenario-runner.mjs';

async function main() {
  console.log('Cross-platform sync integration tests\n');

  const matrix = matrixLaunchers[args.matrix];
  if (!matrix) {
    throw new Error(
      `Unknown matrix "${args.matrix}". Expected one of: ${Object.keys(matrixLaunchers).join(', ')}`,
    );
  }
  console.log(`Matrix: ${matrix.label}\n`);

  // Build artifacts. Existing processes belong to their launching runs; the
  // launcher discovers a free bridge port and teardown stops only our children.
  const bootstrapStartedAt = Date.now();
  ensureDesktopDebugBinary();
  timings.bootstrapMs = Date.now() - bootstrapStartedAt;

  // Filter scenarios if --scenario is set
  const selected = args.scenario
    ? scenarios.filter((s) => s.name.toLowerCase().includes(args.scenario.toLowerCase()))
    : scenarios;

  if (selected.length === 0) {
    console.error(`No scenarios matching "${args.scenario}"`);
    process.exit(1);
  }

  // Hosted scenarios need a server that HAS stand-in test mode. Until a release
  // carrying it is pinned, that means a local build — so on CI they skip, and
  // the banner says exactly what would change that rather than leaving a
  // shorter green run to look like a full one.
  const standin = standinModeAvailable();
  if (selected.some((scenario) => scenario.hosted) && !standin.available) {
    console.log('='.repeat(72));
    console.log('SKIP: the hosted (Log in with FUTO) scenarios need a stand-in server');
    console.log(`  reason: ${standin.why}`);
    console.log('  to include them: FUTO_NOTES_E2EE_SERVER_REPO=<futo-notes-server checkout>');
    console.log('                   FUTO_NOTES_E2EE_SERVER_STANDIN=1 just test-cross-platform');
    console.log('='.repeat(72));
  }

  const toRun = [];
  const androidLegScenarios = [];
  for (const scenario of selected) {
    if (args['android-only'] && !scenario.matrices.includes(ANDROID_MATRIX)) {
      // Not "skipped" — out of scope for this run, and reporting 31 skip rows
      // would bury the 5 that matter. The desktop mesh has its own job.
      continue;
    }
    if (scenario.matrices.includes(ANDROID_MATRIX)) {
      // Availability is decided later, after the desktop mesh has run, so a
      // missing or broken device can never delay or fail the desktop suite.
      androidLegScenarios.push(scenario);
    } else if (!scenario.matrices.includes(args.matrix)) {
      results.push({
        name: scenario.name,
        skip: true,
        reason: `not included in matrix ${args.matrix}`,
      });
      console.log(`  - ${scenario.name} (skipped: not included in matrix ${args.matrix})`);
    } else if (scenario.skipOnCi && process.env.CI) {
      results.push({ name: scenario.name, skip: true, reason: 'skipOnCi' });
      console.log(`  - ${scenario.name} (skipped: flaky on CI — see scenario registry TODO)`);
    } else if (scenario.hosted && !standin.available) {
      // Never a silent pass (M11): the reason is in the row, in the banner
      // above, and in the JSON report.
      results.push({
        name: scenario.name,
        skip: true,
        reason: `no stand-in server: ${standin.why}`,
      });
      console.log(`  - ${scenario.name} (skipped: no stand-in server)`);
    } else if (scenario.slow && args['skip-slow']) {
      results.push({ name: scenario.name, skip: true, reason: 'slow (--skip-slow)' });
      console.log(`  - ${scenario.name} (skipped: slow — runs on main/tag pipelines)`);
    } else {
      toRun.push(scenario);
    }
  }

  if (toRun.length === 0 && androidLegScenarios.length === 0) {
    throw new Error(`No runnable scenarios for matrix ${args.matrix}`);
  }

  // ── Suite setup: start 2 Tauri instances (done once) ──────────
  console.log('\nStarting Tauri instances...');

  const clientStartupStartedAt = Date.now();
  // startClients registers each client's stop in managedStops as it comes up.
  const [clientA, clientB] = await matrix.startClients();
  timings.clientStartupMs = Date.now() - clientStartupStartedAt;
  console.log(`  Client A ready (${clientA.platform}, MCP port ${clientA.port ?? 'n/a'})`);
  console.log(`  Client B ready (${clientB.platform}, MCP port ${clientB.port ?? 'n/a'})`);

  console.log('');

  await runScenarios(toRun, clientA, clientB);
  // The Android leg pairs the phone with client A; client B is started either
  // way because launching the pair is the matrix launcher's contract, and an
  // idle second instance is cheaper than a second launcher shape.
  await runAndroidLeg(androidLegScenarios, clientA);

  // ── Report ────────────────────────────────────────────────────
  console.log('');
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => r.pass === false).length;
  const skipped = results.filter((r) => r.skip).length;
  const totalRun = passed + failed;
  console.log(`Results: ${passed}/${totalRun} passed, ${failed} failed, ${skipped} skipped`);
  const totalMs = Date.now() - suiteStartedAt;
  console.log(
    `Phases: bootstrap ${timings.bootstrapMs}ms, clients ${timings.clientStartupMs}ms, ` +
      `servers ${timings.serverSetupMs}ms, resets ${timings.clientResetMs}ms, ` +
      `scenarios ${timings.scenarioMs}ms, total ${totalMs}ms`,
  );

  // Write JSON report
  const reportDir = process.env.FUTO_VERIFICATION_DIR || 'test-screenshots';
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(
    join(reportDir, 'sync-results.json'),
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        matrix: args['android-only'] ? ANDROID_MATRIX : args.matrix,
        timings: { ...timings, totalMs },
        results,
      },
      null,
      2,
    ),
  );

  // ── Teardown ──────────────────────────────────────────────────
  clientA.stop();
  clientB.stop();

  // Explicit exit: WebSocket + child-process handles from the Tauri/emulator
  // clients can linger past stop() (TCP CLOSE_WAIT, SIGTERM grace) and keep
  // the Node event loop alive indefinitely — GitLab then waits for the job
  // timeout instead of noticing tests already passed.
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
