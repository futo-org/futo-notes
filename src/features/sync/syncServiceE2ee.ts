/**
 * Thin shim over the Rust-side E2EE sync orchestrator.
 *
 * All the heavy work (PBKDF2, AES-GCM, blob HTTP, push/pull, 3-way merge,
 * conflict resolution, persistence) lives in `crates/futo-notes-sync`; the
 * desktop IPC adapter lives in `apps/tauri/src-tauri/src/sync/`
 * and `crates/futo-notes-core/src/e2ee.rs`. This file exists so the rest of
 * the app's import path stays stable: `connectE2ee`, `syncE2eeAuto`,
 * `disconnectE2ee`, `setSyncProgressListener`, and the `SyncSummary` /
 * `SyncProgress` types continue to be re-exported from `$lib/syncServiceE2ee`
 * the way callers expect.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  clearLegacyE2eePassword,
  commitLegacySyncStateScrub,
  getAppState,
  getLegacyE2eePassword,
  getLegacySyncState,
  loadAppState,
  saveAppState,
} from '$shared/state/appState';
import { getPlatformFS, isTauri } from '$lib/platform';
import { getSyncErrorMessage } from './syncErrorMessage';
import { showGlobalToast } from '$shared/notifications/toastBus';
import type {
  E2eeConnectInput,
  E2eeConnectOutput,
  E2eeResumeInput,
  E2eeStatusOutput,
  SyncFailure,
  SyncSummary,
} from './syncContract.generated';

// ── Public types ────────────────────────────────────────────────────────

export type { SyncFailure, SyncSummary };

export type SyncProgress = {
  phase: 'reconciling' | 'pushing' | 'pulling';
  current: number;
  total: number;
};

// ── Password store (OS keyring, held in memory for the session) ─────────
//
// The vault password lives in the OS keyring (Secret Service / Keychain /
// Credential Manager) via the `e2ee_password_*` Tauri commands — never in
// plaintext on disk (F6). `cachedPassword` is the in-memory copy for this
// session (the same posture as iOS Keychain / Android Keystore, where the
// secret is read out and kept in memory to re-derive the vault key); it lets
// the synchronous `isE2eeConfigured()` / `hasStoredSyncPassword()` checks —
// hit on every auto-sync trigger — stay synchronous. `null` means "no stored
// password" (fresh install, forgotten, or keyring unavailable).

let cachedPassword: string | null = null;

// Every credential-store mutation — the boot migration, connect, disconnect,
// forget, and the pending-deletion retry — runs through this single serial
// queue so their keyring writes, `cachedPassword` assignments, and app-state
// scrubs can never interleave (K2). `credentialGeneration` bumps whenever a
// user-driven op establishes new authoritative state; a boot `initSyncPassword`
// that captured the pre-lock world and then lost the race for the lock detects
// the change and abandons its now-stale commit, so it can't resurrect a
// disconnected credential or clobber a fresh connect.
let credentialLock: Promise<unknown> = Promise.resolve();
let credentialGeneration = 0;

function withCredentialLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = credentialLock.then(fn, fn);
  // Keep the chain alive regardless of this op's outcome.
  credentialLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Delete the keyring entry; on failure surface it and mark a retry (K3). */
