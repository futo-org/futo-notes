// Fills in the *inputs* of tests/conformance/license.json that a human cannot
// author by hand: the test-only RSA key pairs and the base64url signatures.
//
// It NEVER reads or writes an `expected` value. That line matters: the fixture
// generator this repo deleted in !201 computed goldens by executing the
// implementation, so the goldens encoded whatever the code did rather than what
// a human had approved (tests/conformance/README.md, "What this replaces").
// Here the reviewed answer stays hand-written and only the ciphertext-shaped
// inputs are derived — signatures are not a thing a reviewer can type.
//
//   node scripts/gen-license-fixture.mjs          # fill every missing/stale signature
//   node scripts/gen-license-fixture.mjs --check  # fail if any is stale (no writes)
//
// It has one other job, which shares the same signer and nothing else:
//
//   FUTO_NOTES_STAGING_KEY=/path/to/staging-priv.pem \
//     node scripts/gen-license-fixture.mjs --staging
//
// mints the STAGING-signed activations the native and FFI fixtures carry — the
// ones that must verify against `STAGING_PUBLIC_KEY_BASE64` on a real `.dev`
// build, which the fixture pair above cannot do. Both accepted formats are
// minted, so every consumer can cover v1 and v2. It PRINTS them; a human pastes
// them into the three consumers listed in its output. Nothing is written,
// nothing reads the private key on a normal test run, and the private key never
// enters the repo. The consumers' own tests are the staleness guard: an
// activation that stops verifying fails `test-ios-native`,
// `test-android-native` and `cargo test -p futo-notes-ffi` by itself.
//
// A case opts in by carrying a `sign` object:
//   { "with": "org" | "otherOrg",         which fixture key pair signs it
//     "format": "v2" | "v1",              v1 = the bare signature over `key`
//     "payload": { … },                   the JSON that gets signed (v2)
//     "payloadRaw": "…",                  or: sign these exact bytes, so a
//                                         validly-signed non-JSON payload can
//                                         be pinned too
//     "payloadOverride": { … } }          optional: ship THIS payload segment
//                                         with the signature over `payload`,
//                                         i.e. a tampered activation
// and a sibling `activation` string, which is what this script rewrites.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(ROOT, 'tests/conformance/license.json');
const CHECK = process.argv.includes('--check');

const base64url = (buffer) => buffer.toString('base64url');

/** The canonical JSON the FUTOpay server signs: UTF-8, no insignificant
 *  whitespace, fields in the order the spec lists them. The client verifies the
 *  bytes it received and never re-serializes, so this shape is a fixture/server
 *  contract, not a client rule. */
function canonicalPayload(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8');
}

function signV2(privateKey, sign) {
  const signed =
    sign.payloadRaw === undefined
      ? canonicalPayload(sign.payload)
      : Buffer.from(sign.payloadRaw, 'utf8');
  const signature = crypto.sign('sha256', signed, {
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_PADDING,
  });
  const shipped = sign.payloadOverride ? canonicalPayload(sign.payloadOverride) : signed;
  return `v2.${base64url(shipped)}.${base64url(signature)}`;
}

/** v1: a bare base64url signature over the license-key string — no envelope,
 *  no product, no dates. This is what `pay2.futo.org` issues today, and FUTO
 *  Notes accepts it alongside v2 (decision 2026-09-10, issue #161). */
function signV1(privateKey, sign) {
  const signature = crypto.sign('sha256', Buffer.from(sign.key, 'utf8'), {
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_PADDING,
  });
  return base64url(signature);
}

function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    publicKeySpkiBase64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKeyPkcs8Base64: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
}

function* signedCases(node) {
  if (Array.isArray(node)) {
    for (const child of node) yield* signedCases(child);
  } else if (node && typeof node === 'object') {
    if (node.sign) yield node;
    for (const child of Object.values(node)) yield* signedCases(child);
  }
}

/** The staging-signed activations every consumer outside this fixture carries,
 *  over one license key: a term-limited v2 license, its perpetual
 *  (`expires_at: null`) v2 sibling, and the v1 bare signature the deployed
 *  server actually issues. The key does not exist server-side and does not need
 *  to — these are verified offline, against the baked-in staging public key. */
const STAGING_FIXTURE_KEY = 'FN-AB12-CD34-EF56-GH78-JK12-MN34-PQ56-RS78';
const STAGING_PAYLOADS = {
  ACTIVATION: {
    key: STAGING_FIXTURE_KEY,
    product: 'futo-notes',
    issued_at: '2026-01-15T10:30:00Z',
    expires_at: '2029-01-15T10:30:00Z',
  },
  PERPETUAL_ACTIVATION: {
    key: STAGING_FIXTURE_KEY,
    product: 'futo-notes',
    issued_at: '2026-01-15T10:30:00Z',
    expires_at: null,
  },
};

