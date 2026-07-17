import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';

import type { FileChangeEvent, PlatformFS } from '../types';

import { createTauriImages } from './images';
import { resolveNotesRoot } from './notesRoot';
import { createTauriStorage } from './storage';

function subscribe<T>(eventName: string, callback: (payload: T) => void): () => void {
  let unlisten: (() => void) | null = null;
  let disposed = false;

  void listen<T>(eventName, (event) => callback(event.payload))
    .then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    })
    .catch((error) => console.warn(`Failed to listen for ${eventName}:`, error));

  return () => {
    if (disposed) return;
    disposed = true;
    unlisten?.();
    unlisten = null;
  };
}

export function createTauriAdapter() {
  let notesRoot: Promise<string> | null = null;
  let watcherStart: Promise<void> | null = null;

  function getNotesRoot(): Promise<string> {
    if (!notesRoot) {
      notesRoot = resolveNotesRoot().catch((error) => {
        notesRoot = null;
        throw error;
      });
    }
    return notesRoot;
  }

  function invalidateNotesRoot(): void {
    notesRoot = null;
  }

  function startWatcher(): Promise<void> {
    if (!watcherStart) {
      watcherStart = invoke<void>('fs_start_watcher').catch((error) => {
        watcherStart = null;
        throw error;
      });
    }
    return watcherStart;
  }

  const storage = createTauriStorage({ getNotesRoot });
  const images = createTauriImages({ getNotesRoot });

  const fs: PlatformFS = {
    ...storage,
    ...images,

    getAppVersion: getVersion,
    writeClipboardText: writeText,
  };

  function onFileChange(callback: (event: FileChangeEvent) => void): () => void {
    void startWatcher().catch((error) => console.warn('Failed to start file watcher:', error));
    return subscribe('fs:change', callback);
  }

  return { fs, invalidateNotesRoot, onFileChange };
}
