/**
 * Shared setup and polling for the hosted-sync (Log in with FUTO) scenarios.
 */

import { sleep } from '../lib/mcp-client.mjs';
import { assert } from './waits-and-assertions.mjs';

// ── Hosted sync (Log in with FUTO) ──────────────────────────────
//
// These drive the REAL desktop app through the whole hosted flow against a
// server in stand-in test mode: sign in through the Login Hand-off, pay through
// the stand-in payment provider, create or unlock the vault, and reach a first
// sync. The parent spec's user stories are the acceptance test; each scenario
// below names the ones it covers.
//
// Two things stand in for hardware that a test process does not have, and
// neither hides a step:
//   - the BROWSER is this process (tests/lib/standin-browser.mjs). The app
//     publishes the URL it would have opened and keeps polling the server; the
//     driver fetches it with a cookie jar, and the app's own wait completes.
//   - the CAMERA is a string. `showPairingCode` hands the payload up as text and
//     the other instance is given that text, which is exactly what a scanner
//     would have produced — decision 5's relay round trip is otherwise real.
//
// They need two things that CI does not have: a server that carries stand-in
// mode (see standinModeAvailable() and the skip in main()), and an OS secret
// store, because the desktop keeps the vault key and the session token in the
// keyring and nowhere else.

const HOSTED_VAULT_PASSWORD = 'a long enough vault password';
/** The one identity a stand-in login produces (server ADR 0009). */
export const HOSTED_EMAIL = 'person@standin.test';

/** Runs the wizard on [client] against this scenario's stand-in server. */
export function hostedConnect(client, server, options = {}) {
  return client.connectHosted({
    serverUrl: server.url,
    vaultPassword: HOSTED_VAULT_PASSWORD,
    ...options,
  });
}

/**
 * Seven groups of four: 27 Crockford base32 data characters and one check
 * character (ADR 0003 decision 6; the alphabets are in `recovery_key.rs`).
 *
 * Crockford's data alphabet leaves out I, L, O and U so a handwritten key
 * cannot be misread; the check character has its own longer alphabet, which
 * puts U and four punctuation marks back — so the last character is matched
 * separately, not by the data pattern. A key that came back unformatted, or
 * empty, is one a person cannot write down or type back.
 *
 * Asserted as a shape rather than a value: the key is 128 bits of entropy and
 * differs every run.
 */
const CROCKFORD_DATA = '[0-9A-HJKMNP-TV-Z]';
const CROCKFORD_CHECK = '[0-9A-HJKMNP-TV-Z*~$=U]';
const RECOVERY_KEY_SHAPE = new RegExp(
  `^(${CROCKFORD_DATA}{4}-){6}${CROCKFORD_DATA}{3}${CROCKFORD_CHECK}$`,
);

export function assertRecoveryKeyShape(key, who) {
  assert(typeof key === 'string', `${who}: no recovery key was produced`);
  assert(
    RECOVERY_KEY_SHAPE.test(key),
    `${who}: recovery key is not 27 Crockford characters plus a check character, ` +
      `in seven groups of four: ${JSON.stringify(key)}`,
  );
}

/** Polls until a note's content arrives on [client], syncing each time. */
export async function waitForSyncedNote(client, id, expected, timeoutMs = 60_000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await client.readNote(id).catch(() => null);
    if (last === expected) return;
    await client.syncNow().catch(() => {});
    await sleep(500);
  }
  throw new Error(
    `${client.name}: ${id} never arrived (last: ${JSON.stringify(last)}, wanted ${JSON.stringify(expected)})`,
  );
}

/**
 * How a manual sync was refused, by HTTP status rather than by sentence.
 *
 * A 402 and a 507 come back inside the cycle's `failures` — the cycle itself
 * reports success — so "did it throw" is not the question. The status code is a
 * protocol fact and safe to assert on; the message is UI copy and is not (M15).
 */
export async function syncRefusal(client) {
  try {
    const result = await client.syncNow();
    const failures = result?.summary?.failures ?? [];
    return {
      refused: failures.length > 0,
      statuses: failures.map((failure) => failure.statusCode),
      // The engine's own reading of those statuses, which is what every shell
      // renders a banner from (futo_notes_sync::WriteRefusal).
      writeRefusal: result?.summary?.writeRefusal ?? null,
      detail: JSON.stringify(failures),
    };
  } catch (error) {
    return { refused: true, statuses: [], writeRefusal: null, detail: error.message };
  }
}

/**
 * Fails if [id] ever reaches [client]. Proof that a refused write stayed put.
 *
 * Asks whether the file exists rather than reading it: the local store answers
 * a missing note with an empty string, so a `readNote(...) === null` check here
 * never fires and would have passed whatever the server did.
 */
export async function assertNeverArrives(client, id, forMs = 4_000) {
  const start = Date.now();
  while (Date.now() - start < forMs) {
    await client.syncNow().catch(() => {});
    const arrived = await client.noteExists(id).catch(() => false);
    assert(!arrived, `${client.name}: ${id} arrived, but the write should have been refused`);
    await sleep(500);
  }
}
