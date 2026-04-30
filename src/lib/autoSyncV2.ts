import { hasFileSystem } from './platform';
import { syncE2eeAuto, isE2eeConfigured, type SyncSummary } from './syncServiceE2ee';

export type { SyncSummary } from './syncServiceE2ee';

// Pull-only interval — local edits push via notifySavedV2, so this only
// covers cross-device propagation.
const POLL_INTERVAL_MS = 15_000;
const INITIAL_SYNC_DELAY_MS = 8_000;
const RESUME_COOLDOWN = 10_000;
const BACKGROUND_SYNC_RETRY_DELAY = 1_000;
const INITIAL_RETRY_DELAYS = [4_000, 8_000, 16_000, 30_000, 30_000];

export interface AutoSyncCallbacks {
  onSyncComplete: (summary: SyncSummary) => void;
  onSyncError: (error: Error) => void;
  flushPendingSave: () => Promise<void>;
  shouldDeferSync?: () => boolean;
  onSyncStateChange?: (syncing: boolean) => void;
  onOfflineChange?: (offline: boolean) => void;
}

let callbacks: AutoSyncCallbacks | null = null;
let flushPendingSaveFn: (() => Promise<void>) | null = null;
let syncing = false;
let paused = false;
let lastSyncTime = 0;
let cleanupFns: Array<() => void> = [];
let initialSyncTimer: number | null = null;
let initialRetryTimer: number | null = null;
let initialRetryCount = 0;
let backgroundRetryTimer: number | null = null;
let pollTimer: number | null = null;
let pendingLocalSave = false;
let pendingLocalSaveTimer: number | null = null;

type SyncTrigger = 'local-save' | 'manual' | 'poll' | 'resume' | 'initial';

function isBackgroundTrigger(trigger: SyncTrigger): boolean {
  return trigger === 'poll' || trigger === 'resume' || trigger === 'initial';
}

