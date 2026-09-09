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
// A case opts in by carrying a `sign` object:
//   { "with": "org" | "otherOrg",         which fixture key pair signs it
//     "format": "v2" | "v1",              v1 = the Grayjay-era bare signature
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

/** v1 (Grayjay): a bare base64url signature over the license-key string. FUTO
 *  Notes rejects these; the fixture carries one so that rejection is pinned. */
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
