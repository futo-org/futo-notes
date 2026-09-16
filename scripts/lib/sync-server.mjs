// The futo-notes-server binary every sync harness runs against — ONE owner.
//
// The server is a separate repo that was rewritten in Go (2026-09-01); before
// that it was TypeScript run with `bun src/index.ts`. Four launchers had that
// command baked in (the cross-platform harness, `just qa-server`,
// scripts/start-test-server.sh, and CI), so the rewrite broke all four at once
// and every MR pipeline's sync jobs went red. They now all ask this module
// where the binary is.
//
// Resolution order:
//   1. $FUTO_NOTES_E2EE_SERVER_BIN — an already-built server (CI resolves once
//      and exports it, so parallel jobs share one download).
//   2. $FUTO_NOTES_E2EE_SERVER_REPO — a futo-notes-server checkout, compiled
//      with `go build`. This is how you test an unreleased server change.
//   3. The pinned release from scripts/sync-server-pin.json, downloaded from
//      the project's public package registry and checked against the sha256
//      pinned there — not one fetched alongside it, so a rebuilt or tampered
//      asset fails instead of quietly changing what the suite tested.
//
// Downloads are cached per version under ~/.cache/futo-notes/sync-server, so
// only the first run on a machine pays for it (~15 MB, about a second).
//
// A server runs in one of three modes (`SERVER_MODES` below): password, dev, or
// the hosted stand-in test mode the Rust hosted scenarios need. Whether the
// pinned release can do the third is `standinMode` in the pin, overridable with
// $FUTO_NOTES_E2EE_SERVER_STANDIN for a server you built yourself.
//
// CLI: `node scripts/lib/sync-server.mjs path`     prints the binary path
//      `node scripts/lib/sync-server.mjs version`  prints the pinned version
//      `node scripts/lib/sync-server.mjs standin`  says whether stand-in mode is available
//      `node scripts/lib/sync-server.mjs refresh`  prints an updated pin block

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatSpawnFailure } from './spawn-result.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** @type {{version: string, standinMode: boolean, packageUrl: string, binaries: Record<string, {asset: string, sha256: string}>}} */
export const SERVER_PIN = JSON.parse(
  readFileSync(join(HERE, '..', 'sync-server-pin.json'), 'utf8'),
);

/** The release tag the harness is pinned to, e.g. "v0.7.0". */
export const PINNED_SERVER_VERSION = SERVER_PIN.version;

/** The password every harness-started server accepts. */
export const SERVER_PASSWORD = 'testing123';

function cacheRoot() {
  if (process.env.FUTO_NOTES_SERVER_CACHE) return resolve(process.env.FUTO_NOTES_SERVER_CACHE);
  const base = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(base, 'futo-notes', 'sync-server');
}

function binaryName() {
  return process.platform === 'win32' ? 'futo-notes-server.exe' : 'futo-notes-server';
}

/**
 * Resolve the sync server binary, downloading the pinned release on first use.
 *
 * `expectedVersion` is the tag the binary should report at `GET /` — null when
 * the caller pointed us at their own build, which carries no release stamp.
 *
 * @returns {Promise<{path: string, expectedVersion: string | null, source: string}>}
 */
export async function syncServerBinary() {
  const override = process.env.FUTO_NOTES_E2EE_SERVER_BIN;
  if (override) {
    const path = resolve(override);
    if (!existsSync(path)) {
      throw new Error(`FUTO_NOTES_E2EE_SERVER_BIN points at ${path}, which does not exist.`);
    }
    return { path, expectedVersion: null, source: 'FUTO_NOTES_E2EE_SERVER_BIN' };
  }

  const repo = process.env.FUTO_NOTES_E2EE_SERVER_REPO;
  if (repo) return { ...buildFromCheckout(resolve(repo)), expectedVersion: null };

  return { ...(await downloadPinned()), expectedVersion: PINNED_SERVER_VERSION };
}

