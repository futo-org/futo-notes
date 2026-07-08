import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { verifyUpdaterSignature, parseMinisignPubkey } from './verify-updater-signature.mjs';

/**
 * Proves the updater signature verifier — the guard against the catastrophic,
 * irreversible "baked pubkey doesn't match the signing key" foot-gun (findings
 * #1/#3) — actually verifies. Uses a committed fixture signed by the throwaway
 * localdev key (scripts/__fixtures__/sample.bin{,.sig}). Re-sign the fixture with
 * `TAURI_SIGNING_PRIVATE_KEY=$(cat keys/localdev-updater.key) cargo tauri signer
 * sign -p "" scripts/__fixtures__/sample.bin` if the localdev key is rotated.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readConf = (n) => JSON.parse(readFileSync(resolve(ROOT, 'apps/tauri/src-tauri', n), 'utf8'));

const LOCALDEV_PUB = readConf('tauri.updater-localdev.conf.json').plugins.updater.pubkey;
const PROD_PUB = readConf('tauri.conf.json').plugins.updater.pubkey;
const FILE = readFileSync(resolve(ROOT, 'scripts/__fixtures__/sample.bin'));
const SIG = readFileSync(resolve(ROOT, 'scripts/__fixtures__/sample.bin.sig'), 'utf8');

describe('verifyUpdaterSignature', () => {
  it('accepts a fixture signed by the matching (localdev) key', () => {
    expect(
      verifyUpdaterSignature({ pubkeyB64: LOCALDEV_PUB, fileBytes: FILE, sigB64: SIG }),
    ).toEqual({ ok: true });
  });

  it('REJECTS the prod pubkey — the wrong-baked-key foot-gun that bricks auto-update (#1)', () => {
    // The prod key never signed this fixture; a build/CI that baked the wrong
    // pubkey would land here. Different key id → caught before publish.
    const r = verifyUpdaterSignature({ pubkeyB64: PROD_PUB, fileBytes: FILE, sigB64: SIG });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/key id mismatch/);
  });

  it('REJECTS a tampered / mismatched artifact — stale .sig or swapped bytes (#3)', () => {
    const tampered = Buffer.concat([FILE, Buffer.from('!')]);
    const r = verifyUpdaterSignature({ pubkeyB64: LOCALDEV_PUB, fileBytes: tampered, sigB64: SIG });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/does not verify/);
  });

  it('REJECTS a corrupted pubkey with the SAME key id (typo in the baked key bytes)', () => {
    // Flip one byte of the key while keeping the 8-byte key id intact — the keyId
    // check passes but the Ed25519 verify must fail, so a single-char base64 typo
    // in tauri.conf.json's pubkey can never silently pass.
    const parsed = parseMinisignPubkey(LOCALDEV_PUB);
    const corruptKey = Buffer.from(parsed.key);
    corruptKey[0] ^= 0xff;
    const raw = Buffer.concat([parsed.algo, parsed.keyId, corruptKey]);
    // Rebuild the 2-line minisign pubkey text → base64 (the verifier reads the
    // last non-empty line as the key data).
    const text = `untrusted comment: corrupted test key\n${raw.toString('base64')}\n`;
    const corruptPub = Buffer.from(text, 'utf8').toString('base64');
    const r = verifyUpdaterSignature({ pubkeyB64: corruptPub, fileBytes: FILE, sigB64: SIG });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/does not verify/);
  });

  it('REJECTS a malformed signature blob without throwing', () => {
    const bogus = Buffer.from('untrusted comment: x\nnotbase64!!!\n', 'utf8').toString('base64');
    const r = verifyUpdaterSignature({ pubkeyB64: LOCALDEV_PUB, fileBytes: FILE, sigB64: bogus });
    expect(r.ok).toBe(false);
  });
});
