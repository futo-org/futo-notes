import { getCurrentWindow } from '@tauri-apps/api/window';

import { isTauri } from '$lib/platform';
import { onFileChange, onNoteCommandFailed } from '$lib/platform/tauri';
import type { FileChangeEvent } from '$lib/platform/types';
import {
  loadVaultAvailability,
  recheckVaultAvailability,
} from '$features/storage/vaultAvailability.svelte';
import { showGlobalToast } from '$shared/notifications/toastBus.svelte';

export interface NativeShellDeps {
  enqueueFileChange: (event: FileChangeEvent) => void;
  flushSave: () => Promise<void>;
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
  onNoteCommandFailed(() => {
    void recheckVaultAvailability().catch((error) =>
      console.warn('Failed to re-read vault status:', error),
    );
  });

  const appWindow = getCurrentWindow();
  void appWindow
    .onCloseRequested(async (event) => {
      event.preventDefault();
      // Drain any pending save before teardown so a fast quit never drops the
      // last keystrokes — but never let a hung or failed save trap shutdown:
      // after 3s the app exits regardless.
      await Promise.race([
        deps.flushSave().catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
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
