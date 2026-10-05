import { getCurrentWindow } from '@tauri-apps/api/window';

import { isTauri } from '$lib/platform';
import {
  flushAppConfigWrites,
  onFileChange,
  onVaultCommandFailed,
  sweepStaleTemps,
} from '$lib/platform/tauri';
import type { FileChangeEvent } from '$lib/platform/types';
import {
  loadVaultAvailability,
  recheckVaultAvailability,
} from '$features/storage/vaultAvailability.svelte';
import {
  flushPendingSaveBeforeExit,
  registerExitFlushSource,
  registerExitTask,
} from '$shared/lifecycle/flushBeforeExit';
import { flushAppStateWrites } from '$shared/state/appState';
import { showGlobalToast } from '$shared/notifications/toastBus.svelte';
import { startCloseDirtyReporter } from './closeDeadlineDirty';

export interface NativeShellDeps {
  enqueueFileChange: (event: FileChangeEvent) => void;
  flushSave: () => Promise<void>;
  /** A save is pending or in flight (the session's own signal). */
  isSavePending: () => boolean;
}

// Wires the Tauri window/file-watcher glue on desktop. Registration of the
// close handler is async (it resolves an unlisten fn), so every disposer is
// funnelled through `track`: one that resolves after teardown is disposed
// immediately rather than leaking a listener past the shell's lifetime.
export function startNativeShell(deps: NativeShellDeps): () => void {
  if (!isTauri) return () => {};

  let disposed = false;
  const disposers: Array<() => void> = [];
  const track = (cleanup: () => void): void => {
    if (disposed) cleanup();
    else disposers.push(cleanup);
  };

  track(
    onFileChange(
      (event) => deps.enqueueFileChange(event),
      () => {
        // An unusable vault is *why* the watcher could not bind, and its banner
        // already names the way out, so the symptom stays quiet. Decided from
        // the typed vault status, never by matching Rust's error prose. An
        // unreadable status still shows the toast: the watcher really did fail.
        void loadVaultAvailability()
          .then((status) => {
            if (!status.available) return;
            showGlobalToast({ path: 'system.watcherUnavailable' });
          })
          .catch(() => showGlobalToast({ path: 'system.watcherUnavailable' }));
      },
    ),
  );

  // Feeds VaultUnavailableBanner and the edit lock.
  void loadVaultAvailability().catch((error) =>
    console.warn('Failed to read vault status:', error),
  );
  onVaultCommandFailed(() => {
    void recheckVaultAvailability().catch((error) =>
      console.warn('Failed to re-read vault status:', error),
    );
  });

  track(startCloseDirtyReporter({ isSavePending: deps.isSavePending }));
  track(registerExitFlushSource({ flushSave: deps.flushSave, isSavePending: deps.isSavePending }));
  track(registerExitTask(flushAppConfigWrites));
  track(registerExitTask(flushAppStateWrites));
  // An exit that beat an older build's TS atomic rewrite left its temp file
  // behind; clear the stale ones (ours by name, and old) now.
  void sweepStaleTemps();

  const appWindow = getCurrentWindow();
  void appWindow
    .onCloseRequested(async (event) => {
      event.preventDefault();
      // Drain any pending save before teardown so a fast quit never drops the
      // last keystrokes (flushBeforeExit.ts: bounded, so a hung or failed save
      // cannot trap shutdown). That drain needs this JS thread, which a giant-note
      // open can block for a minute, so Rust backstops the handler: close_deadline.rs
      // exits the app 5s after the first close request (keep it above the 3s race in
      // flushBeforeExit.ts), but only while the page reports nothing unsaved
      // (closeDeadlineDirty.ts). A page with an edit in it is waited for, here.
      await flushPendingSaveBeforeExit();
      try {
        const { exit } = await import('@tauri-apps/plugin-process');
        await exit(0);
      } catch {
        void appWindow.destroy();
      }
    })
    .then(track);

  return () => {
    disposed = true;
    for (const dispose of disposers) dispose();
    disposers.length = 0;
  };
}
