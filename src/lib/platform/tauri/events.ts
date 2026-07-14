import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import type { FileChangeEvent } from '../types';

let watcherStarted = false;

async function ensureWatcherStarted(): Promise<void> {
  if (watcherStarted) return;
  await invoke('fs_start_watcher');
  watcherStarted = true;
}

function subscribe<T>(eventName: string, callback: (payload: T) => void): () => void {
  let unsubscribe: (() => void) | null = null;
  let disposed = false;

  void listen<T>(eventName, (event) => callback(event.payload)).then((stop) => {
    if (disposed) {
      stop();
    } else {
      unsubscribe = stop;
    }
  });

  return () => {
    if (disposed) return;
    disposed = true;
    unsubscribe?.();
    unsubscribe = null;
  };
}

export function onFileChange(callback: (event: FileChangeEvent) => void): () => void {
  void ensureWatcherStarted();
  return subscribe('fs:change', callback);
}

export function onMenuAction(callback: (action: string) => void): () => void {
  return subscribe('menu:action', callback);
}
