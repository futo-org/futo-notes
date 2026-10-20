/**
 * Scenarios: the hosted-sync flow against a stand-in server.
 */

import { sleep } from '../lib/mcp-client.mjs';
import { fillQuota, lapseSubscription, setQuota } from '../lib/standin-browser.mjs';
import { restartDesktopTauriInstance } from '../lib/tauri-instance.mjs';
import {
  HOSTED_EMAIL,
  assertNeverArrives,
  assertRecoveryKeyShape,
  hostedConnect,
  syncRefusal,
  waitForSyncedNote,
} from './hosted-sync-helpers.mjs';
import { REPO_ROOT } from './run-state.mjs';
import { assert, assertEqual } from './waits-and-assertions.mjs';

/**
 * Stories 6, 7, 8, 10, 22 and 24: a brand-new account subscribes, chooses a
 * vault password, is shown a recovery key once, and reaches a first sync.
 */
export async function hostedNoVaultShapeReachesAFirstSync(a, _b, server) {
  const account = await hostedConnect(a, server);

  assertEqual(account.step, 'ready', 'the wizard should finish on the account card');
  assertEqual(account.email, HOSTED_EMAIL, 'the account card names who is signed in');
  assert(account.billing?.entitled === true, 'the account may write after checkout');
  assertEqual(account.banner, 'none', 'a paid-up account with room shows no banner');

  const progress = await a.hostedProgress();
  assertEqual(
    progress.opened.length,
    2,
    `a fresh account opens the browser twice — sign-in then checkout (opened ${progress.opened.length})`,
  );
  assertRecoveryKeyShape(progress.recoveryKey, a.name);

  // The wizard exists to reach a sync, so the proof is a note on the server.
  const noteId = 'hosted first sync';
  const body = '# Hosted\nThe wizard finished and this went up.';
  await a.writeNote(noteId, body);
  const summary = await a.syncNow();
  assertEqual(
    summary.summary.failures.length,
    0,
    `the first hosted sync reported failures: ${JSON.stringify(summary.summary.failures)}`,
  );
  assert(
    summary.status.appState.lastSyncedAt !== null,
    'the first hosted sync never completed a cycle',
  );
  assertEqual(summary.status.appState.lastSyncError, '', 'the first hosted sync reported an error');
}

/**
 * Stories 12 and 20: a second device signs in, finds a vault already there, and
 * unlocks it by typing the vault password — no subscribe step, no recovery key.
 */
export async function hostedVaultExistsUnlocksByVaultPassword(a, b, server) {
  await hostedConnect(a, server);
  const noteId = 'hosted by password';
  const body = '# By password\nTyped on the first device.';
  await a.writeNote(noteId, body);
  await a.syncNow();

  const account = await hostedConnect(b, server);
  assertEqual(account.step, 'ready', 'the second device should reach the account card');

  const progress = await b.hostedProgress();
  assertEqual(
    progress.opened.length,
    1,
    `a vault that exists skips subscribe — only sign-in opens a browser (opened ${JSON.stringify(progress.opened)})`,
  );
  assertEqual(
    progress.recoveryKey,
    null,
    'the recovery key is shown on a fresh vault only, never on an unlock',
  );

  await waitForSyncedNote(b, noteId, body);
}

/**
 * Stories 17 and 18: a device with nothing but the recovery key gets in — typed
 * the way a person retypes one, in lower case with the dashes left out.
 */
export async function hostedVaultExistsUnlocksByRecoveryKey(a, b, server) {
  await hostedConnect(a, server);
  const recoveryKey = (await a.hostedProgress()).recoveryKey;
  assertRecoveryKeyShape(recoveryKey, a.name);

  const noteId = 'hosted by recovery key';
  const body = '# By recovery key\nTyped on the first device.';
  await a.writeNote(noteId, body);
  await a.syncNow();

  const account = await hostedConnect(b, server, {
    door: 'recoveryKey',
    // No vault password at all: the door must not quietly fall back to one.
    vaultPassword: undefined,
    recoveryKey: recoveryKey.toLowerCase().replaceAll('-', ''),
  });
  assertEqual(account.step, 'ready', 'the recovery key should unlock the vault');

  await waitForSyncedNote(b, noteId, body);
}

/**
 * Stories 13, 14 and 16: the device being set up shows a code, the unlocked one
 * reads it and confirms, and the key travels over the relay. The scanned string
 * is passed between the two instances in place of a camera.
 */
