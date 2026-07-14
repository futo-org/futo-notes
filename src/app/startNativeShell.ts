import { isTauri } from '$lib/platform';
import type { FileChangeEvent } from '$lib/platform';

interface NativeShellOptions {
  createNote: () => void;
  enqueueFileChange: (event: FileChangeEvent) => void;
  flushSave: () => Promise<void>;
  toggleSidebar: () => void;
}

export function startNativeShell(options: NativeShellOptions): () => void {
  if (!isTauri) return () => undefined;

  const cleanups: Array<() => void> = [];
  let disposed = false;

  function registerCleanup(cleanup: () => void): void {
    if (disposed) cleanup();
    else cleanups.push(cleanup);
  }

  void import('$lib/platform/tauri').then(({ onFileChange, onMenuAction }) => {
    [
      onMenuAction((action) => {
        if (action === 'toggle-sidebar') options.toggleSidebar();
        if (action === 'new-note') options.createNote();
      }),
      onFileChange((event) => {
        options.enqueueFileChange(event);
      }),
    ].forEach(registerCleanup);
  });

  void installCloseHandler(options.flushSave).then(registerCleanup);
  return () => {
    if (disposed) return;
    disposed = true;
    cleanups.splice(0).forEach((cleanup) => cleanup());
  };
}

async function installCloseHandler(flushSave: () => Promise<void>): Promise<() => void> {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const appWindow = getCurrentWindow();
  const unsubscribe = await appWindow.onCloseRequested(async (event) => {
    event.preventDefault();
    // Prefer durable editor state without allowing a failed save to trap shutdown.
    await Promise.race([flushSave(), new Promise((resolve) => setTimeout(resolve, 3000))]);
    try {
      const { exit } = await import('@tauri-apps/plugin-process');
      await exit(0);
    } catch {
      appWindow.destroy();
    }
  });

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    unsubscribe();
  };
}