/**
 * The three shapes a harness-started server comes in.
 *
 *   password — `AUTH_MODE=password`, one shared password. The cross-platform
 *              suite and `scripts/start-test-server.sh` want this.
 *   dev      — `AUTH_MODE=dev`, one fixed identity (`local@futo-notes.local`),
 *              no password. The Rust `server_integration` suite asserts
 *              `auth_mode == "dev"` and posts to `/api/auth/dev/login`.
 *   standin  — hosted/OIDC mode against the server's in-process stand-ins for
 *              Zitadel and Polar, so a suite can drive Log in with FUTO,
 *              checkout and billing with no network and no credentials. This
 *              is what the hosted scenarios in `server_integration` need.
 *              See the server's docs/adr/0009-stand-in-test-mode.md.
 */
export const SERVER_MODES = ['password', 'dev', 'standin'];

/**
 * What a running server in each mode reports as `auth_mode` at `GET /`.
 *
 * Next to `SERVER_MODES` on purpose: a launcher asserts the mode it asked for
 * is the mode it got, and a new mode without an entry here would make that
 * assertion compare against `undefined`.
 */
export const REPORTED_AUTH_MODE = { password: 'password', dev: 'dev', standin: 'oidc' };

/**
 * The settings `STANDIN_MODE=true` REFUSES TO BOOT ALONGSIDE, because each one
 * names a real identity provider, a real payment provider or a real sign-up
 * gate, and stand-in mode replaces what they name with fakes (ADR 0009).
 *
 * This matters to a launcher because a server process inherits the shell's
 * environment: one stray `AUTH_MODE=password` exported in the session that
 * starts the harness turns the stand-in server into a boot failure. So the
 * stand-in patch names every one of them as `undefined`, and
 * `serverProcessEnv` drops those keys from the child's environment rather than
 * passing them through.
 */
export const STANDIN_REFUSED_VARS = [
  'OIDC_ISSUER',
  'OIDC_CLIENT_ID',
  'OIDC_CLIENT_SECRET',
  'OIDC_REDIRECT_URI',
  'POLAR_BASE_URL',
  'POLAR_ACCESS_TOKEN',
  'POLAR_PRODUCT_ID',
  'POLAR_WEBHOOK_SECRET',
  'POLAR_DISCOUNT_ID',
  'HOSTED_ALLOWED_EMAIL_DOMAINS',
  // Refused unless unset or `oidc` / `false` respectively; a launcher never
  // wants either, so both are simply cleared.
  'AUTH_MODE',
  'COOKIE_SECURE',
];

/**
 * Environment for a server with its own SQLite database and blob directory
 * under `dataDir`. Every harness gets a private database this way, so nothing
 * has to reset shared tables between runs.
 *
 * Returns a PATCH, not a whole environment — pass it through
 * `serverProcessEnv` to get what the child process should actually see.
 *
 * @param {{port: number, dataDir: string, mode?: string, password?: string}} options
 */
export function syncServerEnv({ port, dataDir, mode = 'password', password = SERVER_PASSWORD }) {
  if (!SERVER_MODES.includes(mode)) {
    throw new Error(`Unknown sync server mode '${mode}'. Supported: ${SERVER_MODES.join(', ')}.`);
  }
  const blobDir = join(dataDir, 'blobs');
  mkdirSync(blobDir, { recursive: true });
  const base = {
    PORT: String(port),
    BLOB_DIR: blobDir,
    DATABASE_URL: `sqlite:${join(dataDir, 'notes.db')}`,
  };
  if (mode === 'dev') return { ...base, AUTH_MODE: 'dev' };
  if (mode === 'standin') {
    // STANDIN_MODE supplies the hosted settings itself and binds loopback only.
    return {
      ...base,
      STANDIN_MODE: 'true',
      ...Object.fromEntries(STANDIN_REFUSED_VARS.map((name) => [name, undefined])),
    };
  }
  return { ...base, AUTH_MODE: 'password', FUTO_NOTES_PASSWORD: password };
}

/**
 * The environment a server child process gets: this process's, with `patch`
 * applied and every key `patch` maps to `undefined` REMOVED.
 *
 * Node keeps a key whose value is the string `"undefined"` and the server
 * reads that as set, so deleting is the only thing that clears an inherited
 * variable.
 *
 * @param {Record<string, string | undefined>} patch
 */
