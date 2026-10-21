import { connectHostedSync, hasHostedSavedVault } from '$lib/platform/tauri/hostedSync';
import { hostedSyncEnabled } from './hostedSyncEnabled';
import { clearLastSyncedAt } from './syncStateCleanup';
import { sessionState } from './syncSessionState';

/**
 * Hands this vault's hosted secrets to the engine, so cycles can run. Called
 * when the hosted wizard reaches its set-up, unlocked state, whichever door
 * got it there, and again at launch for a vault that was already set up.
 * Idempotent: Rust rebuilds the session from the same two secrets, with no
 * password.
 *
 * A hosted session that started means this machine no longer has a self-hosted
 * sync password — exactly one sync credential exists at a time, and Rust
 * dropped the keyring entry inside the connect above (`VaultSecrets::
 * delete_sync_password`). Dropping `cachedPassword` is not a second copy of
 * that rule and never re-decides it: it refreshes this module's in-memory
 * mirror of the keyring, which `hasStoredSyncPassword()` and
 * `isE2eeConfigured()` answer from synchronously and would otherwise keep
 * reporting a password that is gone. → docs/spec/sync.md
 */
export async function connectHostedE2ee(): Promise<void> {
  await connectHostedSync();
  sessionState.hostedConnected = true;
  sessionState.hostedSavedVault = true;
  sessionState.cachedPassword = null;
  sessionState.cachedAuthToken = null;
  // Rust stops whatever live loop the previous session had before it swaps the
  // session out (`SyncSession::connect_hosted` calls `stop_live` first), so
  // this process's "the stream is already running" flag is now stale. Left
  // set, a switch from a live self-hosted session makes `ensureLiveSync` a
  // no-op and the hosted session gets no stream at all. Desktop needs no
  // teardown of its own — unlike the native shells it holds ONE engine session
  // and the engine replaces it — but it does have to stop believing this.
  sessionState.liveStarted = false;
}

/**
 * Resumes a hosted vault during the boot credential load, so
 * `isE2eeConfigured()` is already true when `markSyncCredentialsSettled()`
 * releases auto-sync's first cycle — a restart syncs at launch instead of
 * waiting for the account card to be opened. → docs/spec/sync.md
 *
 * `hasHostedSavedVault` is a local secret-store read and makes no request, so
 * a password-mode or brand-new vault costs nothing here. Only the connect
 * itself can be slow, and only when there is a hosted session to rebuild.
 *
 * Never throws: offline at launch is the ordinary case, and the vault is
 * recorded either way, so the next auto-sync trigger retries the connect
 * through `ensureConnected` rather than skipping the vault.
 */
export async function resumeHostedSessionOnBoot(): Promise<void> {
  if (!hostedSyncEnabled()) return;
  try {
    if (!(await hasHostedSavedVault())) return;
    sessionState.hostedSavedVault = true;
    await connectHostedE2ee();
  } catch (e) {
    console.warn('[e2ee] hosted session not resumed at launch; will retry on the next sync:', e);
  }
}

/** Signing out ends the hosted session as far as this module is concerned;
    Rust has already forgotten both secrets and demoted the sync state. */
export async function forgetHostedE2ee(): Promise<void> {
  sessionState.hostedConnected = false;
  sessionState.hostedSavedVault = false;
  sessionState.liveStarted = false;
  await clearLastSyncedAt();
}