async function performSync(trigger: SyncTrigger, options: { propagateErrors?: boolean; requireExecution?: boolean } = {}): Promise<SyncSummary | null> {
  const backgroundTrigger = isBackgroundTrigger(trigger);
  if (!navigator.onLine) {
    callbacks?.onOfflineChange?.(true);
    if (backgroundTrigger) scheduleBackgroundRetry(trigger);
    return null;
  }
  if (syncing || paused || !callbacks || !isE2eeConfigured()) {
    if (!options.requireExecution && backgroundTrigger && callbacks && isE2eeConfigured() && (syncing || paused)) {
      scheduleBackgroundRetry(trigger);
    }
    if (syncing && trigger === 'local-save') {
      pendingLocalSave = true;
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
  callbacks.onSyncStateChange?.(true);
  try {
    if (trigger === 'local-save' || trigger === 'manual') {
      await callbacks.flushPendingSave();
    }
    const summary = await syncE2eeAuto();
    lastSyncTime = Date.now();
    cancelInitialRetry();
    cancelBackgroundRetry();
    callbacks.onSyncComplete(summary);
    return summary;
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    callbacks.onSyncError(error);
    if (options.propagateErrors) throw error;
    return null;
  } finally {
    syncing = false;
    callbacks.onSyncStateChange?.(false);
    if (pendingLocalSave) {
      pendingLocalSave = false;
      cancelPendingLocalSaveRetry();
      pendingLocalSaveTimer = window.setTimeout(() => {
        pendingLocalSaveTimer = null;
        void performSync('local-save');
      }, 2_000);
    }
  }
}

/** Trailing debounce — coalesces an edit burst into one sync.
 */
const NOTIFY_DEBOUNCE_MS = 2_000;
let notifyDebounceTimer: ReturnType<typeof setTimeout> | null = null;

export function notifySavedV2(filename?: string): void {
  if (!callbacks || !isE2eeConfigured()) return;
  // Write to dirty journal if a specific file was saved
  if (filename) {
    void markDirtyUpsert(filename);
  }
  if (notifyDebounceTimer !== null) clearTimeout(notifyDebounceTimer);
  notifyDebounceTimer = setTimeout(() => {
    notifyDebounceTimer = null;
    void performSync('local-save');
  }, NOTIFY_DEBOUNCE_MS);
}

// Dirty journal stubs — E2EE sync compares local files against the object map
// directly, so per-file dirty tracking is not needed. These are kept as no-ops
// to satisfy callers in notes.svelte.ts and syncManager.
async function markDirtyUpsert(_filename: string): Promise<void> {}
export async function markDirtyDelete(_filename: string): Promise<void> {}
export async function markDirtyRename(_oldFilename: string, _newFilename: string): Promise<void> {}

export function pauseSyncV2(): void { paused = true; }
export function resumeSyncV2(): void { paused = false; }

export async function waitForSyncIdleV2(): Promise<void> {
  while (syncing) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

export async function requestSyncV2(): Promise<SyncSummary> {
  if (!isE2eeConfigured()) throw new Error('Sync not configured');
  if (!callbacks) {
    if (flushPendingSaveFn) await flushPendingSaveFn();
    return await syncE2eeAuto();
  }
  if (syncing) await waitForSyncIdleV2();
  const summary = await performSync('manual', { propagateErrors: true, requireExecution: true });
  if (!summary) {
    throw new Error('Manual sync did not execute');
  }
  return summary;
}

function handleResume(): void {
  if (!isE2eeConfigured()) return;
  if (Date.now() - lastSyncTime < RESUME_COOLDOWN) return;
  void performSync('resume');
}

// ── Polling (replaces SSE) ─────────────────────────────────

function startPolling(): void {
  stopPolling();
  pollTimer = window.setInterval(() => {
    if (!isE2eeConfigured() || syncing || paused) return;
    void performSync('poll');
  }, POLL_INTERVAL_MS);
}

function stopPolling(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// ── Retry logic ────────────────────────────────────────────

function cancelPendingLocalSaveRetry(): void {
  if (pendingLocalSaveTimer !== null) {
    clearTimeout(pendingLocalSaveTimer);
    pendingLocalSaveTimer = null;
  }
}

function cancelBackgroundRetry(): void {
  if (backgroundRetryTimer !== null) {
    clearTimeout(backgroundRetryTimer);
    backgroundRetryTimer = null;
  }
}

function scheduleBackgroundRetry(trigger: SyncTrigger): void {
  if (!callbacks || !isE2eeConfigured() || !isBackgroundTrigger(trigger)) return;
  if (backgroundRetryTimer !== null) return;
  backgroundRetryTimer = window.setTimeout(() => {
    backgroundRetryTimer = null;
    void performSync(trigger);
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
  initialRetryTimer = window.setTimeout(() => {
    initialRetryTimer = null;
    performSync('initial').then(summary => {
      if (!summary) scheduleInitialRetry();
    });
  }, delay);
}

// ── Lifecycle ──────────────────────────────────────────────

export function startAutoSyncV2(cb: AutoSyncCallbacks): void {
  callbacks = cb;
  flushPendingSaveFn = cb.flushPendingSave;
  cancelBackgroundRetry();
  if (initialSyncTimer !== null) {
    clearTimeout(initialSyncTimer);
    initialSyncTimer = null;
  }

  if (!hasFileSystem) return;

  // Offline detection
  if (!navigator.onLine) callbacks.onOfflineChange?.(!navigator.onLine);
  const offlineHandler = () => { callbacks?.onOfflineChange?.(true); };
  const onlineHandler = () => {
    callbacks?.onOfflineChange?.(false);
    void performSync('resume');
  };
  window.addEventListener('offline', offlineHandler);
  window.addEventListener('online', onlineHandler);
  cleanupFns.push(() => {
    window.removeEventListener('offline', offlineHandler);
    window.removeEventListener('online', onlineHandler);
  });

  startPolling();

  initialSyncTimer = window.setTimeout(() => {
    initialSyncTimer = null;
    performSync('initial').then(summary => {
      if (!summary) scheduleInitialRetry();
    });
  }, INITIAL_SYNC_DELAY_MS);

  // App resume / visibility
  const handler = () => {
    if (document.visibilityState === 'visible') {
      handleResume();
    }
  };
  document.addEventListener('visibilitychange', handler);
  cleanupFns.push(() => document.removeEventListener('visibilitychange', handler));

  // Window focus
  const focusHandler = () => handleResume();
  window.addEventListener('focus', focusHandler);
  cleanupFns.push(() => window.removeEventListener('focus', focusHandler));
}

export function stopAutoSyncV2(): void {
  stopPolling();
  lastSyncTime = 0;
  pendingLocalSave = false;
  cancelPendingLocalSaveRetry();
  if (initialSyncTimer !== null) {
    clearTimeout(initialSyncTimer);
    initialSyncTimer = null;
  }
  cancelInitialRetry();
  cancelBackgroundRetry();
  for (const fn of cleanupFns) fn();
  cleanupFns = [];
  callbacks = null;
}