export function serverProcessEnv(patch) {
  const env = { ...process.env };
  for (const [name, value] of Object.entries(patch)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return env;
}

/**
 * Whether the server this harness will run can be started in stand-in mode.
 *
 * `standinMode` in the pin says whether the pinned RELEASE carries it;
 * `$FUTO_NOTES_E2EE_SERVER_STANDIN` overrides that either way, which is how you
 * run the hosted scenarios against a server you built yourself from an
 * unreleased branch.
 *
 * @returns {{available: boolean, why: string}}
 */
export function standinModeAvailable() {
  const override = process.env.FUTO_NOTES_E2EE_SERVER_STANDIN;
  if (override !== undefined && override !== '') {
    // Not a truthiness test: `FUTO_NOTES_E2EE_SERVER_STANDIN=yes` meaning
    // "off" is a whole suite silently not running.
    if (!['1', 'true', '0', 'false'].includes(override)) {
      throw new Error(
        `FUTO_NOTES_E2EE_SERVER_STANDIN must be 1, true, 0 or false — got '${override}'.`,
      );
    }
    return {
      available: override === '1' || override === 'true',
      why: `FUTO_NOTES_E2EE_SERVER_STANDIN=${override}`,
    };
  }
  if (SERVER_PIN.standinMode === true) {
    return { available: true, why: `the pinned ${PINNED_SERVER_VERSION} release carries it` };
  }
  return {
    available: false,
    why:
      `the pinned ${PINNED_SERVER_VERSION} release predates stand-in test mode ` +
      `("standinMode": false in scripts/sync-server-pin.json)`,
  };
}

/**
 * The version a running server reports at `GET /`. The harness compares it with
 * `expectedVersion` so a run can never quietly happen against some other
 * server that won the port (M11: assert the thing the job exists to prove).
 *
 * @param {string} baseUrl
 */
export async function reportedServerVersion(baseUrl) {
  return (await serverCapabilities(baseUrl)).version;
}

/**
 * The capability document a running server serves at `GET /` — the one place
 * it says its version and its auth mode.
 *
 * @param {string} baseUrl
 */
export async function serverCapabilities(baseUrl) {
  const response = await fetch(baseUrl.replace(/\/$/, '') + '/');
  if (!response.ok) throw new Error(`capability probe returned HTTP ${response.status}`);
  return await response.json();
}

// ── Sources ─────────────────────────────────────────────────────────

function buildFromCheckout(repo) {
  if (!existsSync(join(repo, 'go.mod'))) {
    throw new Error(
      `FUTO_NOTES_E2EE_SERVER_REPO points at ${repo}, which has no go.mod.\n` +
        `futo-notes-server is a Go project since 2026-09-01 — an older TypeScript checkout ` +
        `cannot be used. Unset the variable to run the pinned ${PINNED_SERVER_VERSION} release instead.`,
    );
  }
  // Build outside the checkout: it is somebody's working tree, not ours to dirty.
  const out = join(cacheRoot(), 'local', binaryName());
  mkdirSync(dirname(out), { recursive: true });
  const build = spawnSync('go', ['build', '-o', out, './cmd/server'], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, GOTOOLCHAIN: process.env.GOTOOLCHAIN || 'auto' },
  });
  if (build.error?.code === 'ENOENT') {
    throw new Error(
      `Building ${repo} needs the Go toolchain, which is not on PATH.\n` +
        `Install Go, or unset FUTO_NOTES_E2EE_SERVER_REPO to download the pinned ` +
        `${PINNED_SERVER_VERSION} release instead.`,
    );
  }
  if (build.status !== 0) {
    throw new Error(`go build failed in ${repo}: ${formatSpawnFailure(build, 'go')}`);
  }
  return { path: out, source: `go build (${repo})` };
}

