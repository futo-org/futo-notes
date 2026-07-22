import { invoke } from '@tauri-apps/api/core';
import type {
  LocalFlushDraftResult,
  LocalNoteBootstrap,
  LocalNoteInventoryItem,
  LocalNoteMutation,
  LocalNoteSnapshot,
  LocalNoteStore,
  LocalSearchHit,
} from '../localNoteStore';

class TauriLocalNoteStore implements LocalNoteStore {
  bootstrap() {
    return invoke<LocalNoteBootstrap>('local_notes_bootstrap');
  }

  snapshot() {
    return invoke<LocalNoteSnapshot>('local_notes_snapshot');
  }

  inventory() {
    return invoke<LocalNoteInventoryItem[]>('local_notes_inventory');
  }

  read(id: string) {
    return invoke<string>('local_notes_read', { id });
  }

  exists(id: string) {
    return invoke<boolean>('local_notes_exists', { id });
  }

  save(originalId: string | null, wantedId: string, content: string, modifiedMs?: number) {
    return invoke<LocalNoteMutation>('local_notes_save', {
      originalId,
      wantedId,
      content,
      modifiedMs:
        typeof modifiedMs === 'number' && Number.isFinite(modifiedMs) && modifiedMs >= 0
          ? Math.trunc(modifiedMs)
          : null,
    });
  }

  flushDraft(id: string, base: string, content: string) {
    return invoke<LocalFlushDraftResult>('local_notes_flush_draft', { id, base, content });
  }

  move(id: string, wantedId: string) {
    return invoke<LocalNoteMutation>('local_notes_move', { id, wantedId });
  }

  delete(id: string) {
    return invoke<LocalNoteMutation>('local_notes_delete', { id });
  }

  createFolder(path: string) {
    return invoke<LocalNoteMutation>('local_notes_create_folder', { path });
  }

  renameFolder(from: string, to: string) {
    return invoke<LocalNoteMutation>('local_notes_rename_folder', { from, to });
  }

  deleteFolder(path: string) {
    return invoke<LocalNoteMutation>('local_notes_delete_folder', { path });
  }

  reset() {
    return invoke<void>('local_notes_reset');
  }

  search(query: string, limit?: number) {
    return invoke<LocalSearchHit[]>('local_notes_search', { query, limit });
  }

  waitUntilSearchReady(timeoutMs: number) {
    return invoke<boolean>('local_notes_wait_until_search_ready', { timeoutMs });
  }

  rescan() {
    return invoke<void>('local_notes_rescan');
  }
}

export const tauriLocalNoteStore: LocalNoteStore = new TauriLocalNoteStore();
