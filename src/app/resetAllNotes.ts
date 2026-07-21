import { deleteAllNotes } from '$features/notes/notes.svelte';

// M4: the destructive reset ordering (pause → drain → disconnect + drop stored
// password → wipe) lives in deleteAllNotes. The shell owns only the reload,
// which clears the module-level singletons deleteAllNotes deliberately does not
// touch (initialized flags, tabs, watcher/notes-root caches) so the next launch
// starts LOCAL from a clean slate.
export async function resetAllNotes(): Promise<void> {
  await deleteAllNotes();
  window.location.reload();
}
