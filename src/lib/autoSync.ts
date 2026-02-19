import { isMobile, hasFileSystem } from './platform';
import { getCachedPreferences } from './preferences';
import { syncNow, type SyncSummary } from './sync';

const SAVE_SYNC_DELAY = 5_000;
const POLL_INTERVAL = 60_000;
const RESUME_COOLDOWN = 10_000;

export interface AutoSyncCallbacks {
  onSyncComplete: (summary: SyncSummary) => void;
  onSyncError: (error: Error) => void;
  flushPendingSave: () => Promise<void>;
}

let callbacks: AutoSyncCallbacks | null = null;
let saveDebounceTimer: number | null = null;
let pollTimer: number | null = null;
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
  try {
    await callbacks.flushPendingSave();
    const summary = await syncNow();
    lastSyncTime = Date.now();
    callbacks.onSyncComplete(summary);
  } catch (e) {
    callbacks.onSyncError(e instanceof Error ? e : new Error(String(e)));
  } finally {
    syncing = false;
  }
}

export function notifySaved(): void {
  if (!callbacks || !isSyncConfigured()) return;
  if (saveDebounceTimer !== null) clearTimeout(saveDebounceTimer);
  saveDebounceTimer = window.setTimeout(() => {
    saveDebounceTimer = null;
    performSync();
  }, SAVE_SYNC_DELAY);
}

export async function requestSync(): Promise<void> {
  if (!isSyncConfigured()) throw new Error('Sync not configured');
  if (syncing) throw new Error('Sync already in progress');
  await performSync();
}

function handleResume(): void {
  if (!isSyncConfigured()) return;
  if (Date.now() - lastSyncTime < RESUME_COOLDOWN) return;
  performSync();
}

export function startAutoSync(cb: AutoSyncCallbacks): void {
  callbacks = cb;

  if (!hasFileSystem) return;

  // Periodic polling
  pollTimer = window.setInterval(() => {
    performSync();
  }, POLL_INTERVAL);

  // App resume / visibility
  if (isMobile) {
    import('@capacitor/app').then(({ App }) => {
      const handle = App.addListener('resume', handleResume);
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
  if (saveDebounceTimer !== null) {
    clearTimeout(saveDebounceTimer);
    saveDebounceTimer = null;
  }
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  for (const fn of cleanupFns) fn();
  cleanupFns = [];
  callbacks = null;
}
