/**
 * In-app desktop self-updater.
 *
 * Thin wrapper over `@tauri-apps/plugin-updater` (+ `plugin-process` for the
 * relaunch). The endpoint + minisign pubkey live in `tauri.conf.json`'s
 * `plugins.updater`; signature verification is enforced by the plugin and
 * cannot be bypassed here. Self-update is desktop-only — iOS/Android ship as
 * native apps and update via their store/sideload channels.
 *
 * All Tauri imports are dynamic so this module is import-safe on web/mobile
 * and in unit tests (jsdom), where the plugin native bridge is absent.
 *
 * In dev builds with `VITE_FAKE_UPDATE` set, these helpers delegate to the
 * dev-only `./updater.fake` backend (synthetic update + simulated install) so
 * the UI can be iterated without a server. Each delegation is guarded by
 * `import.meta.env.DEV`, so the fake module is dropped from production bundles.
 */
import { isDesktop } from './platform';

/** State surfaced to the Settings "Updates" UI. */
export type UpdaterState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'up-to-date' }
  | { phase: 'available'; version: string; notes?: string; date?: string }
  | { phase: 'downloading'; received: number; total: number | null }
  | { phase: 'installing' }
  | { phase: 'error'; message: string };

/** A pending update plus the opaque plugin handle used to install it. */
export interface PendingUpdate {
  /** Version offered by the manifest, e.g. "1.6.0". */
  version: string;
  /** Version currently running. */
  currentVersion: string;
  /** Release notes from the manifest, if any. */
  notes?: string;
  /** RFC 3339 publish date from the manifest, if any. */
  date?: string;
  /** Opaque handle from `@tauri-apps/plugin-updater`. */
  handle: import('@tauri-apps/plugin-updater').Update;
}

/** Self-update is desktop-only (the plugin is not registered on mobile/web). */
export function updaterSupported(): boolean {
  return isDesktop;
}

/**
 * Whether the *running install* can actually apply an in-app update. Desktop
 * and, on Linux, AppImage only — deb/rpm installs (which update via the system
 * package repo) return false, as do non-desktop platforms. Defaults to false if
 * the backing command is unavailable (e.g. a debug build with no updater).
 */
export async function selfUpdateSupported(): Promise<boolean> {
  if (!updaterSupported()) return false;
  if (import.meta.env.DEV) {
    // Fake mode runs on an unsupported dev build (cargo-run reports false), so
    // report supported to let the checker's start() gate through.
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

/** Relaunch the app (used to finish an update if the auto-relaunch didn't fire). */
export async function relaunchApp(): Promise<void> {
  if (import.meta.env.DEV) {
    // Don't kill the dev app in fake mode — leave it running so the flow can be
    // replayed (reload the page to reset).
    const { fakeVersion } = await import('./updater.fake');
    if (fakeVersion()) return;
  }
  const { relaunch } = await import('@tauri-apps/plugin-process');
  await relaunch();
}

/**
 * Query the configured endpoint and compare versions.
 *
 * Resolves to the pending update, or `null` when already up to date (or when
 * the updater is unsupported on this platform). Rejects on network / endpoint
 * / config errors so the caller can surface a message.
 */
export async function checkForUpdate(timeoutMs = 30_000): Promise<PendingUpdate | null> {
  if (!updaterSupported()) return null;
  if (import.meta.env.DEV) {
    const { fakeVersion, makeFakeUpdate } = await import('./updater.fake');
    const v = fakeVersion();
    if (v) return makeFakeUpdate(v);
  }
  const { check } = await import('@tauri-apps/plugin-updater');
  // Bound the request: a dead/half-open endpoint (network down, or the release
  // host unreachable) must fail fast, never hang the check forever.
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

/**
 * Download + verify + install `update`, reporting byte progress, then relaunch
 * into the new version. On success the relaunch terminates the process, so this
 * never resolves; it rejects if the download/verify/install step fails.
 */
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
        // Fires when the download finishes (install/verify follows) — lets the
        // caller advance to an "installing" state even when contentLength was
        // unknown (total stays null, so a received>=total check never trips).
        onDownloadComplete?.();
        break;
    }
  });

  const { relaunch } = await import('@tauri-apps/plugin-process');
  await relaunch();
}
