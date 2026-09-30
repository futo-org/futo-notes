import { invoke } from '@tauri-apps/api/core';

/**
 * Tells the Rust shell whether the open note holds edits that are not on disk.
 * The window-close deadline (close_deadline.rs) reads it: a page with an unsaved
 * edit is waited for, never cut. See src/app/closeDeadlineDirty.ts.
 */
export async function reportUnsavedEdits(dirty: boolean): Promise<void> {
  await invoke<void>('close_deadline_set_dirty', { dirty });
}
