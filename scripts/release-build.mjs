/**
 * Profile-based updater release builder — the SAME machinery for local dry-runs
 * and the real CI release, so a local "verified build" exercises the exact path
 * production does. Only three things differ between profiles, and all three are
 * inputs, not code:
 *
 *   1. host      — where the manifest + artifacts are served (endpoint URL)
 *   2. signing   — the private key used at build time (TAURI_SIGNING_PRIVATE_KEY)
 *   3. verifying — the pubkey baked into the app (in the chosen config overlay)
 *
 * Everything downstream — createUpdaterArtifacts signing, the mesa-patch→re-sign
 * ordering, manifest assembly (build-updater-manifest.mjs), and the client's
 * check→download→verify→swap→relaunch — is identical.
 *
 *   localdev : overlay tauri.updater-localdev.conf.json  (localhost endpoint +
 *              committed throwaway pubkey + insecure transport), signed by the
 *              committed keys/localdev-updater.key. Served on localhost.
 *   prod     : overlay tauri.updater-release.conf.json (prod endpoint + pubkey
 *              from base config), signed by TAURI_SIGNING_PRIVATE_KEY from CI.
 *              Artifacts + manifest written to --out; CI uploads them.
 *
 * Trust boundary: a localdev-signed artifact can NEVER be accepted by a prod
 * client — prod bakes the prod pubkey and rejects anything the localdev key
 * signed. So the localdev key is a fixture, safe to commit. updaterConfig.test.ts
 * guards that localhost/insecure/the localdev key never leak into base or prod.
 */
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import {
  createReadStream,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildManifest } from './build-updater-manifest.mjs';
import {
  readDesktopVersions,
  restoreDesktopVersions,
  setDesktopVersion,
  TAURI_CONF as BASE_CONF,
} from './desktop-version.mjs';
import { verifyArtifactFile } from './verify-updater-signature.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TAURI_DIR = join(ROOT, 'apps', 'tauri');
const SRC_TAURI = join(TAURI_DIR, 'src-tauri');
const DEFAULT_PORT = 8787;

const log = (m) => process.stdout.write(`[release-build] ${m}\n`);
// Throw (not process.exit) so try/finally blocks — notably the version restore
// in withVersionRestore — still run when a build step fails. main() catches and
// exits non-zero. Tagged so main() can print it cleanly without a stack dump.
class ReleaseBuildError extends Error {}
const die = (m) => {
  throw new ReleaseBuildError(m);
};

/** Coerce a flag value to a string, or undefined if it was passed without a
 *  value (parseFlags sets such flags to boolean `true`). Prevents `true.replace`
 *  / `resolve(true)` crashes and a `--version` with no value writing `true`. */
const str = (v) => (typeof v === 'string' ? v : undefined);

