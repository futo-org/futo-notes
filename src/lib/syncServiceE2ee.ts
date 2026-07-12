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
import { getAppState, loadAppState, saveAppState, takeLegacyE2eePassword } from './appState';
import { isTauri } from './platform';

// ── Public types ────────────────────────────────────────────────────────

export interface SyncSummary {
  uploaded: number;
  downloaded: number;
  deleted: number;
  conflicts: number;
  /** Per-item ops that failed without aborting the cycle. Non-empty drives
   *  the failure indicator + toast. */
  failures: SyncFailure[];
  /** User-facing one-liner describing `failures`, computed in the Rust core
   *  so every shell shows identical wording. Absent for a clean cycle. */
  failureMessage?: string | null;
  updatedIds: string[];
  deletedIds: string[];
  renamed: Array<{ fromId: string; toId: string }>;
  peerUpdatedIds: string[];
  peerDeletedIds: string[];
}

/** One per-item sync failure. `kind` is `'upload' | 'delete' | 'checkpoint'
 *  | 'download' | 'decrypt'`; `statusCode` is the server HTTP status when
 *  the failure came from a response (absent for transport/local errors). */
export interface SyncFailure {
  filename: string;
  kind: string;
  statusCode?: number;
}

export type SyncProgress = {
  phase: 'reconciling' | 'pushing' | 'pulling';
  current: number;
  total: number;
};

// ── Internal wire types ─────────────────────────────────────────────────

interface E2eeConnectOutput {
  userId: string;
  collectionId: string;
  token: string;
  authMode: string;
}

interface E2eeStatusOutput {
  connected: boolean;
  serverUrl?: string;
  userId?: string;
  collectionId?: string;
  maxVersion: number;
  objectCount: number;
}

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

/**
 * One-time boot hook: migrate a legacy plaintext `e2eePassword` from
 * `.app-state.json` into the OS keyring (scrubbing the JSON only after the
 * keyring write is confirmed), then load the stored password into memory.
 *
 * Never throws — a keyring failure (e.g. headless Linux with no Secret
 * Service) leaves any legacy value in place for a later retry and runs the
 * session password-less, so the user is prompted to re-enter it rather than
 * ever falling back to disk plaintext. Safe to call un-awaited at startup.
 */
export async function initSyncPassword(): Promise<void> {
  await loadAppState();
  if (!isTauri) return;
  const legacy = takeLegacyE2eePassword();
  try {
    if (legacy != null) {
      // Keyring write MUST succeed before we scrub the plaintext.
      await invoke('e2ee_password_set', { password: legacy });
      cachedPassword = legacy;
      // getAppState() is already sanitized (no e2eePassword) — this save
      // rewrites the file without the legacy field.
      await saveAppState(getAppState());
      return;
    }
    cachedPassword = (await invoke<string | null>('e2ee_password_get')) ?? null;
  } catch (e) {
    console.warn('[e2ee] keyring unavailable; vault password not loaded:', e);
  }
}

export function hasStoredSyncPassword(): boolean {
  return cachedPassword != null;
}

export async function forgetStoredSyncPassword(): Promise<void> {
  if (isTauri) await invoke('e2ee_password_delete');
  cachedPassword = null;
}

export function isE2eeConfigured(): boolean {
  const s = getAppState();
  return Boolean(
    s.e2eeServerUrl && s.e2eeAuthToken && s.e2eeUserId && s.e2eeCollectionId && cachedPassword,
  );
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
    await invoke('e2ee_resume', {
      input: {
        serverUrl: s.e2eeServerUrl,
        token: s.e2eeAuthToken,
        userId: s.e2eeUserId,
        collectionId: s.e2eeCollectionId,
        password,
      },
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
  const out = await invoke<E2eeConnectOutput>('e2ee_connect', {
    input: { serverUrl: normalizedUrl, password },
  });
  await saveAppState({
    ...getAppState(),
    e2eeServerUrl: normalizedUrl,
    e2eeAuthToken: out.token,
    e2eeUserId: out.userId,
    e2eeCollectionId: out.collectionId,
  });
  // Keep the session working from memory first, then persist to the keyring.
  // A keyring failure must not fail an otherwise-successful connect — it only
  // means the password won't survive a restart (re-prompt), never a fallback
  // to disk plaintext (F6).
  cachedPassword = password;
  try {
    await invoke('e2ee_password_set', { password });
  } catch (e) {
    console.warn('[e2ee] could not persist vault password to keyring:', e);
  }
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
  // Drop the stored password too: disconnect / "reset connection" and the
  // Full reset (deleteAllNotes → disconnectE2ee) must clear every trace of
  // the vault credential, including the keyring entry (M4). Best-effort so a
  // keyring hiccup can't wedge disconnect.
  cachedPassword = null;
  if (isTauri) {
    try {
      await invoke('e2ee_password_delete');
    } catch (e) {
      console.warn('[e2ee] could not delete vault password from keyring:', e);
    }
  }
  await saveAppState({
    ...getAppState(),
    e2eeServerUrl: undefined,
    e2eeAuthToken: undefined,
    e2eeUserId: undefined,
    e2eeCollectionId: undefined,
    e2eeSalt: undefined,
  });
}

export async function syncE2eeAuto(): Promise<SyncSummary> {
  await ensureConnected();
  try {
    return await invoke<SyncSummary>('e2ee_sync_run');
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
  return await invoke<SyncSummary>('e2ee_sync_run');
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
