/**
 * Thin shim over the Rust-side E2EE sync orchestrator.
 *
 * All the heavy work (PBKDF2, AES-GCM, blob HTTP, push/pull, 3-way merge,
 * conflict resolution, persistence) lives in `crates/futo-notes-sync`; the
 * desktop IPC adapter lives in `apps/tauri/src-tauri/src/sync/`
 * and `crates/futo-notes-core/src/e2ee/`. This file exists so the rest of
 * the app's import path stays stable: `connectE2ee`, `syncE2eeAuto`,
 * `disconnectE2ee`, `setSyncProgressListener`, and the `SyncSummary` /
 * `SyncProgress` types continue to be exported from `$features/sync/syncServiceE2ee`
 * the way callers expect.
 */

import { invoke } from '$lib/platform/tauri/invoke';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { clearLegacyE2eeAuthToken, getAppState, saveAppState } from '$shared/state/appState';
import type {
  E2eeConnectInput,
  E2eeConnectOutput,
  E2eeResumeInput,
  E2eeStatusOutput,
  OpenNoteDispositionOutput,
  OpenNoteRequestInput,
  SyncFailure,
  SyncSummary,
} from './syncContract.generated';
import { connectHostedE2ee } from './hostedSession';
import { deleteStoredCredentials, withCredentialLock } from './syncCredentialStore';
import { sessionState } from './syncSessionState';
import { clearLastSyncedAt, scrubLegacySyncStateIfConsumed } from './syncStateCleanup';

export {
  forgetStoredSyncPassword,
  hasStoredSyncPassword,
  initSyncPassword,
  whenSyncCredentialsSettled,
} from './syncCredentialStore';
export { connectHostedE2ee, forgetHostedE2ee } from './hostedSession';

// ── Public types ────────────────────────────────────────────────────────

export type { SyncFailure, SyncSummary };
export type { OpenNoteDispositionOutput, OpenNoteRequestInput };

export type SyncProgress = {
  phase: 'reconciling' | 'pushing' | 'pulling';
  current: number;
  total: number;
};

/** Ask the desktop adapter for the one engine-owned verdict on the open note.
 * The adapter reads disk inside the command, so this is the decision's only
 * frontend round trip. */
export function classifyOpenNote(facts: OpenNoteRequestInput): Promise<OpenNoteDispositionOutput> {
  return invoke<OpenNoteDispositionOutput>('e2ee_classify_open_note', { facts });
}

export function isE2eeConfigured(): boolean {
  // `hostedSavedVault` without `hostedConnected` is the launch-time offline
  // case: the vault is configured, this process just has not handed its
  // secrets to the engine yet. Answering true is what lets the next auto-sync
  // trigger reach `ensureConnected`, which does the connect — so the retry
  // rides the ladder auto-sync already has instead of needing one of its own.
  if (sessionState.hostedConnected || sessionState.hostedSavedVault) return true;
  const s = getAppState();
  return Boolean(
    s.e2eeServerUrl && s.e2eeUserId && s.e2eeCollectionId && sessionState.cachedPassword,
  );
}

// ── Sync runner ─────────────────────────────────────────────────────────

export function isRecoverableSessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('collection-gone') ||
    message.startsWith('auth:') ||
    /\bHTTP 401\b/i.test(message) ||
    /\b401 Unauthorized\b/i.test(message)
  );
}

/** Rebuild the authenticated session without demoting or deleting sync state. */
export async function reauthenticateE2ee(password: string): Promise<void> {
  const serverUrl = getAppState().e2eeServerUrl;
  if (!serverUrl) throw new Error('E2EE sync not configured');
  await stopLiveSync();
  await connectE2ee(serverUrl, password);
}

