import { getCurrentWindow } from '@tauri-apps/api/window';

import { isTauri } from '$lib/platform';
import { onFileChange, vaultStatus } from '$lib/platform/tauri';
import type { FileChangeEvent } from '$lib/platform/types';
import { showGlobalToast } from '$shared/notifications/toastBus.svelte';
import { startCloseDirtyReporter } from './closeDeadlineDirty';

export interface NativeShellDeps {
  enqueueFileChange: (event: FileChangeEvent) => void;
  flushSave: () => Promise<void>;
  /** A save is pending or in flight (the session's own signal). */
  isSavePending: () => boolean;
}

const FLUSH_RACE_MS = 3000;
/** The longest a close waits for a write that is still running after the race. */
const FLUSH_CAP_MS = 15_000;
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
            showGlobalToast({ path: 'system.watcherUnavailable' });
          })
          .catch(() => showGlobalToast({ path: 'system.watcherUnavailable' }));
      },
    ),
  );

  // An unreachable vault leaves the note list empty and every action failing, so
  // say what happened and where the way out is. Settings' Storage section keeps
  // working on purpose — see vault_location::VAULT_UNAVAILABLE, whose wording
  // this matches: github#44 showed that a message which does not name the folder
  // sends the user auditing their server instead of looking at their disk.
  void vaultStatus()
    .then((status) => {
      if (!status.available) {
        showGlobalToast({
          path: 'system.notesFolderUnavailable',
          arguments: { folderPath: status.displayPath },
        });
      }
    })
    .catch((error) => console.warn('Failed to read vault status:', error));

  track(startCloseDirtyReporter({ isSavePending: deps.isSavePending }));

  const appWindow = getCurrentWindow();
  void appWindow
    .onCloseRequested(async (event) => {
      event.preventDefault();
      // Drain any pending save before teardown so a fast quit never drops the
      // last keystrokes — but never let a hung or failed save trap shutdown.
      // After 3s the app exits regardless, except that a write still running
      // then is given until FLUSH_CAP_MS: an exit mid-write abandons it, and on a
      // slow disk (a >3 s fsync) that lost the edit and left a `.sf-tmp-*` behind.
      //
      // These timers need this JS thread, which a giant-note open can block for a
      // minute, so Rust backstops the handler: close_deadline.rs exits the app 5s
      // after the first close request (keep it above the 3s race) — but only while
      // the page reports nothing unsaved (closeDeadlineDirty.ts). A page with an
      // edit in it is waited for, here, however long that takes.
      const flushed = deps.flushSave().catch(() => {});
      await Promise.race([flushed, delay(FLUSH_RACE_MS)]);
      if (deps.isSavePending()) await Promise.race([flushed, delay(FLUSH_CAP_MS - FLUSH_RACE_MS)]);
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