async function deleteStoredPassword(): Promise<void> {
  if (!isTauri) return;
  try {
    await invoke('e2ee_password_delete');
    if (getAppState().pendingKeyringDeletion) {
      // Clear the marker (undefined → dropped by JSON.stringify, not persisted).
      await saveAppState({ ...getAppState(), pendingKeyringDeletion: undefined });
    }
  } catch (e) {
    // Orphaned OS credential: don't fail the flow, but don't let it vanish
    // silently either — tell the user and persist a marker so the next launch
    // retries the delete (see initSyncPassword).
    showGlobalToast(`Couldn't remove the saved sync password: ${getSyncErrorMessage(e)}`);
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
  await loadAppState();
  if (!isTauri) return;

  // Finish a delete that a prior disconnect/forget couldn't complete.
  if (getAppState().pendingKeyringDeletion) {
    await withCredentialLock(async () => {
      if (getAppState().pendingKeyringDeletion) await deleteStoredPassword();
    });
    // If the delete still hasn't succeeded, do NOT load the credential the
    // user asked us to forget — leaving it unloaded keeps sync from resuming
    // and the delete is retried again next boot (R2).
    if (getAppState().pendingKeyringDeletion) return;
  }

  const gen = credentialGeneration;
  await withCredentialLock(async () => {
    // A connect/disconnect/forget won the lock ahead of us: its credential is
    // authoritative, so drop our stale migration/load entirely. If a legacy
    // plaintext holdover is still pinning the old password to disk, scrub it —
    // the old password is moot now (replaced or cleared), and leaving the
    // holdover set would keep re-writing plaintext forever, defeating F6.
    if (gen !== credentialGeneration) {
      if (getLegacyE2eePassword() !== undefined) {
        clearLegacyE2eePassword();
        await saveAppState(getAppState());
      }
      return;
    }
    const legacy = getLegacyE2eePassword();
    try {
      if (legacy != null) {
        // Keyring write MUST succeed before we stop re-injecting + scrub.
        await invoke('e2ee_password_set', { password: legacy });
        cachedPassword = legacy;
        clearLegacyE2eePassword();
        // getAppState() is sanitized (no e2eePassword) and the holdover is now
        // cleared, so this save rewrites the file without the plaintext field.
        await saveAppState(getAppState());
        return;
      }
      cachedPassword = (await invoke<string | null>('e2ee_password_get')) ?? null;
    } catch (e) {
      console.warn('[e2ee] keyring unavailable; vault password not loaded:', e);
    }
  });
}

export function hasStoredSyncPassword(): boolean {
  return cachedPassword != null;
}

export async function forgetStoredSyncPassword(): Promise<void> {
  await withCredentialLock(async () => {
    credentialGeneration++;
    cachedPassword = null;
    await deleteStoredPassword();
  });
}

export function isE2eeConfigured(): boolean {
  const s = getAppState();
  return Boolean(
    s.e2eeServerUrl && s.e2eeAuthToken && s.e2eeUserId && s.e2eeCollectionId && cachedPassword,
  );
}

/**
 * PKT-17: once the Rust import has persisted `.e2ee-state.json`, the legacy
 * `e2eeObjectMap` / `e2eeMaxVersion` in `.app-state.json` are dead (`load`
 * prefers `.e2ee-state.json`), so stop re-injecting them and let the next save
 * scrub them. The trigger is the ACTUAL existence of `.e2ee-state.json`, not
 * "a connect/resume returned": `e2ee_resume` (the path the pre-port cohort hits
 * on boot) does NOT persist — only `e2ee_connect` and a completed sync cycle
 * do — so clearing on resume alone could drop the map if the app dies before
 * the first cycle.
 *
 * BEST-EFFORT: this is called AFTER a connect/sync that has already committed,
 * so it must never turn a completed operation into a reported failure — every
 * path (the read, the scrub write) is swallowed and logged. A retained holdover
 * is fully recoverable (re-captured next boot, re-scrubbed next cycle).
 */
async function scrubLegacySyncStateIfConsumed(): Promise<void> {
  if (!isTauri || getLegacySyncState() === undefined) return;
  try {
    const persisted = await (await getPlatformFS()).readAppData('.e2ee-state.json');
    if (persisted == null) return;
    if (!(await commitLegacySyncStateScrub())) {
      console.warn('[e2ee] legacy sync-state scrub write failed; will retry next cycle');
    }
  } catch (e) {
    console.warn('[e2ee] legacy sync-state scrub deferred; will retry next cycle:', e);
  }
}

// ── Sync runner ─────────────────────────────────────────────────────────

async function ensureConnected(passwordOverride?: string): Promise<void> {
  const status = await invoke<E2eeStatusOutput>('e2ee_status');
  if (status.connected && passwordOverride == null) return;

  const s = getAppState();
  const password = passwordOverride ?? cachedPassword ?? undefined;
  if (!s.e2eeServerUrl || !s.e2eeAuthToken || !s.e2eeUserId || !s.e2eeCollectionId || !password) {
    throw new Error('E2EE sync not configured');
  }
  try {
    const input: E2eeResumeInput = {
      serverUrl: s.e2eeServerUrl,
      token: s.e2eeAuthToken,
      userId: s.e2eeUserId,
      collectionId: s.e2eeCollectionId,
      password,
    };
    await invoke('e2ee_resume', {
      input,
    });
  } catch (e) {
    // The stored vault no longer exists on the server — e.g. it was a duplicate
    // collection collapsed by the single-vault migration. Re-point to the
    // canonical vault: connect() re-picks it and persists the corrected ids, and
    // the orchestrator's reset→reconcile→push re-uploads our local notes to the
    // survivor. (Native shells already self-heal because they only ever
    // connect(), never resume().)
    if (String(e).includes('collection-gone')) {
      await connectE2ee(s.e2eeServerUrl, password);
    } else {
      throw e;
    }
  }
}

// ── Live sync (Rust SSE stream) ─────────────────────────────────────────

let liveStarted = false;

/** Idempotently start the Rust SSE live stream once per connected session. */
export async function ensureLiveSync(): Promise<void> {
  if (liveStarted || !isE2eeConfigured()) return;
  liveStarted = true;
  try {
    await invoke('e2ee_start_live');
  } catch (e) {
    liveStarted = false;
    console.warn('start live sync failed:', e);
  }
}

export async function stopLiveSync(): Promise<void> {
  liveStarted = false;
  try {
    await invoke('e2ee_stop_live');
  } catch {
    /* ignore */
  }
}

/** Signal the Rust live loop that a local note changed (the write-once
 * auto-push input). The loop debounces (~1s) and pushes to peers. No-op in
 * Rust when no live task is running, so it's safe to call unconditionally
 * after every save. Fire-and-forget. */
export async function notifyNoteChanged(): Promise<void> {
  try {
    await invoke('e2ee_note_changed');
  } catch {
    /* ignore */
  }
}

/**
 * Validate a user-entered sync server URL before attempting a connection.
 * Returns an actionable error message, or null when acceptable. Catches the
 * common mistake of omitting the scheme (a bare host like `notes.example.com`
 * would otherwise fail with an opaque transport error). Mirrors the native
 * shells' `validateServerUrl` (SyncManager.kt / SyncManager.swift). → sync.md
 *
 * All three copies must satisfy the shared case-set in
 * `tests/conformance/server-url.json`; the vitest suite asserts this copy
 * against it so the shells cannot silently drift.
 */
export function validateSyncServerUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return 'Enter a server URL.';
  const lower = trimmed.toLowerCase();
  if (!lower.startsWith('http://') && !lower.startsWith('https://')) {
    return 'Add http:// or https:// to the start of the server URL.';
  }
  return null;
}

