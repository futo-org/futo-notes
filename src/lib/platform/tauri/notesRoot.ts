import { invoke } from '@tauri-apps/api/core';
import { mkdir } from '@tauri-apps/plugin-fs';

export function loadNotesDirOverride(): Promise<string | null> {
  return invoke<string | null>('notes_dir_override_load');
}

export function saveNotesDirOverride(dir: string | null): Promise<void> {
  return invoke<void>('notes_dir_override_save', { dir });
}

export function resolveDefaultNotesRoot(): Promise<string> {
  return invoke<string>('resolve_default_notes_root');
}

export async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function resolveNotesRoot(): Promise<string> {
  const override = await loadNotesDirOverride();
  const root = override ?? (await resolveDefaultNotesRoot());
  await ensureDirectory(root);
  return root;
}