function run(cmd, args, opts = {}) {
  log(`$ ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (res.status !== 0) die(`command failed (${res.status}): ${cmd} ${args.join(' ')}`);
}

// ── Profiles ───────────────────────────────────────────────────────────────
const PROFILES = {
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
function signingEnv(profile) {
  const p = PROFILES[profile];
  if (p.keyPath) {
    if (!existsSync(p.keyPath))
      die(
        `localdev signing key missing at ${p.keyPath} (regenerate: cargo tauri signer generate -w ${p.keyPath} -p "" -f --ci)`,
      );
    return { ...process.env, TAURI_SIGNING_PRIVATE_KEY: readFileSync(p.keyPath, 'utf8') };
  }
  if (!process.env.TAURI_SIGNING_PRIVATE_KEY)
    die('prod profile requires TAURI_SIGNING_PRIVATE_KEY in the environment (CI secret)');
  return { ...process.env };
}

// ── Per-OS updater artifact shape ────────────────────────────────────────────
// The updater artifact is NOT always the installer you distribute: Linux ships
// the AppImage (deb/rpm self-update via the system repo); macOS the app.tar.gz
// (not the .dmg); Windows the NSIS setup.exe.
export function hostTarget(platform = process.platform, arch = process.arch) {
  const a = arch === 'arm64' ? 'aarch64' : 'x86_64';
  switch (platform) {
    case 'linux':
      // x86_64 only — we don't ship a linux-aarch64 AppImage (and that key isn't
      // in the manifest's KNOWN_PLATFORMS).
      return {
        platform: 'linux-x86_64',
        bundle: 'appimage',
        dir: join(ROOT, 'target', 'release', 'bundle', 'appimage'),
        suffix: '.AppImage',
        mesaPatch: true,
      };
    case 'darwin':
      return {
        platform: `darwin-${a}`,
        bundle: 'app',
        dir: join(ROOT, 'target', 'release', 'bundle', 'macos'),
        suffix: '.app.tar.gz',
        mesaPatch: false,
      };
    case 'win32':
      return {
        platform: `windows-${a}`,
        bundle: 'nsis',
        dir: join(ROOT, 'target', 'release', 'bundle', 'nsis'),
        suffix: '-setup.exe',
        mesaPatch: false,
      };
    default:
      return die(`unsupported platform: ${platform}`);
  }
}

function findArtifact(dir, suffix) {
  if (!existsSync(dir)) return null;
  const hits = readdirSync(dir)
    .filter((f) => f.endsWith(suffix))
    .map((f) => join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return hits[0] || null;
}

/** Re-sign a file in place (regenerates `<file>.sig`). The detached updater
 *  signature must be the LAST touch — after the mesa patch (Linux) or any OS
 *  signing/notarization step that rewrites the artifact bytes. */
function resign(file, profile) {
  rmSync(`${file}.sig`, { force: true });
  // -p "": the key has no password; pass the empty passphrase inline so the
  // signer never drops to an interactive prompt (it has no --ci fallback).
  run('cargo', ['tauri', 'signer', 'sign', '-p', '', file], {
    cwd: TAURI_DIR,
    env: signingEnv(profile),
  });
}

function mesaPatch(dir) {
  const patch = join(ROOT, 'scripts', 'patch-appimage-mesa26.mjs');
  if (!existsSync(patch)) {
    log('mesa26 patch script absent — skipping');
    return;
  }
  run('node', [patch, '--dir', dir]);
}

/** Stamp both desktop version sources: Tauri's generated package info reads
 *  tauri.conf.json, while Rust-only crash reports read CARGO_PKG_VERSION from
 *  Cargo.toml. CI's .set-version does the same from the tag; this covers local
 *  multi-version builds. */
function setVersion(version) {
  setDesktopVersion(version);
}
const readBaseVersion = () => readDesktopVersions().tauriConfig;

/** The minisign pubkey the chosen profile's CLIENT bakes: localdev from its
 *  overlay, prod inherited from the base config (the release overlay adds no
 *  updater block). Used to verify each built .sig the same way a client will. */
function profilePubkey(profile) {
  const file = profile === 'localdev' ? PROFILES.localdev.overlay : BASE_CONF;
  const pk = JSON.parse(readFileSync(file, 'utf8'))?.plugins?.updater?.pubkey;
  if (!pk) die(`no plugins.updater.pubkey in ${file}`);
  return pk;
}

/** Run `fn`, then ALWAYS restore both desktop version sources to what they
 *  were on entry — even if `fn` throws (die() throws, so finally runs). Keeps
 *  the working tree clean across local builds and failed builds alike. */
function withVersionRestore(fn) {
  const original = readDesktopVersions();
  try {
    return fn();
  } finally {
    restoreDesktopVersions(original);
  }
}
export const bumpPatch = (v) => {
  const m = String(v).match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
  if (!m) die(`unparseable version ${v}`);
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}${m[4]}`;
};

/**
 * Build one signed updater artifact for the host platform at `version`.
 * Returns { platform, artifact, sig } with absolute paths. Identical for both
 * profiles except which overlay + signing key (resolved from `profile`).
 * Always rebuilds — the manifest version must match the artifact's bytes, so
 * there is no "reuse a stale artifact" path (cargo's incremental cache makes
 * rebuilds cheap enough).
 */
function buildOne({ profile, version }) {
  const t = hostTarget();
  setVersion(version);
  if (process.platform === 'linux') run('node', [join(ROOT, 'scripts', 'fetch-ort-linux.mjs')]);
  rmSync(t.dir, { recursive: true, force: true });
  // --ci: non-interactive + use the key's empty passphrase for createUpdaterArtifacts
  // (no password prompt, no password variable).
  run(
    'cargo',
    ['tauri', 'build', '--bundles', t.bundle, '--config', PROFILES[profile].overlay, '--ci'],
    {
      cwd: TAURI_DIR,
      env: { ...signingEnv(profile), NO_STRIP: 'true' },
    },
  );
  const artifact = findArtifact(t.dir, t.suffix);
  if (!artifact) die(`no ${t.suffix} produced in ${t.dir}`);
  // Mesa patch rewrites the AppImage → its build-time .sig is now stale. Re-sign
  // so the .sig matches the bytes the client downloads. (Same shape as the
  // Windows Authenticode / macOS notarize re-sign in CI.)
  if (t.mesaPatch) {
    mesaPatch(t.dir);
    resign(artifact, profile);
  }
  const sig = `${artifact}.sig`;
  if (!existsSync(sig))
    die(
      `no ${t.suffix}.sig — is createUpdaterArtifacts on in ${PROFILES[profile].overlay} and the signing key valid?`,
    );
  // Verify the .sig against the pubkey THIS profile's client bakes, exactly as a
  // client will. Catches the irreversible signing-key/baked-pubkey mismatch
  // (#1) and a stale/post-mutation .sig (#3) here, not as a silent client-side
  // rejection after publish. The localdev/e2e flow thus rehearses the real check.
  const v = verifyArtifactFile({
    pubkeyB64: profilePubkey(profile),
    artifactPath: artifact,
    sigPath: sig,
  });
  if (!v.ok) die(`signature verification failed for ${artifact}: ${v.reason}`);
  log(`verified ${t.platform} .sig against the ${profile} pubkey`);
  return { platform: t.platform, artifact, sig, suffix: t.suffix };
}

function serveDir(dir, port) {
  const types = {
    '.json': 'application/json',
    '.gz': 'application/gzip',
    '.tar': 'application/x-tar',
    '.AppImage': 'application/octet-stream',
    '.exe': 'application/octet-stream',
  };
  const root = resolve(dir);
  const server = createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    const file = resolve(root, urlPath.replace(/^\/+/, ''));
    const within = file === root || file.startsWith(root + sep);
    if (!within || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found\n');
      log(`404 ${urlPath}`);
      return;
    }
    const ext = Object.keys(types).find((e) => file.endsWith(e));
    res.writeHead(200, {
      'content-type': ext ? types[ext] : 'application/octet-stream',
      'content-length': statSync(file).size,
    });
    log(`200 ${urlPath}`);
    createReadStream(file).pipe(res);
  });
  server.listen(port, 'localhost', () =>
    log(`serving ${dir} at http://localhost:${port} (manifest: /latest.json)`),
  );
  return server;
}

