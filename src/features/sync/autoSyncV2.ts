import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { hasFileSystem, isTauri } from '$lib/platform';
import {
  syncE2eeAuto,
  isE2eeConfigured,
  ensureLiveSync,
  stopLiveSync,
  notifyNoteChanged,
  type SyncSummary,
} from './syncServiceE2ee';

export type { SyncSummary } from './syncServiceE2ee';

const POLL_INTERVAL_MS = 15_000;
const LIVE_CONNECTED_POLL_INTERVAL_MS = 120_000;
const INITIAL_SYNC_DELAY_MS = 8_000;
const RESUME_COOLDOWN = 10_000;
const BACKGROUND_SYNC_RETRY_DELAY = 1_000;
const INITIAL_RETRY_DELAYS = [4_000, 8_000, 16_000, 30_000, 30_000];

export interface AutoSyncCallbacks {
  onSyncComplete: (summary: SyncSummary, trigger: SyncTrigger) => void;
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
let autoPaused = false;
let lastSyncTime = 0;
let cleanupFns: Array<() => void> = [];
let initialSyncTimer: number | null = null;
let initialRetryTimer: number | null = null;
let initialRetryCount = 0;
let backgroundRetryTimer: number | null = null;
let pollTimer: number | null = null;
let liveConnected = false;
let liveStateUnlisten: UnlistenFn | null = null;
let pendingLocalSave = false;
let pendingLocalSaveTimer: number | null = null;

export type SyncTrigger = 'local-save' | 'manual' | 'poll' | 'resume' | 'initial';

const reportedSyncErrors = new WeakSet<Error>();

export function wasSyncErrorReported(e: unknown): boolean {
  return e instanceof Error && reportedSyncErrors.has(e);
}

function isBackgroundTrigger(trigger: SyncTrigger): boolean {
  return trigger === 'poll' || trigger === 'resume' || trigger === 'initial';
}

async function performSync(
  trigger: SyncTrigger,
  options: { propagateErrors?: boolean; requireExecution?: boolean } = {},
): Promise<SyncSummary | null> {
  const backgroundTrigger = isBackgroundTrigger(trigger);
  if (!navigator.onLine) {
    callbacks?.onOfflineChange?.(true);
    if (backgroundTrigger) scheduleBackgroundRetry(trigger);
    return null;
  }
  const blockedByAutoPause = autoPaused && backgroundTrigger;
  if (syncing || paused || blockedByAutoPause || !callbacks || !isE2eeConfigured()) {
    if (
      !options.requireExecution &&
      backgroundTrigger &&
      callbacks &&
      isE2eeConfigured() &&
      (syncing || paused || blockedByAutoPause)
    ) {
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
    callbacks.onSyncComplete(summary, trigger);
    if (!autoPaused) void ensureLiveSync();
    return summary;
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    callbacks.onSyncError(error);
    reportedSyncErrors.add(error);
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

export function notifySavedV2(): void {
  if (!callbacks || !isE2eeConfigured()) return;
  if (!autoPaused) void notifyNoteChanged();
}

export function pauseSyncV2(): void {
  paused = true;
}
export function resumeSyncV2(): void {
  paused = false;
}

export async function pauseAutoSyncV2(): Promise<void> {
  autoPaused = true;
  await stopLiveSync();
}
export function resumeAutoSyncV2(): void {
  autoPaused = false;
  void ensureLiveSync();
}

export async function waitForSyncIdleV2(): Promise<void> {
  while (syncing) {
    await new Promise((resolve) => setTimeout(resolve, 50));
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
    throw new Error(
      navigator.onLine ? 'Manual sync did not execute' : 'Offline — reconnect to sync',
    );
  }
  return summary;
}

function handleResume(): void {
  if (!isE2eeConfigured()) return;
  if (Date.now() - lastSyncTime < RESUME_COOLDOWN) return;
  void performSync('resume');
}

function currentPollIntervalMs(): number {
  return liveConnected ? LIVE_CONNECTED_POLL_INTERVAL_MS : POLL_INTERVAL_MS;
}

function setLiveConnected(next: boolean): void {
  if (liveConnected === next) return;
  liveConnected = next;
  if (pollTimer !== null) startPolling();
}

async function startLiveStateListener(): Promise<void> {
  if (!isTauri || liveStateUnlisten) return;
  try {
    liveStateUnlisten = await listen<{ live: boolean; status: string; message?: string }>(
      'sync:live-state',
      (event) => setLiveConnected(Boolean(event.payload.live)),
    );
  } catch (err) {
    console.warn('Live sync state listener failed:', err);
  }
}

function startPolling(): void {
  stopPolling();
  pollTimer = window.setTimeout(() => {
    pollTimer = null;
    if (isE2eeConfigured() && !syncing && !paused && !autoPaused) {
      void performSync('poll');
    }
    if (callbacks) startPolling();
  }, currentPollIntervalMs());
}

function stopPolling(): void {
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

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
    performSync('initial').then((summary) => {
      if (!summary) scheduleInitialRetry();
    });
  }, delay);
}

export function startAutoSyncV2(cb: AutoSyncCallbacks): void {
  callbacks = cb;
  flushPendingSaveFn = cb.flushPendingSave;
  cancelBackgroundRetry();
  if (initialSyncTimer !== null) {
    clearTimeout(initialSyncTimer);
    initialSyncTimer = null;
  }

  if (!hasFileSystem) return;

  if (!navigator.onLine) callbacks.onOfflineChange?.(!navigator.onLine);
  const offlineHandler = () => {
    callbacks?.onOfflineChange?.(true);
  };
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

  void startLiveStateListener();
  startPolling();

  initialSyncTimer = window.setTimeout(() => {
    initialSyncTimer = null;
    performSync('initial').then((summary) => {
      if (!summary) scheduleInitialRetry();
    });
  }, INITIAL_SYNC_DELAY_MS);

  const handler = () => {
    if (document.visibilityState === 'visible') {
      handleResume();
    }
  };
  document.addEventListener('visibilitychange', handler);
  cleanupFns.push(() => document.removeEventListener('visibilitychange', handler));

  const focusHandler = () => handleResume();
  window.addEventListener('focus', focusHandler);
  cleanupFns.push(() => window.removeEventListener('focus', focusHandler));
}

export function stopAutoSyncV2(): void {
  stopPolling();
  liveStateUnlisten?.();
  liveStateUnlisten = null;
  liveConnected = false;
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
