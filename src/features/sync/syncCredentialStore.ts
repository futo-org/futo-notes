import { invoke } from '$lib/platform/tauri/invoke';
import {
  clearLegacyE2eePassword,
  clearLegacyE2eeAuthToken,
  getAppState,
  getLegacyE2eePassword,
  getLegacyE2eeAuthToken,
  loadAppState,
  saveAppState,
} from '$shared/state/appState';
import { isTauri } from '$lib/platform';
import { showGlobalToast } from '$shared/notifications/toastBus.svelte';
import { resumeHostedSessionOnBoot } from './hostedSession';
import { sessionState } from './syncSessionState';

// The one real precondition for the first auto-sync cycle. `isE2eeConfigured()`
// reads persisted connection metadata AND the in-memory password, and BOTH are
// loaded by `initSyncPassword` below — until it finishes, a fully configured
// vault still reports "not configured". Auto-sync waits on this rather than on
// a wall-clock guess, so the first cycle runs the moment it can instead of at a
// time chosen to be safely after it. → autoSync.startAutoSync
let markSyncCredentialsSettled: () => void = () => {};
const syncCredentialsSettled = new Promise<void>((resolve) => {
  markSyncCredentialsSettled = resolve;
});

/**
 * Resolves once the boot credential load has finished — successfully or not.
 * A keyring failure settles it too: "we know there is no password" is just as
 * actionable as "here it is", and either way waiting longer cannot help.
 */
export function whenSyncCredentialsSettled(): Promise<void> {
  return syncCredentialsSettled;
}

// Every credential-store mutation — the boot migration, connect, disconnect,
// forget, and the pending-deletion retry — runs through this single serial
// queue so their keyring writes, `cachedPassword` assignments, and app-state
// scrubs can never interleave (K2). `credentialGeneration` bumps whenever a
// user-driven op establishes new authoritative state; a boot `initSyncPassword`
// that captured the pre-lock world and then lost the race for the lock detects
// the change and abandons its now-stale commit, so it can't resurrect a
// disconnected credential or clobber a fresh connect.
let credentialLock: Promise<unknown> = Promise.resolve();

export function withCredentialLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = credentialLock.then(fn, fn);
  // Keep the chain alive regardless of this op's outcome.
  credentialLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Delete both self-hosted keyring entries; on failure mark a retry (K3). */
export async function deleteStoredCredentials(): Promise<void> {
  if (!isTauri) return;
  try {
    await invoke('e2ee_password_delete');
    await invoke('e2ee_session_token_delete');
    if (getAppState().pendingKeyringDeletion) {
      // Clear the marker (undefined → dropped by JSON.stringify, not persisted).
      await saveAppState({ ...getAppState(), pendingKeyringDeletion: undefined });
    }
  } catch (e) {
    // Orphaned OS credential: don't fail the flow, but don't let it vanish
    // silently either — tell the user and persist a marker so the next launch
    // retries the delete (see initSyncPassword).
    showGlobalToast({ path: 'sync.errors.forgetPasswordFailed' });
    console.warn('[e2ee] could not delete vault password from keyring:', e);
    await saveAppState({ ...getAppState(), pendingKeyringDeletion: true });
  }
}

/**
 * One-time boot hook: retry any outstanding keyring deletion (K3), migrate a
 * legacy plaintext `e2eePassword` from `.app-state.json` into the OS keyring
 * (scrubbing the JSON only after the keyring write is confirmed, K1), then
 * load the stored password into memory.
 *
 * Never throws — a keyring failure (e.g. headless Linux with no Secret
 * Service) leaves any legacy value in place for a later retry and runs the
 * session password-less; the user can re-enter it from Settings, and it is
 * never written back to disk in plaintext. Safe to call un-awaited at startup.
 */
export async function initSyncPassword(): Promise<void> {
  try {
    await loadCredentialsOnBoot();
  } finally {
    // Whatever happened, auto-sync's first cycle may stop waiting: this is the
    // point where `isE2eeConfigured()` starts telling the truth.
    markSyncCredentialsSettled();
  }
}

