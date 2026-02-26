import { isMobile, hasFileSystem } from './platform';
import { getCachedPreferences } from './preferences';
import { syncNow, type SyncSummary } from './sync';
import { startSSE, stopSSE, isSSEConnected } from './sseClient';

const SSE_SYNC_DEBOUNCE = 100;
const SSE_POST_SYNC_COOLDOWN = 5_000;
const RESUME_COOLDOWN = 10_000;

export interface AutoSyncCallbacks {
  onSyncComplete: (summary: SyncSummary) => void;
  onSyncError: (error: Error) => void;
  flushPendingSave: () => Promise<void>;
  onSupersearchReady?: () => void;
  shouldDeferSync?: () => boolean;
}

let callbacks: AutoSyncCallbacks | null = null;
let sseDebounceTimer: number | null = null;
let syncing = false;
let lastSyncTime = 0;
let cleanupFns: Array<() => void> = [];

type SyncTrigger = 'local-save' | 'manual' | 'sse' | 'resume' | 'initial';

function isSyncConfigured(): boolean {
  const prefs = getCachedPreferences();
  return Boolean(prefs.sync.serverUrl && prefs.sync.token);
}

async function performSync(trigger: SyncTrigger): Promise<void> {
  if (syncing || !callbacks || !isSyncConfigured()) return;
  const isBackgroundTrigger = trigger === 'sse' || trigger === 'resume' || trigger === 'initial';
  if (isBackgroundTrigger && callbacks.shouldDeferSync?.()) return;
  syncing = true;
  try {
    if (trigger === 'local-save' || trigger === 'manual') {
      await callbacks.flushPendingSave();
    }
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
  performSync('local-save');
}

export async function requestSync(): Promise<void> {
  if (!isSyncConfigured()) throw new Error('Sync not configured');
  if (syncing) throw new Error('Sync already in progress');
  if (!isSSEConnected()) connectSSE();
  await performSync('manual');
}

function handleResume(): void {
  if (!isSyncConfigured()) return;
  if (Date.now() - lastSyncTime < RESUME_COOLDOWN) return;
  performSync('resume');
}

function handleSSENotification(): void {
  if (sseDebounceTimer !== null) clearTimeout(sseDebounceTimer);
  // If we just synced, wait longer before reacting to SSE notifications
  // (our own sync broadcasts to others, who sync back, which broadcasts to us)
  const timeSinceSync = Date.now() - lastSyncTime;
  const delay = timeSinceSync < SSE_POST_SYNC_COOLDOWN
    ? SSE_POST_SYNC_COOLDOWN - timeSinceSync
    : SSE_SYNC_DEBOUNCE;
  sseDebounceTimer = window.setTimeout(() => {
    sseDebounceTimer = null;
    performSync('sse');
  }, delay);
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
    performSync('initial');
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
