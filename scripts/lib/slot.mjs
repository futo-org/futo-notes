// Do not re-derive the slot elsewhere: a fork points a live worktree at another's
// claimed devices and running servers. scripts/drift-check.mjs scans for copies.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SLOTS = 50;

// Disjoint ranges, so one worktree can run every service at once.
// tauriVite is `just tauri-dev`'s server; web is `pnpm run dev`/playwright.
export const PORT_BASES = {
  tauriVite: 5200,
  web: 5250,
  sync: 3100,
  cdp: 9330,
  // The debug MCP/QA bridge's BASE port. The plugin scans upward from it, so
  // this band is 100 wide per the plugin's scan range — but a slot only ever
  // needs its own base to be free, and a stride of 1 kept two worktrees fighting
  // over 9223. Kept clear of cdp (9330+).
  mcp: 9223,
};

// The cross-platform sync harness is the one consumer that needs a RANGE, not a
// single port: it boots a fresh server per scenario (plus a delay proxy for
// some), so `base + slot` would hand scenario 2 the neighbouring slot's port.
// Each worktree gets a disjoint BAND instead. 21000 + 50 * 100 keeps the whole
// span clear of PORT_BASES above and below Linux's default ephemeral range
// (32768+), so no random outbound connection can ever be squatting a band port.
export const XPLAT_SYNC_BAND = { base: 21000, stride: 100 };

export function slotOf(root) {
  const hex = createHash('md5').update(root).digest('hex').slice(0, 8);
  return parseInt(hex, 16) % SLOTS;
}

/** The port band tests/cross-platform-sync.mjs may allocate from. */
export function xplatSyncBand(root) {
  const slot = slotOf(root ?? worktreeRoot());
  const base = XPLAT_SYNC_BAND.base + slot * XPLAT_SYNC_BAND.stride;
  return { slot, base, end: base + XPLAT_SYNC_BAND.stride - 1 };
}

export function portsFor(root) {
  const slot = slotOf(root);
  return Object.fromEntries(Object.entries(PORT_BASES).map(([name, base]) => [name, base + slot]));
}

// From this file's path, not the cwd: shell callers run the CLI from anywhere,
// and a cwd-derived root yields a different slot without failing.
function worktreeRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
}

export function webPort(root) {
  const override = process.env.FUTO_DEV_PORT;
  if (override) {
    const port = Number(override);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`FUTO_DEV_PORT must be an integer 1-65535, got '${override}'`);
    }
    return port;
  }
  return PORT_BASES.web + slotOf(root ?? worktreeRoot());
}

export const ENV_NAMES = {
  tauriVite: 'VITE_PORT',
  web: 'WEB_VITE_PORT',
  sync: 'SYNC_PORT',
  cdp: 'CDP_PORT',
  mcp: 'FUTO_MCP_BASE_PORT',
};

export function envLines(root) {
  const ports = portsFor(root);
  return [
    `export SLOT=${slotOf(root)}`,
    ...Object.entries(ENV_NAMES).map(([key, name]) => `export ${name}=${ports[key]}`),
  ].join('\n');
}

// CLI for shell callers, which must not hash inline: stock macOS has no md5sum.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = worktreeRoot();
  const ports = portsFor(root);
  const what = process.argv[2] || 'json';
  if (what === 'slot') console.log(slotOf(root));
  else if (what === 'env') console.log(envLines(root));
  else if (what === 'json')
    console.log(JSON.stringify({ root, slot: slotOf(root), ports }, null, 2));
  else if (what in ports) console.log(ports[what]);
  else {
    console.error(
      `unknown selector '${what}' — use slot, json, env, or one of: ${Object.keys(ports).join(', ')}`,
    );
    process.exit(1);
  }
}
