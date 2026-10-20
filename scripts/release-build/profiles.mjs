// Repo paths, logging/exit/flag helpers, the localdev/prod profiles and their signing
// environment, shared by release-build.mjs and its localdev server.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const TAURI_DIR = join(ROOT, 'apps', 'tauri');
export const SRC_TAURI = join(TAURI_DIR, 'src-tauri');
// The localdev updater server's port. Deliberately NOT slot-derived like the
// sync/dev/MCP ports: the app under test reads its endpoint from
// tauri.updater-localdev.conf.json, which pins http://localhost:8787, so the
// server and that baked-in endpoint must agree. Two worktrees on one machine
// therefore collide here — serveDir explains that instead of serving the other
// worktree's manifest (pc_ce0dda06ddf6). Moving this onto scripts/lib/slot.mjs
// means generating that overlay too, not just changing the constant.
export const DEFAULT_PORT = 8787;

export const log = (m) => process.stdout.write(`[release-build] ${m}\n`);
// Throw (not process.exit) so try/finally blocks — notably the version restore
// in withVersionRestore — still run when a build step fails. main() catches and
// exits non-zero. Tagged so main() can print it cleanly without a stack dump.
class ReleaseBuildError extends Error {}
export const die = (m) => {
  throw new ReleaseBuildError(m);
};

/** Coerce a flag value to a string, or undefined if it was passed without a
 *  value (parseFlags sets such flags to boolean `true`). Prevents `true.replace`
 *  / `resolve(true)` crashes and a `--version` with no value writing `true`. */
export const str = (v) => (typeof v === 'string' ? v : undefined);

export function run(cmd, args, opts = {}) {
  log(`$ ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (res.status !== 0) die(`command failed (${res.status}): ${cmd} ${args.join(' ')}`);
}

// ── Profiles ───────────────────────────────────────────────────────────────
export const PROFILES = {
  localdev: {
    overlay: join(SRC_TAURI, 'tauri.updater-localdev.conf.json'),
    keyPath: join(ROOT, 'keys', 'localdev-updater.key'),
    defaultBaseUrl: `http://localhost:${DEFAULT_PORT}`,
    defaultOut: join(ROOT, 'target', 'updater-localdev'),
  },
  prod: {
    overlay: join(SRC_TAURI, 'tauri.updater-release.conf.json'),
    keyPath: null, // from TAURI_SIGNING_PRIVATE_KEY env (CI secret)
    defaultBaseUrl: null, // required: CI passes the release-asset URL prefix
    defaultOut: join(ROOT, 'target', 'updater-release'),
  },
};

/** Build the env carrying the signing key for the chosen profile. The key has no
 *  password; the empty passphrase the minisign format requires is supplied inline
 *  (`signer sign -p ""`, `cargo tauri build --ci`) so there is no password
 *  variable to manage. */
export function signingEnv(profile, environment = process.env) {
  const p = PROFILES[profile];
  if (p.keyPath) {
    if (!existsSync(p.keyPath))
      die(
        `localdev signing key missing at ${p.keyPath} (regenerate: cargo tauri signer generate -w ${p.keyPath} -p "" -f --ci)`,
      );
    const signingEnvironment = {
      ...environment,
      TAURI_SIGNING_PRIVATE_KEY: readFileSync(p.keyPath, 'utf8'),
    };
    delete signingEnvironment.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
    return signingEnvironment;
  }
  if (!environment.TAURI_SIGNING_PRIVATE_KEY)
    die('prod profile requires TAURI_SIGNING_PRIVATE_KEY in the environment (CI secret)');
  const signingEnvironment = { ...environment };
  delete signingEnvironment.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
  return signingEnvironment;
}

export function parseFlags(argv) {
  const f = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      // Accept both `--key value` and `--key=value`.
      const eq = a.indexOf('=');
      if (eq !== -1) {
        f[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) f[k] = true;
      else {
        f[k] = next;
        i++;
      }
    }
  }
  return f;
}
