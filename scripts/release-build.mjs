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
 * Everything downstream — createUpdaterArtifacts signing, the AppImage-patch→re-sign
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
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildManifest } from './build-updater-manifest.mjs';
import {
  readDesktopVersions,
  restoreDesktopVersions,
  setDesktopVersion,
  TAURI_CONF as BASE_CONF,
} from './desktop-version.mjs';
import { hostTarget } from './release-build/host-target.mjs';
import { serveLocaldev } from './release-build/localdev-server.mjs';
import {
  DEFAULT_PORT,
  PROFILES,
  ROOT,
  TAURI_DIR,
  die,
  log,
  parseFlags,
  run,
  signingEnv,
  str,
} from './release-build/profiles.mjs';
import { verifyArtifactFile } from './verify-updater-signature.mjs';

export { hostTarget, parseFlags };

export function buildConfigArguments(profile, target) {
  const arguments_ = ['--config', PROFILES[profile].overlay];
  if (target.patchAppImage) {
    arguments_.push(
      '--config',
      JSON.stringify({
        bundle: { createUpdaterArtifacts: false },
      }),
    );
  }
  return arguments_;
}

export function buildCommandEnvironment(profile, target, environment = process.env) {
  if (!target.patchAppImage) {
    return { ...signingEnv(profile, environment), NO_STRIP: 'true' };
  }
  const buildEnvironment = { ...environment, NO_STRIP: 'true' };
  delete buildEnvironment.TAURI_SIGNING_PRIVATE_KEY;
  delete buildEnvironment.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
  return buildEnvironment;
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
 *  signature must be the LAST touch — after the AppImage patch (Linux) or any OS
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

export function patchAppImage(
  dir,
  {
    scriptPath = join(ROOT, 'scripts', 'patch-appimage.mjs'),
    environment = process.env,
    execute = run,
  } = {},
) {
  if (!existsSync(scriptPath)) die(`AppImage patch script missing at ${scriptPath}`);
  const patchEnvironment = { ...environment };
  delete patchEnvironment.TAURI_SIGNING_PRIVATE_KEY;
  delete patchEnvironment.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
  execute('node', [scriptPath, '--dir', dir], { env: patchEnvironment });
}

export function finalizeAppImageArtifact({
  dir,
  artifact,
  profile,
  patch = patchAppImage,
  sign = resign,
}) {
  patch(dir);
  sign(artifact, profile);
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
export function buildOne({ profile, version }, dependencies = {}) {
  const t = dependencies.target ?? hostTarget();
  const setBuildVersion = dependencies.setBuildVersion ?? setVersion;
  const removeBundle =
    dependencies.removeBundle ?? ((dir) => rmSync(dir, { recursive: true, force: true }));
  const executeBuild =
    dependencies.executeBuild ??
    (() =>
      run(
        'cargo',
        ['tauri', 'build', '--bundles', t.bundle, ...buildConfigArguments(profile, t), '--ci'],
        {
          cwd: TAURI_DIR,
          env: buildCommandEnvironment(profile, t),
        },
      ));
  const locateArtifact = dependencies.locateArtifact ?? findArtifact;
  const finalizeArtifact = dependencies.finalizeArtifact ?? finalizeAppImageArtifact;
  const fileExists = dependencies.fileExists ?? existsSync;
  const getProfilePubkey = dependencies.getProfilePubkey ?? profilePubkey;
  const verifySignature = dependencies.verifySignature ?? verifyArtifactFile;

  setBuildVersion(version);
  removeBundle(t.dir);
  // --ci: non-interactive + use the key's empty passphrase for createUpdaterArtifacts
  // (no password prompt, no password variable).
  executeBuild();
  const artifact = locateArtifact(t.dir, t.suffix);
  if (!artifact) die(`no ${t.suffix} produced in ${t.dir}`);
  // The AppImage patch rewrites the artifact → its build-time .sig is now stale. Re-sign
  // so the .sig matches the bytes the client downloads. (Same shape as the
  // Windows Authenticode / macOS notarize re-sign in CI.)
  if (t.patchAppImage) {
    finalizeArtifact({ dir: t.dir, artifact, profile });
  }
  const sig = `${artifact}.sig`;
  if (!fileExists(sig))
    die(
      `no ${t.suffix}.sig — is createUpdaterArtifacts on in ${PROFILES[profile].overlay} and the signing key valid?`,
    );
  // Verify the .sig against the pubkey THIS profile's client bakes, exactly as a
  // client will. Catches the irreversible signing-key/baked-pubkey mismatch
  // (#1) and a stale/post-mutation .sig (#3) here, not as a silent client-side
  // rejection after publish. The localdev/e2e flow thus rehearses the real check.
  const v = verifySignature({
    pubkeyB64: getProfilePubkey(profile),
    artifactPath: artifact,
    sigPath: sig,
  });
  if (!v.ok) die(`signature verification failed for ${artifact}: ${v.reason}`);
  log(`verified ${t.platform} .sig against the ${profile} pubkey`);
  return { platform: t.platform, artifact, sig, suffix: t.suffix };
}

/** Stage artifact + sig into `out` under a space-free name and return the name. */
function stage(out, art) {
  const name = `FUTO-Notes-${art.version}-${art.platform}${art.suffix}`.replace(/ /g, '-');
  copyFileSync(art.artifact, join(out, name));
  copyFileSync(art.sig, join(out, `${name}.sig`));
  return name;
}

// ── Flows ────────────────────────────────────────────────────────────────────

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
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
