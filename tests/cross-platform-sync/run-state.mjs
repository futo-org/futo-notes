/**
 * Command-line options, repo paths and the per-run result and timing state
 * shared by every part of the cross-platform sync harness.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { xplatSyncBand } from '../../scripts/lib/slot.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
export const REPO_ROOT = resolve(__dirname, '../..');

// ── CLI args ────────────────────────────────────────────────────

export const { values: args } = parseArgs({
  options: {
    scenario: { type: 'string' },
    matrix: { type: 'string', default: 'desktop-desktop' },
    // MR fast path: skip scenarios marked `slow` in the registry (scale
    // probes whose mechanisms are covered by cheap scenarios). Main and tag
    // pipelines, and local runs, execute everything.
    'skip-slow': { type: 'boolean', default: false },
    // Leave the Android leg out even when a device is reachable (fast local
    // desktop-only runs). No device at all skips it on its own, loudly.
    'no-android': { type: 'boolean', default: false },
    // Run ONLY the Android leg, and REQUIRE a usable device: the desktop mesh
    // is already covered by test:cross-platform-sync, so the dedicated
    // emulator job would be pointless work if it silently skipped (M11).
    'android-only': { type: 'boolean', default: false },
  },
});

if (args['android-only'] && args['no-android']) {
  console.error('--android-only and --no-android contradict each other');
  process.exit(1);
}

// ── Test harness ────────────────────────────────────────────────

export const results = [];
// Slot-derived, like every other port in this repo (`node scripts/lib/slot.mjs`).
// It used to be a hardcoded 4000, so every worktree started allocating at the
// same port and the second run adopted the first's server + database.
const PORT_BAND = xplatSyncBand(REPO_ROOT);
// Two ports per scenario: the server, plus the delay proxy that
// sync-test-server.mjs parks next to it for syncDelayMs scenarios.
const PORTS_PER_SCENARIO = 2;
let serverPortCounter = PORT_BAND.base;
export const suiteStartedAt = Date.now();
export const timings = {
  bootstrapMs: 0,
  clientStartupMs: 0,
  serverSetupMs: 0,
  clientResetMs: 0,
  scenarioMs: 0,
};

/** Next port pair inside this worktree's band; never the next worktree's. */
export function allocateServerPort() {
  const port = serverPortCounter;
  serverPortCounter += PORTS_PER_SCENARIO;
  if (port + PORTS_PER_SCENARIO - 1 > PORT_BAND.end) {
    throw new Error(
      `Out of ports: slot ${PORT_BAND.slot}'s band is ${PORT_BAND.base}-${PORT_BAND.end}, ` +
        `which fits ${Math.floor((PORT_BAND.end - PORT_BAND.base + 1) / PORTS_PER_SCENARIO)} ` +
        `scenarios. Walking past it would land on another worktree's ports — widen ` +
        `XPLAT_SYNC_BAND.stride in scripts/lib/slot.mjs instead.`,
    );
  }
  return port;
}
