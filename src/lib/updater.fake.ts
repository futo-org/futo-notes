/**
 * Dev-only fake update backend.
 *
 * When `VITE_FAKE_UPDATE` is set in a dev build (`just tauri-dev
 * --fake-update[=X.Y.Z]`), the helpers in `./updater` delegate here instead of
 * the Tauri plugin: `checkForUpdate` returns a synthetic update, `installUpdate`
 * simulates the download→install progression, and `relaunchApp` is a no-op — so
 * the banner + Settings flow can be iterated with no server and no signed build.
 *
 * `updateChecker` is unaware any of this exists; it drives its real state
 * machine over these stand-in results, so the dev rehearsal exercises the same
 * path that ships. `./updater` imports this module only behind
 * `import.meta.env.DEV`, so the whole chunk is dropped from production bundles.
 */
import type { PendingUpdate } from './updater';

/** Version a fake "from" install reports — the synthetic update is newer. */
const FAKE_FROM_VERSION = '0.1.0';

/** The configured fake version, or null when fake mode is off. */
export function fakeVersion(): string | null {
  if (!import.meta.env.DEV) return null;
  const v = import.meta.env.VITE_FAKE_UPDATE;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Synthetic pending update offered in fake mode (no real plugin handle). */
export function makeFakeUpdate(version: string): PendingUpdate {
  return {
    version,
    currentVersion: FAKE_FROM_VERSION,
    notes: 'Simulated update (dev VITE_FAKE_UPDATE)',
    // No real plugin handle exists in fake mode — installUpdate() simulates
    // instead of touching it. The cast is contained here, in the fake backend.
    handle: undefined as unknown as PendingUpdate['handle'],
  };
}

/**
 * Simulate the download→install progression, driving the same `onProgress` /
 * `onDownloadComplete` callbacks the real `installUpdate` does (so the caller's
 * state machine advances identically). Never relaunches.
 */
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
