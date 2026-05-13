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
  await invoke('e2ee_resume', {
    input: {
      serverUrl: s.e2eeServerUrl,
      token: s.e2eeAuthToken,
      userId: s.e2eeUserId,
      collectionId: s.e2eeCollectionId,
      password,
    },
  });
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
  const summary = await invoke<SyncSummary>('e2ee_sync_run');
  return summary;
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