export async function hostedPairingBetweenTwoDesktopInstances(a, b, server) {
  await hostedConnect(a, server);
  const noteId = 'hosted by pairing';
  const body = '# By pairing\nTyped on the unlocked device.';
  await a.writeNote(noteId, body);
  await a.syncNow();

  // B signs in and stops at the unlock screen — signed in, still locked, which
  // is where a person stands while holding the code up to their phone.
  const locked = await hostedConnect(b, server, { stopAtStep: 'unlock' });
  assertEqual(locked.step, 'unlock', 'the second device should be signed in and locked');

  await b.startShowPairingCode();
  const payload = await b.waitForPairingPayload();
  assert(payload.includes('futo_notes_pairing'), `not a pairing payload: ${payload.slice(0, 120)}`);

  // The confirmation sheet's content, on the unlocked device. Nothing has been
  // sent at this point; acceptPairing reads the code and only then confirms.
  const shown = await a.acceptPairing(payload);
  assert(
    typeof shown.deviceName === 'string' && shown.deviceName.length > 0,
    'the confirmation sheet must name the device it is about to hand a key to',
  );
  assertEqual(shown.platform, 'desktop', 'a laptop pairing to a laptop reports desktop');

  const account = await b.awaitShowPairingCode();
  assertEqual(account.step, 'ready', 'the paired device should reach the account card');

  await waitForSyncedNote(b, noteId, body);
}

/**
 * Stories 27 and 28: a lapsed subscription pauses writes and says so, while the
 * other device's notes keep arriving.
 */
export async function hostedLapsedSubscriptionPausesWritesAndKeepsReads(a, b, server) {
  await hostedConnect(a, server);
  await hostedConnect(b, server);

  const arriving = 'hosted lapsed arrival';
  const arrivingBody = '# Pushed before the lapse\nThis still has to reach the other device.';
  await a.writeNote(arriving, arrivingBody);
  await a.syncNow();

  const token = await a.hostedSessionToken();
  assert(Boolean(token), 'the signed-in device should hold a session token');
  await lapseSubscription(server.url, token);

  // The read. A lapsed card must never strand a device.
  await waitForSyncedNote(b, arriving, arrivingBody);

  // The write. Refused with the subscription's own status, and it stays put.
  const blocked = 'hosted lapsed write';
  await b.writeNote(blocked, '# Written after the lapse\n');
  const refusal = await syncRefusal(b);
  assert(refusal.refused, `a lapsed account should not be able to push: ${refusal.detail}`);
  assert(
    refusal.statuses.includes(402),
    `the refusal should be 402 subscription_required: ${refusal.detail}`,
  );

  // Before anybody opens the account screen. The engine named the refusal, so
  // the banner is already earned — nothing here has read billing since the
  // lapse (ADR 0003 decision 8; docs/spec/sync.md).
  assertEqual(
    refusal.writeRefusal,
    'subscriptionRequired',
    'the cycle itself should report the refusal, not just a status code',
  );
  const onTheSpot = await b.hostedRefusalBanner();
  assertEqual(
    onTheSpot.banner,
    'syncPaused',
    'the Sync paused banner must be up the moment the refused cycle ends',
  );

  await assertNeverArrives(a, blocked);

  const account = await b.hostedAccount();
  assertEqual(account.banner, 'syncPaused', 'a lapsed subscription raises the Sync paused banner');
  assert(account.billing?.entitled === false, 'billing should report the account cannot write');
}

/** Story 29: a full vault says so, and stops saying so when there is room. */
export async function hostedFullVaultRaisesTheVaultFullBanner(a, _b, server) {
  await hostedConnect(a, server);

  // Something must already be stored: filling the quota drops the ceiling to
  // what the account holds, and a ceiling of zero reads as "unknown", not full.
  await a.writeNote('hosted quota', '# Stored\nSo the vault has a size to be full of.');
  await a.syncNow();

  const token = await a.hostedSessionToken();
  await fillQuota(server.url, token);

  const full = await a.hostedAccount();
  assertEqual(full.banner, 'vaultFull', 'a full vault raises the Vault is full banner');
  assert(
    full.billing.bytesUsed >= full.billing.storageQuotaBytes && full.billing.storageQuotaBytes > 0,
    `the quota was not actually filled: ${JSON.stringify(full.billing)}`,
  );

  const blocked = 'hosted quota second';
  await a.writeNote(blocked, '# One byte too many\n');
  const refusal = await syncRefusal(a);
  assert(refusal.refused, `a full vault should refuse the next write: ${refusal.detail}`);
  assert(
    refusal.statuses.includes(507),
    `the refusal should be 507 quota_exceeded: ${refusal.detail}`,
  );

  // Before anybody opens the account screen, and with no billing call in
  // between: the refused cycle earned the banner on its own.
  assertEqual(
    refusal.writeRefusal,
    'quotaExceeded',
    'the cycle itself should report the refusal, not just a status code',
  );
  const onTheSpot = await a.hostedRefusalBanner();
  assertEqual(
    onTheSpot.banner,
    'vaultFull',
    'the Vault is full banner must be up the moment the refused cycle ends',
  );

  // The banner is a live reading of the account, not a latch: buy room and it
  // goes away without anything being reset.
  await setQuota(server.url, token, 64 * 1024 * 1024);
  const cleared = await syncRefusal(a);
  assertEqual(
    cleared.writeRefusal,
    null,
    'a cycle that was not refused must clear the refusal it carries',
  );
  assertEqual(
    (await a.hostedRefusalBanner()).banner,
    'none',
    'room on the plan should clear the banner without anything being reset',
  );
  const roomy = await a.hostedAccount();
  assertEqual(roomy.banner, 'none', 'room on the plan should clear the banner');
}

