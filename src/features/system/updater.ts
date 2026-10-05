import { isTauri } from '$lib/platform';
import { flushPendingSaveBeforeExit } from '$shared/lifecycle/flushBeforeExit';

export interface PendingUpdate {
  version: string;
  currentVersion: string;
  notes?: string;
  date?: string;
  handle: import('@tauri-apps/plugin-updater').Update;
}

export function updaterSupported(): boolean {
  return isTauri;
}

export async function selfUpdateSupported(): Promise<boolean> {
  if (!updaterSupported()) return false;
  if (import.meta.env.DEV) {
    const { fakeVersion } = await import('./updater.fake');
    if (fakeVersion()) return true;
  }
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<boolean>('app_self_update_supported');
  } catch {
    return false;
  }
}

/** Every relaunch drains the open note's pending save first: `relaunch` ends the process without a CloseRequested. */
async function relaunchAfterFlush(): Promise<void> {
  await flushPendingSaveBeforeExit();
  const { relaunch } = await import('@tauri-apps/plugin-process');
  await relaunch();
}

export async function relaunchApp(): Promise<void> {
  if (import.meta.env.DEV) {
    const { fakeVersion } = await import('./updater.fake');
    if (fakeVersion()) return;
  }
  await relaunchAfterFlush();
}

export async function checkForUpdate(timeoutMs = 30_000): Promise<PendingUpdate | null> {
  if (!updaterSupported()) return null;
  if (import.meta.env.DEV) {
    const { fakeVersion, makeFakeUpdate } = await import('./updater.fake');
    const v = fakeVersion();
    if (v) return makeFakeUpdate(v);
  }
  const { check } = await import('@tauri-apps/plugin-updater');
  const update = await check({ timeout: timeoutMs });
  if (!update) return null;
  return {
    version: update.version,
    currentVersion: update.currentVersion,
    notes: update.body || undefined,
    date: update.date || undefined,
    handle: update,
  };
}

export async function installUpdate(
  update: PendingUpdate,
  onProgress?: (received: number, total: number | null) => void,
  onDownloadComplete?: () => void,
): Promise<void> {
  if (import.meta.env.DEV) {
    const { fakeVersion, simulateInstall } = await import('./updater.fake');
    if (fakeVersion()) return simulateInstall(onProgress, onDownloadComplete);
  }

  let received = 0;
  let total: number | null = null;

  // download, flush, install: on Windows the installer ends the process as it starts,
  // so the flush has to land between the two, not after `downloadAndInstall` returns.
  await update.handle.download((event) => {
    switch (event.event) {
      case 'Started':
        total = event.data.contentLength ?? null;
        received = 0;
        onProgress?.(received, total);
        break;
      case 'Progress':
        received += event.data.chunkLength;
        onProgress?.(received, total);
        break;
      case 'Finished':
        onProgress?.(total ?? received, total);
        onDownloadComplete?.();
        break;
    }
  });

  await flushPendingSaveBeforeExit();
  await update.handle.install();
  await relaunchAfterFlush();
}
