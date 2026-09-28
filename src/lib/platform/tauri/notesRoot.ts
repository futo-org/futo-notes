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

export interface VaultStatus {
  /** The same location in terms a user recognises. */
  displayPath: string;
  isCustom: boolean;
  /** False once the folder has gone (an unmounted drive, a revoked sandbox grant) or refused a write. */
  available: boolean;
  /** The folder is there but refused a write: Controlled Folder Access, a read-only mount. */
  accessRefused: boolean;
  /** True when the OS trash cannot accept deletions from this vault. */
  deletesArePermanent: boolean;
  /**
   * True when a deleted folder's emptied shell bypasses the trash — the Trash
   * portal declines directories, so this holds in every Flatpak even where notes
   * trash fine.
   */
  folderDeletesArePermanent: boolean;
}

/** Never rejects for an unreachable vault — that state is what it reports. */
export function vaultStatus(): Promise<VaultStatus> {
  return invoke<VaultStatus>('vault_status');
}

/**
 * Names a directory the way the user recognises it — a folder picked inside a
 * Flatpak arrives as `/run/user/<uid>/doc/<id>/<name>`, which resolves back to the
 * folder they actually chose. Read-only, so it is safe to call before the user has
 * confirmed anything; anything else is returned unchanged.
 */
export function vaultDisplayPath(dir: string): Promise<string> {
  return invoke<string>('vault_display_path', { dir });
}

export async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

// Creates nothing: Rust `vault_location` is the only owner of that rule — it
// creates the default root at startup, and a root that cannot be created is
// reported through `vaultStatus`, not thrown from here (crash 1739).
export async function resolveNotesRoot(): Promise<string> {
  return (await loadNotesDirOverride()) ?? resolveDefaultNotesRoot();
}
