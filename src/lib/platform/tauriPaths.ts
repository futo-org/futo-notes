/**
 * Notes root resolution for Tauri.
 *
 * Resolution chain:
 * 1. Check notes-dir-override.json in Tauri app data dir
 * 2. Fall back to documentDir() + '/stonefruit' (or appDataDir() + '/stonefruit' if documentDir unavailable)
 *
 * The override file lives in the Tauri **app data dir** (NOT notes root).
 * Format: { "notesDir": "/path/to/notes" }
 */

import { invoke } from '@tauri-apps/api/core';
import { documentDir, appDataDir, join } from '@tauri-apps/api/path';

const DEFAULT_SUBFOLDER = 'stonefruit';

export async function loadNotesDirOverride(): Promise<string | null> {
  return invoke<string | null>('notes_dir_override_load');
}

/** Pass null to reset to default. */
export async function saveNotesDirOverride(dir: string | null): Promise<void> {
  await invoke('notes_dir_override_save', { dir });
}

export async function getDefaultNotesRoot(): Promise<string> {
  let base: string;
  try {
    base = await documentDir();
  } catch {
    base = await appDataDir();
  }
  return join(base, DEFAULT_SUBFOLDER);
}

export async function getNotesRoot(): Promise<string> {
  const override = await loadNotesDirOverride();
  const root = override ?? (await getDefaultNotesRoot());
  await invoke('fs_ensure_dir', { path: root });
  return root;
}

export async function ensureDir(path: string): Promise<void> {
  await invoke('fs_ensure_dir', { path });
}