/** Stage artifact + sig into `out` under a space-free name and return the name. */
function stage(out, art) {
  const name = `FUTO-Notes-${art.version}-${art.platform}${art.suffix}`.replace(/ /g, '-');
  copyFileSync(art.artifact, join(out, name));
  copyFileSync(art.sig, join(out, `${name}.sig`));
  return name;
}

// ── Flows ────────────────────────────────────────────────────────────────────
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

function cmdBuild(profile, flags) {
  const p = PROFILES[profile];
  const out = resolve(str(flags.out) || p.defaultOut);
  const baseUrl = (str(flags['base-url']) || p.defaultBaseUrl || '').replace(/\/$/, '');
  if (!baseUrl)
    die(
      'prod profile requires --base-url <url> (the release-asset URL prefix that hosts the artifacts)',
    );
  const version = str(flags.version) || readBaseVersion();

  withVersionRestore(() => {
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });

    const built = buildOne({ profile, version });
    const name = stage(out, { ...built, version });
    const manifest = buildManifest({
      version,
      pubDate: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      notes: str(flags.notes),
      platforms: [
        {
          platform: built.platform,
          url: `${baseUrl}/${name}`,
          signature: readFileSync(built.sig, 'utf8'),
        },
      ],
      allowInsecureLocalhost: profile === 'localdev',
    });
    writeFileSync(join(out, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n');
    log(`wrote ${join(out, 'latest.json')} (v${version}, ${built.platform})`);

    if (profile === 'prod') {
      log('prod profile: artifacts + latest.json written; CI uploads them as release assets.');
      return;
    }
    if (flags.serve) serveLocaldev(out);
    else log(`localdev build ready in ${out}. Add --serve to host it.`);
  });
}

/** localdev two-build E2E: build the OLD app you run, then build + serve the NEW
 *  update. Both use the localdev overlay (localhost endpoint + localdev pubkey),
 *  so the OLD app checks localhost and verifies the NEW artifact's signature. */
