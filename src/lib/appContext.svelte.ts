/**
 * AppContext — centralized reactive state via Svelte 5 runes.
 *
 * Created in NotesShell, provided via setContext('app', ...).
 * Child components access via getContext<AppContext>('app').
 */

import type { NotePreview } from '../types';

export const APP_CONTEXT_KEY = 'app';

export interface AppContext {
  get activeNoteId(): string | null;
  set activeNoteId(id: string | null);
  get notes(): NotePreview[];
  set notes(n: NotePreview[]);
  get syncActive(): boolean;
  set syncActive(v: boolean);
}

export function createAppContext(): AppContext {
  let activeNoteId = $state<string | null>(null);
  let notes = $state<NotePreview[]>([]);
  let syncActive = $state(false);

  return {
    get activeNoteId() { return activeNoteId; },
    set activeNoteId(id: string | null) { activeNoteId = id; },
    get notes() { return notes; },
    set notes(n: NotePreview[]) { notes = n; },
    get syncActive() { return syncActive; },
    set syncActive(v: boolean) { syncActive = v; },
  };
}
