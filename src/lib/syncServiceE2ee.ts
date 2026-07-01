/**
 * Thin shim over the Rust-side E2EE sync orchestrator.
 *
 * All the heavy work (PBKDF2, AES-GCM, blob HTTP, push/pull, 3-way merge,
 * conflict resolution, persistence) lives in `apps/tauri/src-tauri/src/sync.rs`
 * and `crates/futo-notes-core/src/e2ee.rs`. This file exists so the rest of
 * the app's import path stays stable: `connectE2ee`, `syncE2eeAuto`,
 * `disconnectE2ee`, `setSyncProgressListener`, and the `SyncSummary` /
 * `SyncProgress` types continue to be re-exported from `$lib/syncServiceE2ee`
 * the way callers expect.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getAppState, saveAppState } from './appState';

// ── Public types ────────────────────────────────────────────────────────

export interface SyncSummary {
  uploaded: number;
  downloaded: number;
  deleted: number;
  conflicts: number;
  updatedIds: string[];
  deletedIds: string[];
  renamed: Array<{ fromId: string; toId: string }>;
  peerUpdatedIds: string[];
  peerDeletedIds: string[];
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

// ── Password helpers (state still JS-owned) ─────────────────────────────

export function hasStoredSyncPassword(): boolean {
  return getAppState().e2eePassword != null;
}

export async function forgetStoredSyncPassword(): Promise<void> {
  await saveAppState({ ...getAppState(), e2eePassword: undefined });
}

export function isE2eeConfigured(): boolean {
  const s = getAppState();
  return Boolean(
    s.e2eeServerUrl &&
      s.e2eeAuthToken &&
      s.e2eeUserId &&
      s.e2eeCollectionId &&
      s.e2eePassword,
  );
}

// ── Sync runner ─────────────────────────────────────────────────────────

async function ensureConnected(passwordOverride?: string): Promise<void> {
  const status = await invoke<E2eeStatusOutput>('e2ee_status');
  if (status.connected && passwordOverride == null) return;

  const s = getAppState();
  const password = passwordOverride ?? s.e2eePassword;
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
  try { await invoke('e2ee_start_live'); }
  catch (e) { liveStarted = false; console.warn('start live sync failed:', e); }
}

export async function stopLiveSync(): Promise<void> {
  liveStarted = false;
  try { await invoke('e2ee_stop_live'); } catch { /* ignore */ }
}

/** Signal the Rust live loop that a local note changed (the write-once
 * auto-push input). The loop debounces (~1s) and pushes to peers. No-op in
 * Rust when no live task is running, so it's safe to call unconditionally
 * after every save. Fire-and-forget. */
export async function notifyNoteChanged(): Promise<void> {
  try { await invoke('e2ee_note_changed'); } catch { /* ignore */ }
}

export async function connectE2ee(serverUrl: string, password: string): Promise<void> {
  const out = await invoke<E2eeConnectOutput>('e2ee_connect', {
    input: { serverUrl, password },
  });
  await saveAppState({
    ...getAppState(),
    e2eeServerUrl: serverUrl,
    e2eeAuthToken: out.token,
    e2eeUserId: out.userId,
    e2eeCollectionId: out.collectionId,
    e2eePassword: password,
  });
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
  await saveAppState({
    ...getAppState(),
    e2eeServerUrl: undefined,
    e2eeAuthToken: undefined,
    e2eeUserId: undefined,
    e2eeCollectionId: undefined,
    e2eeSalt: undefined,
    e2eePassword: undefined,
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
    if (String(e).includes('collection-gone') && s.e2eeServerUrl && s.e2eePassword) {
      await stopLiveSync();
      await connectE2ee(s.e2eeServerUrl, s.e2eePassword);
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
