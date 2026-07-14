import { invoke } from '@tauri-apps/api/core';
import { mkdir } from '@tauri-apps/plugin-fs';

export async function loadNotesDirOverride(): Promise<string | null> {
  return invoke<string | null>('notes_dir_override_load');
}

export async function saveNotesDirOverride(dir: string | null): Promise<void> {
  await invoke('notes_dir_override_save', { dir });
}

export async function getDefaultNotesRoot(): Promise<string> {
  return invoke<string>('resolve_default_notes_root');
}

export async function getNotesRoot(): Promise<string> {
  const override = await loadNotesDirOverride();
  const root = override ?? (await getDefaultNotesRoot());
  await mkdir(root, { recursive: true });
  return root;
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}