async function loadCredentialsOnBoot(): Promise<void> {
  await loadAppState();
  if (!isTauri) return;

  // Finish a delete that a prior disconnect/forget couldn't complete.
  if (getAppState().pendingKeyringDeletion) {
    await withCredentialLock(async () => {
      if (getAppState().pendingKeyringDeletion) {
        // A crash after the delete marker but before the state scrub must not
        // re-import a legacy plaintext credential on the same boot.
        clearLegacyE2eeAuthToken();
        clearLegacyE2eePassword();
        await deleteStoredCredentials();
        await saveAppState(getAppState());
      }
    });
    // If the delete still hasn't succeeded, do NOT load the credential the
    // user asked us to forget — leaving it unloaded keeps sync from resuming
    // and the delete is retried again next boot (R2).
    if (getAppState().pendingKeyringDeletion) return;
  }

  const gen = sessionState.credentialGeneration;
  await withCredentialLock(async () => {
    // A connect/disconnect/forget won the lock ahead of us: its credential is
    // authoritative, so drop our stale migration/load entirely. If a legacy
    // plaintext holdover is still pinning the old password to disk, scrub it —
    // the old password is moot now (replaced or cleared), and leaving the
    // holdover set would keep re-writing plaintext forever, defeating F6.
    if (gen !== sessionState.credentialGeneration) {
      if (getLegacyE2eePassword() !== undefined) {
        clearLegacyE2eePassword();
        await saveAppState(getAppState());
      }
      if (getLegacyE2eeAuthToken() !== undefined) {
        clearLegacyE2eeAuthToken();
        await saveAppState(getAppState());
      }
      return;
    }
    const legacyToken = getLegacyE2eeAuthToken();
    try {
      sessionState.cachedAuthToken =
        (await invoke<string | null>('e2ee_session_token_get')) ?? null;
      if (!sessionState.cachedAuthToken && legacyToken != null) {
        await invoke('e2ee_session_token_set', { token: legacyToken });
        sessionState.cachedAuthToken = legacyToken;
      }
    } catch (e) {
      console.warn('[e2ee] session token keyring unavailable; will reauthenticate:', e);
      // The securely saved password can obtain a fresh token. An unavailable
      // keyring must not keep the legacy bearer in the vault backup.
      sessionState.cachedAuthToken = legacyToken ?? null;
    }
    if (legacyToken != null) {
      clearLegacyE2eeAuthToken();
      await saveAppState(getAppState());
    }
    const legacy = getLegacyE2eePassword();
    try {
      if (legacy != null) {
        // Keyring write MUST succeed before we stop re-injecting + scrub.
        await invoke('e2ee_password_set', { password: legacy });
        sessionState.cachedPassword = legacy;
        clearLegacyE2eePassword();
        // getAppState() is sanitized (no e2eePassword) and the holdover is now
        // cleared, so this save rewrites the file without the plaintext field.
        await saveAppState(getAppState());
        // Continue loading the token and hosted state after password migration.
      }
      sessionState.cachedPassword = (await invoke<string | null>('e2ee_password_get')) ?? null;
    } catch (e) {
      console.warn('[e2ee] keyring unavailable; vault password not loaded:', e);
    }
    // A hosted vault keeps no password here — both its secrets live in the OS
    // secret store where only Rust can read them — so the check above cannot
    // see one. Ask Rust, in the same lock, before the caller settles the
    // credential promise.
    await resumeHostedSessionOnBoot();
  });
}

export function hasStoredSyncPassword(): boolean {
  return sessionState.cachedPassword != null;
}

export async function forgetStoredSyncPassword(): Promise<void> {
  await withCredentialLock(async () => {
    sessionState.credentialGeneration++;
    sessionState.cachedPassword = null;
    sessionState.cachedAuthToken = null;
    clearLegacyE2eeAuthToken();
    await deleteStoredCredentials();
  });
}
