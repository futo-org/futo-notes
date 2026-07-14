import type { PendingUpdate } from './updater';

const FAKE_FROM_VERSION = '0.1.0';

export function fakeVersion(): string | null {
  if (!import.meta.env.DEV) return null;
  const v = import.meta.env.VITE_FAKE_UPDATE;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function makeFakeUpdate(version: string): PendingUpdate {
  return {
    version,
    currentVersion: FAKE_FROM_VERSION,
    notes: 'Simulated update (dev VITE_FAKE_UPDATE)',
    handle: undefined as unknown as PendingUpdate['handle'],
  };
}

export async function simulateInstall(
  onProgress?: (received: number, total: number | null) => void,
  onDownloadComplete?: () => void,
): Promise<void> {
  const total = 100;
  for (let received = 0; received <= total; received += 20) {
    onProgress?.(received, total);
    await new Promise((r) => setTimeout(r, 200));
  }
  onDownloadComplete?.();
}