async function downloadPinned() {
  const key = `${process.platform}-${process.arch}`;
  const entry = SERVER_PIN.binaries[key];
  if (!entry) {
    throw new Error(
      `No pinned futo-notes-server build for ${key}. Supported: ` +
        `${Object.keys(SERVER_PIN.binaries).join(', ')}. Build the server yourself and point ` +
        `FUTO_NOTES_E2EE_SERVER_BIN at it.`,
    );
  }

  const dir = join(cacheRoot(), SERVER_PIN.version);
  const path = join(dir, binaryName());
  if (existsSync(path)) return { path, source: `cached ${SERVER_PIN.version}` };

  const url = `${SERVER_PIN.packageUrl}/${SERVER_PIN.version}/${entry.asset}`;
  const response = await fetch(url).catch((err) => {
    throw new Error(`Downloading ${url} failed: ${err.message}`);
  });
  if (!response.ok) {
    throw new Error(`Downloading ${url} returned HTTP ${response.status} ${response.statusText}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());

  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== entry.sha256) {
    throw new Error(
      `Checksum mismatch for ${entry.asset}\n  expected ${entry.sha256}\n  got      ${actual}\n` +
        `Refusing to run a server this repo did not pin (scripts/sync-server-pin.json).`,
    );
  }

  // Write beside the target and rename, so a second worktree downloading the
  // same version concurrently can never see a half-written binary.
  mkdirSync(dir, { recursive: true });
  const staging = `${path}.${process.pid}.part`;
  try {
    writeFileSync(staging, bytes);
    chmodSync(staging, 0o755);
    renameSync(staging, path);
  } catch (err) {
    rmSync(staging, { force: true });
    throw err;
  }
  return { path, source: `downloaded ${SERVER_PIN.version}` };
}

// ── Pin maintenance ─────────────────────────────────────────────────

/** Print a pin block for the newest published release, for a copy-paste bump. */
async function refresh() {
  const api = SERVER_PIN.packageUrl.replace(/\/packages\/generic\/.*$/, '');
  const packages = await (await fetch(`${api}/packages?per_page=100`)).json();
  const releases = packages
    .filter((pkg) => pkg.name === 'futo-notes-server')
    .sort((a, b) => compareVersions(a.version, b.version));
  const newest = releases.at(-1);
  if (!newest) throw new Error(`No futo-notes-server packages found at ${api}/packages`);

  const files = await (await fetch(`${api}/packages/${newest.id}/package_files`)).json();
  const platforms = {
    'linux-x64': '_linux_amd64',
    'linux-arm64': '_linux_arm64',
    'darwin-x64': '_darwin_amd64',
    'darwin-arm64': '_darwin_arm64',
    'win32-x64': '_windows_amd64.exe',
  };
  const binaries = {};
  for (const [key, suffix] of Object.entries(platforms)) {
    const file = files.find((f) => f.file_name.endsWith(suffix));
    if (!file) throw new Error(`${newest.version} publishes no ${suffix} binary`);
    binaries[key] = { asset: file.file_name, sha256: file.file_sha256 };
  }
  console.log(
    JSON.stringify(
      {
        version: newest.version,
        // Carried through rather than re-derived: only a person who has read
        // the release notes knows whether it carries stand-in test mode. A
        // bump that leaves this false runs the hosted scenarios against the
        // stub only, and says so on every run.
        standinMode: SERVER_PIN.standinMode === true,
        packageUrl: SERVER_PIN.packageUrl,
        binaries,
      },
      null,
      2,
    ),
  );
  if (newest.version === SERVER_PIN.version) console.error(`(already pinned to ${newest.version})`);
  if (SERVER_PIN.standinMode !== true) {
    console.error(
      `(set "standinMode": true if ${newest.version} carries futo-notes-server#14-#17, ` +
        `so the hosted Rust scenarios run against a real server)`,
    );
  }
}

function compareVersions(a, b) {
  const parts = (v) => v.replace(/^v/, '').split('.').map(Number);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] || 'path';
  try {
    if (command === 'version') console.log(PINNED_SERVER_VERSION);
    else if (command === 'standin') {
      const { available, why } = standinModeAvailable();
      console.log(`${available} (${why})`);
    } else if (command === 'refresh') await refresh();
    else if (command === 'path') console.log((await syncServerBinary()).path);
    else {
      console.error(`usage: node scripts/lib/sync-server.mjs [path|version|standin|refresh]`);
      process.exit(2);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
