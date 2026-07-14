import { isDesktop } from '$lib/platform';

export type UpdaterState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'up-to-date' }
  | { phase: 'available'; version: string; notes?: string; date?: string }
  | { phase: 'downloading'; received: number; total: number | null }
  | { phase: 'installing' }
  | { phase: 'error'; message: string };

export interface PendingUpdate {
  version: string;
  currentVersion: string;
  notes?: string;
  date?: string;
  handle: import('@tauri-apps/plugin-updater').Update;
}

export function updaterSupported(): boolean {
  return isDesktop;
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

export async function relaunchApp(): Promise<void> {
  if (import.meta.env.DEV) {
    const { fakeVersion } = await import('./updater.fake');
    if (fakeVersion()) return;
  }
  const { relaunch } = await import('@tauri-apps/plugin-process');
  await relaunch();
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

  await update.handle.downloadAndInstall((event) => {
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

  const { relaunch } = await import('@tauri-apps/plugin-process');
  await relaunch();
}
