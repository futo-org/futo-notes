/**
 * Build the Tauri updater manifest (`latest.json`) for a release.
 *
 * The Tauri updater plugin fetches a static JSON manifest and compares its
 * `version` to the running app. We can't get this from `cargo tauri build`
 * directly: the build emits one `*.sig` per artifact, but the multi-platform
 * manifest that ties them together is ours to assemble. In CI the desktop
 * release jobs run on different runners (Linux / macOS / Windows), so the
 * release job collects every signed artifact + its `.sig` and calls this to
 * produce the single `latest.json` published as a release asset.
 *
 * `buildManifest()` is pure (signatures passed as strings) so it unit-tests
 * without a filesystem; the CLI wraps it, reading `.sig` files and writing out.
 *
 * Manifest shape (https://v2.tauri.app/plugin/updater/#static-json-file):
 *   { version, notes, pub_date, platforms: { "<key>": { signature, url } } }
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Platform keys the app ships self-updating builds for. */
export const KNOWN_PLATFORMS = [
  'linux-x86_64',
  'darwin-x86_64',
  'darwin-aarch64',
  'windows-x86_64',
  'windows-aarch64',
];

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Assemble + validate a Tauri updater manifest.
 *
 * @param {object} opts
 * @param {string} opts.version            release version, e.g. "1.6.0" (no leading v)
 * @param {string} opts.pubDate            RFC 3339 timestamp
 * @param {string} [opts.notes]            release notes
 * @param {Array<{platform: string, url: string, signature: string}>} opts.platforms
 *        one entry per built target; `signature` is the `.sig` *content*
 * @param {boolean} [opts.allowInsecureLocalhost]  permit http://localhost URLs
 *        (the localdev profile serves over plain HTTP). Default false so the
 *        prod manifest stays https-only.
 * @returns {{version: string, notes: string, pub_date: string, platforms: Record<string, {signature: string, url: string}>}}
 */
export function buildManifest({ version, pubDate, notes, platforms, allowInsecureLocalhost = false }) {
  if (typeof version !== 'string' || !SEMVER_RE.test(version)) {
    throw new Error(`invalid version: ${JSON.stringify(version)} (expected semver like 1.6.0)`);
  }
  if (typeof pubDate !== 'string' || !RFC3339_RE.test(pubDate)) {
    throw new Error(`invalid pubDate: ${JSON.stringify(pubDate)} (expected RFC 3339)`);
  }
  if (!Array.isArray(platforms) || platforms.length === 0) {
    throw new Error('platforms must be a non-empty array');
  }

  const out = {};
  for (const entry of platforms) {
    const { platform, url, signature } = entry ?? {};
    if (!KNOWN_PLATFORMS.includes(platform)) {
      throw new Error(`unknown platform key: ${JSON.stringify(platform)} (one of ${KNOWN_PLATFORMS.join(', ')})`);
    }
    if (out[platform]) {
      throw new Error(`duplicate platform key: ${platform}`);
    }
    const httpsOk = typeof url === 'string' && /^https:\/\//.test(url);
    const localhostOk = allowInsecureLocalhost && typeof url === 'string'
      && /^http:\/\/(localhost|127\.0\.0\.1)(?::\d+)?(?:\/|$)/.test(url);
    if (!httpsOk && !localhostOk) {
      throw new Error(`platform ${platform}: url must be https${allowInsecureLocalhost ? ' (or http://localhost)' : ''} (got ${JSON.stringify(url)})`);
    }
    if (typeof signature !== 'string' || signature.trim().length === 0) {
      throw new Error(`platform ${platform}: empty signature`);
    }
    out[platform] = { signature: signature.trim(), url };
  }

  return {
    version,
    notes: notes ?? `FUTO Notes ${version}`,
    pub_date: pubDate,
    platforms: out,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────
// node scripts/build-updater-manifest.mjs --spec spec.json --out latest.json
// spec.json: { version, pubDate?, notes?, platforms: [{ platform, url, sig }] }
//   `sig` is a PATH to the .sig file (read here); pubDate defaults to now.
function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1];
  if (!args.spec || !args.out) {
    process.stderr.write('usage: build-updater-manifest.mjs --spec <spec.json> --out <latest.json>\n');
    process.exit(1);
  }
  const spec = JSON.parse(readFileSync(args.spec, 'utf8'));
  const platforms = (spec.platforms ?? []).map((p) => ({
    platform: p.platform,
    url: p.url,
    signature: readFileSync(p.sig, 'utf8'),
  }));
  const manifest = buildManifest({
    version: spec.version,
    pubDate: spec.pubDate ?? new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    notes: spec.notes,
    platforms,
    allowInsecureLocalhost: Boolean(spec.allowInsecureLocalhost),
  });
  writeFileSync(args.out, JSON.stringify(manifest, null, 2) + '\n');
  process.stdout.write(`wrote ${args.out} (v${manifest.version}, ${Object.keys(manifest.platforms).join(', ')})\n`);
}

// Run the CLI only when invoked directly. pathToFileURL builds a correct file://
// URL on any OS; a bare `file://${process.argv[1]}` template only matches on
// POSIX (Windows backslashes + a drive letter never match import.meta.url).
// Importing for tests must not execute.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
