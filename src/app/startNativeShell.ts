import { getCurrentWindow } from '@tauri-apps/api/window';

import { isTauri } from '$lib/platform';
import { onFileChange, vaultStatus } from '$lib/platform/tauri';
import type { FileChangeEvent } from '$lib/platform/types';
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
        // There is one toast slot, and an unreachable vault is *why* the watcher
        // could not bind — so the symptom must not overwrite the vault toast below,
        // which names the way out. Decided from the typed vault status, never by
        // matching Rust's error prose. An unreadable status still shows the
        // watcher toast: the watcher really did fail.
        void vaultStatus()
          .then((status) => {
            if (!status.available) return;
            showGlobalToast('External file changes will not be detected until you restart');
          })
          .catch(() =>
            showGlobalToast('External file changes will not be detected until you restart'),
          );
      },
    ),
  );

  // An unreachable vault leaves the note list empty and every action failing, so
  // say what happened and where the way out is. Settings' Storage section keeps
  // working on purpose — see vault_location::VAULT_UNAVAILABLE.
  void vaultStatus()
    .then((status) => {
      if (!status.available) {
        showGlobalToast('Notes folder unavailable — choose a folder in Settings');
      }
    })
    .catch((error) => console.warn('Failed to read vault status:', error));

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