export async function connectE2ee(serverUrl: string, password: string): Promise<void> {
  const urlError = validateSyncServerUrl(serverUrl);
  if (urlError) throw new Error(urlError);
  // Connect with (and persist) the trimmed URL, mirroring Android. Validation
  // trims before checking the scheme, so a whitespace-wrapped-but-valid URL
  // must not reach the transport untrimmed — that reintroduces the opaque
  // failure this validation exists to prevent. → sync.md
  const normalizedUrl = serverUrl.trim();
  const input: E2eeConnectInput = { serverUrl: normalizedUrl, password };
  const out = await invoke<E2eeConnectOutput>('e2ee_connect', {
    input,
  });
  await withCredentialLock(async () => {
    // A fresh credential is now authoritative — invalidate any in-flight boot
    // migration/load (K2).
    credentialGeneration++;
    // Session works from memory immediately (like the native shells).
    cachedPassword = password;
    // Persist the connection metadata FIRST, so we can never end up with a
    // keyring password that has no matching metadata on disk (P2). If this
    // write fails, the on-disk state stays consistently OLD and the keyring is
    // untouched — a restart resumes the old vault correctly rather than the old
    // vault with the new password. Preserve any existing orphan-delete marker
    // here; it is cleared below only after the new keyring write is confirmed.
    await saveAppState({
      ...getAppState(),
      e2eeServerUrl: normalizedUrl,
      e2eeAuthToken: out.token,
      e2eeUserId: out.userId,
      e2eeCollectionId: out.collectionId,
    });
    // Then persist the password. A keyring failure must not fail an otherwise
    // successful connect — it only means the password won't survive a restart
    // (re-enter from Settings), never a fallback to disk plaintext (F6). Leave
    // the orphan-delete marker in place so the boot retry still removes the old
    // entry (R3).
    let persisted = false;
    try {
      await invoke('e2ee_password_set', { password });
      persisted = true;
    } catch (e) {
      console.warn('[e2ee] could not persist vault password to keyring:', e);
    }
    // Drop a stale orphan-delete marker ONLY once the NEW password is confirmed
    // in the keyring (R3). Worst case if THIS write fails: the marker lingers
    // and the next boot's retry deletes the (valid) new entry, costing a
    // re-entry — never a mismatched credential.
    if (persisted && getAppState().pendingKeyringDeletion) {
      await saveAppState({ ...getAppState(), pendingKeyringDeletion: undefined });
    }
  });
  // `e2ee_connect` persisted `.e2ee-state.json` (importing any pre-port map), so
  // the legacy holdover is now dead — scrub it (PKT-17).
  await scrubLegacySyncStateIfConsumed();
}

