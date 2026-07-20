import { getCurrentWindow } from '@tauri-apps/api/window';

import { isTauri } from '$lib/platform';
import { onFileChange } from '$lib/platform/tauri';
import type { FileChangeEvent } from '$lib/platform/types';

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

  track(onFileChange((event) => deps.enqueueFileChange(event)));

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