async function ensureConnected(passwordOverride?: string): Promise<void> {
  const status = await invoke<E2eeStatusOutput>('e2ee_status');
  if (status.connected && passwordOverride == null) return;

  // A hosted session has no password to resume with, and needs none: the key
  // and the token are already in the keyring, so reconnecting is the same call
  // that made it in the first place. This is also the retry for a launch
  // connect that failed — `hostedSavedVault` without `hostedConnected` — which
  // is why it is here and not on a timer of auto-sync's own.
  if ((sessionState.hostedConnected || sessionState.hostedSavedVault) && passwordOverride == null) {
    await connectHostedE2ee();
    return;
  }

  const s = getAppState();
  const password = passwordOverride ?? sessionState.cachedPassword ?? undefined;
  if (!s.e2eeServerUrl || !s.e2eeUserId || !s.e2eeCollectionId || !password) {
    throw new Error('E2EE sync not configured');
  }
  if (!sessionState.cachedAuthToken) {
    await reauthenticateE2ee(password);
    return;
  }
  try {
    const input: E2eeResumeInput = {
      serverUrl: s.e2eeServerUrl,
      token: sessionState.cachedAuthToken,
      userId: s.e2eeUserId,
      collectionId: s.e2eeCollectionId,
      password,
    };
    await invoke('e2ee_resume', {
      input,
    });
  } catch (e) {
    // A fresh login recovers both an expired token and a migration-collapsed
    // vault, without deleting sync state. → sync.md
    if (isRecoverableSessionError(e)) {
      await reauthenticateE2ee(password);
    } else {
      throw e;
    }
  }
}

// ── Live sync (Rust SSE stream) ─────────────────────────────────────────

/** Idempotently start the Rust SSE live stream once per connected session. */
export async function ensureLiveSync(): Promise<void> {
  if (sessionState.liveStarted || !isE2eeConfigured()) return;
  sessionState.liveStarted = true;
  try {
    await invoke('e2ee_start_live');
  } catch (e) {
    sessionState.liveStarted = false;
    console.warn('start live sync failed:', e);
  }
}

export async function stopLiveSync(): Promise<void> {
  sessionState.liveStarted = false;
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
    sessionState.credentialGeneration++;
    // Session works from memory immediately (like the native shells).
    sessionState.cachedPassword = password;
    sessionState.cachedAuthToken = out.token;
    // A new login supersedes any legacy token captured before boot migration.
    // Stop re-injecting that bearer on every app-state write.
    clearLegacyE2eeAuthToken();
    // Persist the connection metadata FIRST, so we can never end up with a
    // keyring password that has no matching metadata on disk (P2). If this
    // write fails, the on-disk state stays consistently OLD and the keyring is
    // untouched — a restart resumes the old vault correctly rather than the old
    // vault with the new password. Preserve any existing orphan-delete marker
    // here; it is cleared below only after the new keyring write is confirmed.
    await saveAppState({
      ...getAppState(),
      e2eeServerUrl: normalizedUrl,
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
      await invoke('e2ee_session_token_set', { token: out.token });
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
  sessionState.liveStarted = false;
  // A hosted session is a session too: a reset must not leave this module
  // claiming one the engine has just dropped — including the saved-vault fact,
  // which would otherwise keep reporting the vault configured and resume it on
  // the next trigger (M4).
  sessionState.hostedConnected = false;
  sessionState.hostedSavedVault = false;
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
    sessionState.credentialGeneration++;
    sessionState.cachedPassword = null;
    sessionState.cachedAuthToken = null;
    clearLegacyE2eeAuthToken();
    // deleteStoredCredentials handles a failed delete (toast + retry marker, K3).
    await deleteStoredCredentials();
    await saveAppState({
      ...getAppState(),
      e2eeServerUrl: undefined,
      e2eeUserId: undefined,
      e2eeCollectionId: undefined,
      e2eeSalt: undefined,
    });
  });
  await clearLastSyncedAt();
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
    // An active session can fail after ensureConnected's resume path has been
    // skipped. Stop its live loop, authenticate again, and retry exactly once;
    // the post-sync ensureLiveSync call restarts the stream on the new session.
    const s = getAppState();
    if (isRecoverableSessionError(e) && s.e2eeServerUrl && sessionState.cachedPassword) {
      await reauthenticateE2ee(sessionState.cachedPassword);
      const summary = await invoke<SyncSummary>('e2ee_sync_run');
      await scrubLegacySyncStateIfConsumed();
      return summary;
    }
    throw e;
  }
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
