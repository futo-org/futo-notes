import { hasFileSystem } from './platform';
import { getCachedPreferences } from './preferences';
import { syncNow, type SyncSummary } from './sync';
import { startSSE, stopSSE, isSSEConnected } from './sseClient';

const SSE_SYNC_DEBOUNCE = 100;
const SSE_POST_SYNC_COOLDOWN = 5_000;
const RESUME_COOLDOWN = 10_000;
const BACKGROUND_SYNC_RETRY_DELAY = 1_000;

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
let paused = false;
let lastSyncTime = 0;
let cleanupFns: Array<() => void> = [];
let initialSyncTimer: number | null = null;
let initialRetryTimer: number | null = null;
let initialRetryCount = 0;
let backgroundRetryTimer: number | null = null;
let pendingBackgroundTrigger: SyncTrigger | null = null;
const INITIAL_RETRY_DELAYS = [4_000, 8_000, 16_000, 30_000, 30_000];

type SyncTrigger = 'local-save' | 'manual' | 'sse' | 'resume' | 'initial';
interface PerformSyncOptions {
  propagateErrors?: boolean;
  requireExecution?: boolean;
}

function isBackgroundTrigger(trigger: SyncTrigger): boolean {
  return trigger === 'sse' || trigger === 'resume' || trigger === 'initial';
}

function isSyncConfigured(): boolean {
  const prefs = getCachedPreferences();
  return Boolean(prefs.sync.serverUrl && prefs.sync.token);
}

async function performSync(trigger: SyncTrigger, options: PerformSyncOptions = {}): Promise<SyncSummary | null> {
  const backgroundTrigger = isBackgroundTrigger(trigger);
  if (syncing || paused || !callbacks || !isSyncConfigured()) {
    if (!options.requireExecution && backgroundTrigger && callbacks && isSyncConfigured() && (syncing || paused)) {
      scheduleBackgroundRetry(trigger);
    }
    if (options.requireExecution) {
      if (syncing) throw new Error('Sync already in progress');
      if (!callbacks) throw new Error('Sync system not initialized');
      throw new Error('Sync not configured');
    }
    return null;
  }
  if (backgroundTrigger && callbacks.shouldDeferSync?.()) {
    scheduleBackgroundRetry(trigger);
    return null;
  }
  syncing = true;
  try {
    if (trigger === 'local-save' || trigger === 'manual') {
      await callbacks.flushPendingSave();
    }
    const summary = await syncNow();
    lastSyncTime = Date.now();
    // Successful sync from any trigger cancels initial retries
    cancelInitialRetry();
    cancelBackgroundRetry();
    // Ensure SSE is connected (handles case where prefs weren't loaded at startup)
    if (!isSSEConnected()) connectSSE();
    callbacks.onSyncComplete(summary);
    return summary;
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    callbacks.onSyncError(error);
    if (options.propagateErrors) {
      throw error;
    }
    return null;
  } finally {
    syncing = false;
  }
}

export function notifySaved(): void {
  if (!callbacks || !isSyncConfigured()) return;
  performSync('local-save');
}

/** Block all auto-sync and manual sync from starting. */
export function pauseSync(): void { paused = true; }

/** Re-allow sync after a pause. */
export function resumeSync(): void { paused = false; }

/** Wait for any in-flight sync to finish (polls every 50ms). */
export async function waitForSyncIdle(): Promise<void> {
  while (syncing) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

export async function requestSync(): Promise<void> {
  if (!isSyncConfigured()) throw new Error('Sync not configured');
  if (!callbacks) throw new Error('Sync system not initialized');
  if (syncing) await waitForSyncIdle();
  if (!isSSEConnected()) connectSSE();
  await performSync('manual', { propagateErrors: true, requireExecution: true });
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

function cancelBackgroundRetry(): void {
  pendingBackgroundTrigger = null;
  if (backgroundRetryTimer !== null) {
    clearTimeout(backgroundRetryTimer);
    backgroundRetryTimer = null;
  }
}

function scheduleBackgroundRetry(trigger: SyncTrigger): void {
  if (!callbacks || !isSyncConfigured() || !isBackgroundTrigger(trigger)) return;
  pendingBackgroundTrigger = trigger;
  if (backgroundRetryTimer !== null) return;
  backgroundRetryTimer = window.setTimeout(() => {
    backgroundRetryTimer = null;
    const retryTrigger = pendingBackgroundTrigger;
    pendingBackgroundTrigger = null;
    if (!retryTrigger) return;
    void performSync(retryTrigger);
  }, BACKGROUND_SYNC_RETRY_DELAY);
}

function cancelInitialRetry(): void {
  if (initialRetryTimer !== null) {
    clearTimeout(initialRetryTimer);
    initialRetryTimer = null;
  }
  initialRetryCount = 0;
}

function scheduleInitialRetry(): void {
  if (initialRetryCount >= INITIAL_RETRY_DELAYS.length) return;
  const delay = INITIAL_RETRY_DELAYS[initialRetryCount];
  initialRetryCount++;
  console.log(`[autoSync] initial sync retry #${initialRetryCount} in ${delay / 1000}s`);
  initialRetryTimer = window.setTimeout(() => {
    initialRetryTimer = null;
    performSync('initial').then(summary => {
      if (!summary) scheduleInitialRetry();
    });
  }, delay);
}

export function connectSSE(): void {
  if (!isSyncConfigured()) return;
  const prefs = getCachedPreferences();
  startSSE(prefs.sync.serverUrl, prefs.sync.token, handleSSENotification, handleSupersearchReady);
}

export function startAutoSync(cb: AutoSyncCallbacks): void {
  callbacks = cb;
  cancelBackgroundRetry();
  if (initialSyncTimer !== null) {
    clearTimeout(initialSyncTimer);
    initialSyncTimer = null;
  }

  if (!hasFileSystem) return;

  // SSE for near-instant notifications (may no-op if prefs aren't loaded yet)
  connectSSE();

  // Initial sync after a short delay to let preferences load from disk
  initialSyncTimer = window.setTimeout(() => {
    initialSyncTimer = null;
    connectSSE();
    performSync('initial').then(summary => {
      if (!summary) scheduleInitialRetry();
    });
  }, 2_000);

  // App resume / visibility
  const handler = () => {
    if (document.visibilityState === 'visible') {
      connectSSE(); // Reconnect SSE after resume
      handleResume();
    }
  };
  document.addEventListener('visibilitychange', handler);
  cleanupFns.push(() => document.removeEventListener('visibilitychange', handler));
}

export function stopAutoSync(): void {
  stopSSE();
  if (initialSyncTimer !== null) {
    clearTimeout(initialSyncTimer);
    initialSyncTimer = null;
  }
  cancelInitialRetry();
  cancelBackgroundRetry();
  if (sseDebounceTimer !== null) {
    clearTimeout(sseDebounceTimer);
    sseDebounceTimer = null;
  }
  for (const fn of cleanupFns) fn();
  cleanupFns = [];
  callbacks = null;
}
