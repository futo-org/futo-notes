import { deleteAllNotes } from '$features/notes/notes.svelte';

export async function resetAllNotes(): Promise<void> {
  await deleteAllNotes();
}
