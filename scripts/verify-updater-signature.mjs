/**
 * Pure-Node minisign verifier for desktop updater artifacts.
 *
 * Guards the most catastrophic updater failure mode: if the prod pubkey baked
 * into `tauri.conf.json` does NOT correspond to the private key
 * (`TAURI_SIGNING_PRIVATE_KEY`) that CI signs with, every shipped client rejects
 * every update's signature *forever* — and the baked pubkey can't be rotated on
 * existing installs (keys/README.md). Signing still "succeeds" in that case (the
 * artifact is correctly minisigned, just by a key the clients don't trust), so
 * this verifier is the only thing that catches it.
 *
 * Verifies a built artifact's `.sig` against the BAKED pubkey — exactly what a
 * client does — so a key mismatch, a stale `.sig` left over from a prior build,
 * or a `.sig` that doesn't match the OS-signed bytes all fail loudly BEFORE
 * publish. `release-build.mjs` runs it on every localdev/prod build; CI's
 * `release:` runs it against the prod pubkey before assembling latest.json.
 *
 * Tauri `.sig` files are base64 of a minisign signature file:
 *   untrusted comment: ...
 *   <base64: sig_algo(2) | key_id(8) | ed25519_sig(64)>
 *   trusted comment: timestamp:... file:...
 *   <base64: ed25519 global_sig(64)>
 * Signature algo "ED" = prehashed (the signed message is BLAKE2b-512(file));
 * "Ed" = legacy (the file itself). rsign2/Tauri emit prehashed.
 *
 * Pure stdlib (crypto's ed25519 + blake2b512) — no minisign binary, no deps.
 */
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

// SPKI DER prefix for an Ed25519 public key; append the raw 32-byte key.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function ed25519PublicKey(raw32) {
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw32]),
    format: 'der',
    type: 'spki',
  });
}

/** Parse a base64 minisign public key (the value baked in tauri.conf.json). */
export function parseMinisignPubkey(b64) {
  const lines = Buffer.from(b64, 'base64')
    .toString('utf8')
    .split('\n')
    .filter((l) => l.length > 0);
  const raw = Buffer.from(lines[lines.length - 1], 'base64'); // last line = key data
  if (raw.length !== 42) throw new Error(`bad minisign pubkey length ${raw.length} (expected 42)`);
  return { algo: raw.subarray(0, 2), keyId: raw.subarray(2, 10), key: raw.subarray(10, 42) };
}

/** Parse a Tauri `.sig` (base64 of a minisign signature file). */
export function parseTauriSig(sigB64) {
  const lines = Buffer.from(sigB64.trim(), 'base64').toString('utf8').split('\n');
  const blob = Buffer.from(lines[1], 'base64');
  if (blob.length !== 74)
    throw new Error(`bad minisign signature length ${blob.length} (expected 74)`);
  return {
    algo: blob.subarray(0, 2),
    keyId: blob.subarray(2, 10),
    sig: blob.subarray(10, 74),
    trustedComment: (lines[2] ?? '').replace(/^trusted comment: /, ''),
    globalSig: lines[3] ? Buffer.from(lines[3], 'base64') : null,
    prehashed: blob[0] === 0x45 && blob[1] === 0x44, // "ED"
  };
}

/**
 * Verify `fileBytes` against `sigB64` using the minisign `pubkeyB64`.
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function verifyUpdaterSignature({ pubkeyB64, fileBytes, sigB64 }) {
  let pub, s;
  try {
    pub = parseMinisignPubkey(pubkeyB64);
  } catch (e) {
    return { ok: false, reason: `pubkey parse: ${e.message}` };
  }
  try {
    s = parseTauriSig(sigB64);
  } catch (e) {
    return { ok: false, reason: `signature parse: ${e.message}` };
  }
  // A different key id means the artifact was signed by a key OTHER than the one
  // the client bakes — the exact wrong-key/rotation foot-gun this guards against.
  if (!pub.keyId.equals(s.keyId)) {
    return {
      ok: false,
      reason: `key id mismatch: signature ${s.keyId.toString('hex')} != baked pubkey ${pub.keyId.toString('hex')}`,
    };
  }
  const key = ed25519PublicKey(pub.key);
  const message = s.prehashed ? createHash('blake2b512').update(fileBytes).digest() : fileBytes;
  if (!edVerify(null, message, key, s.sig)) {
    return {
      ok: false,
      reason:
        'signature does not verify against the artifact bytes + pubkey (stale .sig or tampered artifact)',
    };
  }
  if (s.globalSig) {
    const globalMsg = Buffer.concat([s.sig, Buffer.from(s.trustedComment, 'utf8')]);
    if (!edVerify(null, globalMsg, key, s.globalSig)) {
      return { ok: false, reason: 'global signature (trusted comment) does not verify' };
    }
  }
  return { ok: true };
}

/** Verify an artifact file against its `.sig` file using `pubkeyB64`. */
export function verifyArtifactFile({ pubkeyB64, artifactPath, sigPath }) {
  return verifyUpdaterSignature({
    pubkeyB64,
    fileBytes: readFileSync(artifactPath),
    sigB64: readFileSync(sigPath, 'utf8'),
  });
}

/** Read the prod pubkey baked into the base tauri.conf.json. */
export function bakedProdPubkey(root) {
  const conf = JSON.parse(
    readFileSync(resolve(root, 'apps/tauri/src-tauri/tauri.conf.json'), 'utf8'),
  );
  const pk = conf?.plugins?.updater?.pubkey;
  if (typeof pk !== 'string' || pk.length === 0)
    throw new Error('no plugins.updater.pubkey in tauri.conf.json');
  return pk;
}

// ── CLI ──────────────────────────────────────────────────────────────────
// node scripts/verify-updater-signature.mjs [--pubkey <b64>] \
//      --artifact a.AppImage --sig a.AppImage.sig [--artifact b --sig b.sig ...]
// Without --pubkey, uses the baked prod pubkey from tauri.conf.json.
// Exits non-zero if ANY pair fails (so CI's release: aborts before publishing).
function main(argv) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  let pubkeyB64 = null;
  const pairs = [];
  let pendingArtifact = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pubkey') pubkeyB64 = argv[++i];
    else if (a === '--artifact') pendingArtifact = argv[++i];
    else if (a === '--sig') {
      pairs.push({ artifactPath: pendingArtifact, sigPath: argv[++i] });
      pendingArtifact = null;
    }
  }
  if (pairs.length === 0) {
    process.stderr.write(
      'usage: verify-updater-signature.mjs [--pubkey <b64>] (--artifact <f> --sig <f.sig>)+\n',
    );
    process.exit(2);
  }
  pubkeyB64 = pubkeyB64 || bakedProdPubkey(root);

  let failed = 0;
  for (const { artifactPath, sigPath } of pairs) {
    if (!artifactPath || !sigPath) {
      process.stderr.write('each --sig must follow an --artifact\n');
      process.exit(2);
    }
    const r = verifyArtifactFile({ pubkeyB64, artifactPath, sigPath });
    if (r.ok) process.stdout.write(`OK   ${artifactPath}\n`);
    else {
      process.stdout.write(`FAIL ${artifactPath}: ${r.reason}\n`);
      failed++;
    }
  }
  if (failed > 0) {
    process.stderr.write(`\n${failed} signature(s) failed verification — refusing to publish.\n`);
    process.exit(1);
  }
  process.stdout.write(`\nAll ${pairs.length} signature(s) verify against the baked pubkey.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