export async function disconnectE2ee(): Promise<void> {
  // The Rust `e2ee_disconnect` already stops the live loop internally;
  // reset the flag so a future reconnect can restart the live stream.
  liveStarted = false;
  try {
    await invoke('e2ee_disconnect');
  } catch {
    // Disconnecting a non-connected client is fine.
  }
  await withCredentialLock(async () => {
    // Disconnect / "reset connection" / Full reset (resetAllNotes →
    // disconnectE2ee) must clear every trace of the vault credential, including
    // the keyring entry (M4). Bumping the generation invalidates a racing boot
    // migration so it can't resurrect the credential we're clearing (K2).
    credentialGeneration++;
    cachedPassword = null;
    // deleteStoredPassword handles a failed delete (toast + retry marker, K3).
    await deleteStoredPassword();
    await saveAppState({
      ...getAppState(),
      e2eeServerUrl: undefined,
      e2eeAuthToken: undefined,
      e2eeUserId: undefined,
      e2eeCollectionId: undefined,
      e2eeSalt: undefined,
    });
  });
}

export async function syncE2eeAuto(): Promise<SyncSummary> {
  await ensureConnected();
  try {
    const summary = await invoke<SyncSummary>('e2ee_sync_run');
    // The cycle persisted `.e2ee-state.json`; the pre-port map (imported by the
    // resume inside ensureConnected) is now durable — scrub the holdover (PKT-17).
    await scrubLegacySyncStateIfConsumed();
    return summary;
  } catch (e) {
    // The vault was collapsed/deleted server-side while we were already
    // connected (e.g. the single-vault migration during a server upgrade).
    // ensureConnected's resume-heal can't fire for a live session, so re-point
    // here: tear down the live loop bound to the gone vault, connect() re-picks
    // the survivor, and retry the sync once. The post-sync `ensureLiveSync`
    // (autoSyncV2) then restarts the live stream on the new session.
    const s = getAppState();
    if (String(e).includes('collection-gone') && s.e2eeServerUrl && cachedPassword) {
      await stopLiveSync();
      await connectE2ee(s.e2eeServerUrl, cachedPassword);
      return await invoke<SyncSummary>('e2ee_sync_run');
    }
    throw e;
  }
}

/**
 * Variant used by `__testSync` flows: the caller passes the password
 * explicitly (often a fresh value not yet in app-state). Rust re-derives
 * the key before running sync.
 */
export async function syncE2ee(password: string): Promise<SyncSummary> {
  await ensureConnected(password);
  const summary = await invoke<SyncSummary>('e2ee_sync_run');
  await scrubLegacySyncStateIfConsumed();
  return summary;
}

// ── Progress events ─────────────────────────────────────────────────────

let progressUnlisten: UnlistenFn | null = null;
let progressListener: ((p: SyncProgress) => void) | null = null;

async function ensureProgressSubscription(): Promise<void> {
  if (progressUnlisten) return;
  progressUnlisten = await listen<SyncProgress>('sync:progress', (event) => {
    if (progressListener) {
      try {
        progressListener(event.payload);
      } catch {
        // Listener errors must not break the sync stream.
      }
    }
  });
}

export function setSyncProgressListener(listener: ((p: SyncProgress) => void) | null): void {
  progressListener = listener;
  if (listener) {
    void ensureProgressSubscription();
  } else if (progressUnlisten) {
    progressUnlisten();
    progressUnlisten = null;
  }
}
