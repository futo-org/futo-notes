import { isMobile, hasFileSystem } from './platform';
import { getCachedPreferences } from './preferences';
import { syncNow, type SyncSummary } from './sync';
import { startSSE, stopSSE, isSSEConnected } from './sseClient';

const SSE_SYNC_DEBOUNCE = 100;
const RESUME_COOLDOWN = 10_000;

export interface AutoSyncCallbacks {
  onSyncStart: () => void;
  onSyncComplete: (summary: SyncSummary) => void;
  onSyncError: (error: Error) => void;
  flushPendingSave: () => Promise<void>;
  onSupersearchReady?: () => void;
}

let callbacks: AutoSyncCallbacks | null = null;
let sseDebounceTimer: number | null = null;
let syncing = false;
let lastSyncTime = 0;
let cleanupFns: Array<() => void> = [];

function isSyncConfigured(): boolean {
  const prefs = getCachedPreferences();
  return Boolean(prefs.sync.serverUrl && prefs.sync.token);
}

async function performSync(): Promise<void> {
  if (syncing || !callbacks || !isSyncConfigured()) return;
  syncing = true;
  callbacks.onSyncStart();
  try {
    await callbacks.flushPendingSave();
    const summary = await syncNow();
    lastSyncTime = Date.now();
    // Ensure SSE is connected (handles case where prefs weren't loaded at startup)
    if (!isSSEConnected()) connectSSE();
    callbacks.onSyncComplete(summary);
  } catch (e) {
    callbacks.onSyncError(e instanceof Error ? e : new Error(String(e)));
  } finally {
    syncing = false;
  }
}

export function notifySaved(): void {
  if (!callbacks || !isSyncConfigured()) return;
  performSync();
}

export async function requestSync(): Promise<void> {
  if (!isSyncConfigured()) throw new Error('Sync not configured');
  if (syncing) throw new Error('Sync already in progress');
  connectSSE();
  await performSync();
}

function handleResume(): void {
  if (!isSyncConfigured()) return;
  if (Date.now() - lastSyncTime < RESUME_COOLDOWN) return;
  performSync();
}

function handleSSENotification(): void {
  if (sseDebounceTimer !== null) clearTimeout(sseDebounceTimer);
  sseDebounceTimer = window.setTimeout(() => {
    sseDebounceTimer = null;
    performSync();
  }, SSE_SYNC_DEBOUNCE);
}

function handleSupersearchReady(): void {
  callbacks?.onSupersearchReady?.();
}

export function connectSSE(): void {
  if (!isSyncConfigured()) return;
  const prefs = getCachedPreferences();
  startSSE(prefs.sync.serverUrl, prefs.sync.token, handleSSENotification, handleSupersearchReady);
}

export function startAutoSync(cb: AutoSyncCallbacks): void {
  callbacks = cb;

  if (!hasFileSystem) return;

  // SSE for near-instant notifications (may no-op if prefs aren't loaded yet)
  connectSSE();

  // Initial sync after a short delay to let preferences load from disk
  window.setTimeout(() => {
    connectSSE();
    performSync();
  }, 2_000);

  // App resume / visibility
  if (isMobile) {
    import('@capacitor/app').then(({ App }) => {
      const handle = App.addListener('resume', () => {
        connectSSE(); // Reconnect SSE after resume
        handleResume();
      });
      cleanupFns.push(() => handle.then(h => h.remove()));
    });
  } else {
    const handler = () => {
      if (document.visibilityState === 'visible') handleResume();
    };
    document.addEventListener('visibilitychange', handler);
    cleanupFns.push(() => document.removeEventListener('visibilitychange', handler));
  }
}

export function stopAutoSync(): void {
  stopSSE();
  if (sseDebounceTimer !== null) {
    clearTimeout(sseDebounceTimer);
    sseDebounceTimer = null;
  }
  for (const fn of cleanupFns) fn();
  cleanupFns = [];
  callbacks = null;
}