/** The v1 activation is signed over the license KEY, not over a payload, so it
 *  is minted from the same key string rather than from a STAGING_PAYLOADS
 *  entry. */
const STAGING_V1 = { format: 'v1', key: STAGING_FIXTURE_KEY };

const STAGING_CONSUMERS = [
  'crates/futo-notes-ffi/src/license/contract.rs (all three constants)',
  'apps/ios/Tests/License/LicenseFixture.swift (ACTIVATION + V1_ACTIVATION)',
  'apps/android/app/src/androidTest/java/com/futo/notes/license/LicenseFixture.kt (ACTIVATION + V1_ACTIVATION)',
];

/** The staging public key exactly as the app bakes it in. Read out of the Rust
 *  constant rather than re-derived, so minting against the wrong private key —
 *  a rotated one, production, a stray test key — is refused here instead of
 *  discovered later as an unexplained signature mismatch in three suites. */
function bakedStagingPublicKey() {
  const source = fs.readFileSync(
    path.join(ROOT, 'crates/futo-notes-license/src/config.rs'),
    'utf8',
  );
  const match = source.match(/pub const STAGING_PUBLIC_KEY_BASE64: &str = "([^"]+)"/);
  if (!match) throw new Error('config.rs no longer declares STAGING_PUBLIC_KEY_BASE64');
  return crypto.createPublicKey({
    key: Buffer.from(match[1], 'base64'),
    format: 'der',
    type: 'spki',
  });
}

function mintStagingActivations() {
  const keyPath = process.env.FUTO_NOTES_STAGING_KEY;
  if (!keyPath) {
    console.error(
      '--staging needs the staging private key:\n' +
        '  FUTO_NOTES_STAGING_KEY=/path/to/staging-priv.pem node scripts/gen-license-fixture.mjs --staging\n' +
        'It lives in 1Password and in the FUTOpay staging deployment. Never copy it into this repo.',
    );
    process.exit(1);
  }
  const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath));
  const derived = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const baked = bakedStagingPublicKey().export({ type: 'spki', format: 'der' });
  if (!derived.equals(baked)) {
    console.error(
      `${keyPath} is not the staging org key baked into config.rs — refusing to mint.\n` +
        `  its public half:  ${crypto.createHash('sha256').update(derived).digest('hex')}\n` +
        `  config.rs expects ${crypto.createHash('sha256').update(baked).digest('hex')}`,
    );
    process.exit(1);
  }

  console.log('Staging-signed activations (paste into each consumer, then run its suite):');
  for (const consumer of STAGING_CONSUMERS) console.log(`  - ${consumer}`);
  console.log('');
  console.log(`  KEY = ${STAGING_FIXTURE_KEY}`);
  for (const [name, payload] of Object.entries(STAGING_PAYLOADS)) {
    console.log('');
    console.log(`  ${name} =`);
    console.log(`    ${signV2(privateKey, { format: 'v2', payload })}`);
  }
  console.log('');
  console.log('  V1_ACTIVATION =');
  console.log(`    ${signV1(privateKey, STAGING_V1)}`);
}

if (process.argv.includes('--staging')) {
  mintStagingActivations();
  process.exit(0);
}

const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const stale = [];

for (const [name, pair] of Object.entries(fixture.keys)) {
  if (pair.publicKeySpkiBase64 && pair.privateKeyPkcs8Base64) continue;
  if (CHECK) {
    stale.push(`keys.${name} is empty`);
    continue;
  }
  Object.assign(pair, generateKeyPair());
  console.log(`generated key pair: ${name}`);
}

const privateKeys = Object.fromEntries(
  Object.entries(fixture.keys).map(([name, pair]) => [
    name,
    pair.privateKeyPkcs8Base64
      ? crypto.createPrivateKey({
          key: Buffer.from(pair.privateKeyPkcs8Base64, 'base64'),
          format: 'der',
          type: 'pkcs8',
        })
      : null,
  ]),
);

let rewritten = 0;
for (const testCase of signedCases(fixture)) {
  const { sign } = testCase;
  const privateKey = privateKeys[sign.with];
  if (!privateKey) throw new Error(`case "${testCase.name}" signs with unknown key "${sign.with}"`);
  const activation = sign.format === 'v1' ? signV1(privateKey, sign) : signV2(privateKey, sign);
  if (testCase.activation === activation) continue;
  if (CHECK) {
    stale.push(`case "${testCase.name}" has a stale activation`);
    continue;
  }
  testCase.activation = activation;
  rewritten += 1;
}

if (stale.length > 0) {
  console.error(
    `tests/conformance/license.json is stale — run node scripts/gen-license-fixture.mjs:\n` +
      stale.map((line) => `  - ${line}`).join('\n'),
  );
  process.exit(1);
}

if (CHECK) {
  console.log('tests/conformance/license.json signatures are current.');
} else {
  fs.writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`rewrote ${rewritten} activation(s) in tests/conformance/license.json`);
}