function cmdE2e(flags) {
  if (process.platform !== 'linux')
    die(
      'e2e is Linux/AppImage only (it builds the OLD app you run); on mac/Windows build manually',
    );
  const out = resolve(str(flags.out) || PROFILES.localdev.defaultOut);
  const baseUrl = (str(flags['base-url']) || PROFILES.localdev.defaultBaseUrl).replace(/\/$/, '');
  const oldVer = str(flags.old) || readBaseVersion();
  const newVer = str(flags.new) || bumpPatch(oldVer);
  if (oldVer === newVer) die(`old (${oldVer}) and new (${newVer}) must differ`);

  withVersionRestore(() => {
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });

    log(`Building OLD AppImage v${oldVer} (the app you run) …`);
    const oldArt = buildOne({ profile: 'localdev', version: oldVer });
    const oldRun = join(out, `FUTO-Notes-${oldVer}.AppImage`);
    copyFileSync(oldArt.artifact, oldRun);
    spawnSync('chmod', ['+x', oldRun]);

    log(`Building NEW AppImage v${newVer} (the update offered) …`);
    const newArt = buildOne({ profile: 'localdev', version: newVer });
    const name = stage(out, { ...newArt, version: newVer });
    const manifest = buildManifest({
      version: newVer,
      pubDate: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      platforms: [
        {
          platform: newArt.platform,
          url: `${baseUrl}/${name}`,
          signature: readFileSync(newArt.sig, 'utf8'),
        },
      ],
      allowInsecureLocalhost: true,
    });
    writeFileSync(join(out, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n');

    log('');
    log('──────────────────────────────────────────────────────────────');
    log(
      'READY. In another terminal, run the OLD app (notes isolated under ' +
        join(out, 'notes') +
        '):',
    );
    // env VAR=val works in both bash and fish (bash-only VAR=val cmd does not).
    log(`  env FUTO_NOTES_DATA_DIR='${out}' '${oldRun}'`);
    log('Then: Settings → Updates → Check  (or wait for the launch auto-check).');
    log(
      `Expect: offers v${newVer} → download → verify → swap → relaunch → version shows v${newVer}.`,
    );
    log('──────────────────────────────────────────────────────────────');
    serveLocaldev(out);
  });
}

function serveLocaldev(out) {
  const port = DEFAULT_PORT;
  log(`Serving the update now (Ctrl-C to stop):`);
  serveDir(out, port);
}

const USAGE = `usage: node scripts/release-build.mjs <build|e2e> --profile <localdev|prod> [opts]

  build  --profile localdev [--serve] [--version X.Y.Z]
         --profile prod --base-url <url> [--out <dir>] [--version X.Y.Z]
           Build one signed updater artifact for the host platform + latest.json.
           prod writes to --out for CI to upload; localdev can --serve on :${DEFAULT_PORT}.

  e2e    [--old X.Y.Z] [--new X.Y.Z]   (localdev, Linux only)
           Build the OLD app + the NEW update, serve it, print run instructions.
           The full local mirror of the prod flow with the localdev keypair.

  opts:  --base-url <prefix>  artifact host (manifest urls); localdev defaults to
                              http://localhost:${DEFAULT_PORT}, prod is required
         --out <dir>          output dir (default target/updater-<profile>)`;

function main(argv) {
  const [cmd, ...rest] = argv;
  const flags = parseFlags(rest);
  const profile = flags.profile;
  switch (cmd) {
    case 'build':
      if (!PROFILES[profile]) die(`--profile must be localdev or prod`);
      cmdBuild(profile, flags);
      break;
    case 'e2e':
      cmdE2e(flags);
      break;
    default:
      process.stdout.write(USAGE + '\n');
      process.exit(cmd ? 1 : 0);
  }
}

// Run the CLI only when invoked directly — importing for tests must not execute.
// pathToFileURL builds a correct file:// URL from a native path on any OS. The
// bare `file://${process.argv[1]}` template assumed POSIX: on Windows argv[1] is
// `C:\…\release-build.mjs` (backslashes + drive letter), so the template made
// `file://C:\…` which never equals the real import.meta.url
// (`file:///C:/…/release-build.mjs`) — the guard was always false and the CLI
// silently no-op'd.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
