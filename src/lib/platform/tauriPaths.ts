/**
 * Notes root resolution for Tauri.
 *
 * Resolution chain (matches Rust notes_root / default_notes_root exactly):
 * 1. Check notes-dir-override.json in Tauri app data dir
 * 2. Fall back to STONEFRUIT_DATA_DIR/notes if the env var is set (dev/test)
 * 3. Fall back to documentDir()/stonefruit (or appDataDir()/stonefruit)
 *
 * The env-var branch is resolved by a Rust command — the webview cannot read
 * process env directly, and without this path, cross-platform tests and
 * per-worktree dev runs would read/write the user's real vault.
 */

import { invoke } from '@tauri-apps/api/core';

export async function loadNotesDirOverride(): Promise<string | null> {
  return invoke<string | null>('notes_dir_override_load');
}

/** Pass null to reset to default. */
export async function saveNotesDirOverride(dir: string | null): Promise<void> {
  await invoke('notes_dir_override_save', { dir });
}

export async function getDefaultNotesRoot(): Promise<string> {
  return invoke<string>('resolve_default_notes_root');
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