/** Story 30: sign out revokes the session and forgets the key. The notes stay. */
export async function hostedSignOutKeepsTheNotesOnDisk(a, _b, server) {
  await hostedConnect(a, server);

  const noteId = 'hosted sign out';
  const body = '# Mine\nThese notes are on this disk and stay there.';
  await a.writeNote(noteId, body);
  await a.syncNow();

  await a.hostedSignOut();

  const after = await a.hostedAccount();
  assertEqual(after.step, 'signIn', 'signing out puts the wizard back at its first screen');
  assertEqual(after.email, '', 'nobody is signed in after a sign out');

  assertEqual(await a.readNote(noteId), body, 'signing out must not touch the notes');
  const files = await a.listNotes();
  assert(
    files.some((file) => file.name === `${noteId}.md`),
    `the note file should still be on disk: ${JSON.stringify(files.map((file) => file.name))}`,
  );

  // And the device really is signed out: a sync has no session to run with.
  const refusal = await syncRefusal(a);
  assert(refusal.refused, `a signed-out device should not sync: ${refusal.detail}`);
}

/**
 * Waits for a note to arrive on a client that NOTHING is driving.
 *
 * The other waiters call `syncNow()` each pass, which is the opposite of what
 * this proves: the point is that the restarted app connected its hosted
 * session and started cycling on its own. So the only calls here are reads —
 * the sync status hook and the note itself. `lastSyncedAt` must also move past
 * the value the previous process left on disk, or a note that was already
 * there before the restart would pass this.
 */
async function waitForLaunchSync(client, id, expected, since, timeoutMs = 90_000) {
  const start = Date.now();
  let lastSyncedAt = since;
  let body = null;
  while (Date.now() - start < timeoutMs) {
    const status = await client.syncStatus().catch(() => null);
    lastSyncedAt = status?.appState?.lastSyncedAt ?? lastSyncedAt;
    body = await client.readNote(id).catch(() => null);
    if (body === expected && lastSyncedAt !== since) return;
    await sleep(1_000);
  }
  throw new Error(
    `${client.name}: the relaunched app never synced on its own ` +
      `(lastSyncedAt ${JSON.stringify(since)} → ${JSON.stringify(lastSyncedAt)}, ` +
      `${id} last read as ${JSON.stringify(body)}, wanted ${JSON.stringify(expected)})`,
  );
}

/**
 * C2 / story 27: a hosted device that is quit and reopened syncs at launch.
 *
 * Deliberately touches NO hosted hook after the restart. `hostedAccount()` and
 * `connectHosted()` both connect the session themselves, so either one would
 * re-create the Settings visit this exists to remove and the scenario would
 * pass on a build that never resumes at boot. B is left completely alone: the
 * proof is a cycle it ran and a note it fetched by itself.
 */
export async function hostedRestartSyncsAtLaunchWithoutOpeningSettings(a, b, server) {
  await hostedConnect(a, server);
  await hostedConnect(b, server);

  // A baseline both devices agree on, so the restart starts from a real
  // synced state rather than an empty one.
  const before = 'hosted before the restart';
  const beforeBody = '# Before\nBoth devices have this.';
  await a.writeNote(before, beforeBody);
  await a.syncNow();
  await waitForSyncedNote(b, before, beforeBody);
  const lastSyncedAt = (await b.syncStatus()).appState.lastSyncedAt;
  assert(lastSyncedAt !== null, 'B should have completed a cycle before it is restarted');

  // Quit and reopen B. The new process has no hosted session in memory; the
  // vault key and the session token are in the OS secret store, and only the
  // boot credential load can hand them back to the engine.
  await restartDesktopTauriInstance(b, REPO_ROOT, { env: { FUTO_HOSTED_SERVER: server.url } });

  const noteId = 'hosted after the restart';
  const body = '# After\nWritten on the other device while this one was closed.';
  await a.writeNote(noteId, body);
  await a.syncNow();

  await waitForLaunchSync(b, noteId, body, lastSyncedAt);

  // Nothing is asserted past here. `forgetHosted()` — how the suite drops a
  // device's hosted secrets between scenarios — is a no-op until something has
  // told the test hook which server this device is on, and the relaunched
  // process has never been told. Say it now, so a restart cannot leak a
  // signed-in vault into whatever runs next.
  await hostedConnect(b, server);
}
