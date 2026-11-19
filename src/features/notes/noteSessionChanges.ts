import { idParent } from '$lib/platform/pathSafety';
import { collisionKey, FALLBACK_TITLE, sanitizeFilename } from '$lib/rules';
import type { NotePreview } from '$shared/types/note';

export function normalizeTitleForPersistence(title: string): string {
  return title.trim() || FALLBACK_TITLE;
}

/** Whether `title` holds an edit `savedTitle` lacks; whitespace a save trims is not one. */
export function titleHasUnsavedEdit(title: string, savedTitle: string): boolean {
  return normalizeTitleForPersistence(title) !== normalizeTitleForPersistence(savedTitle);
}

export function editorHasUnseenChanges(params: {
  editorContent: string | undefined;
  savedContent: string;
  title: string;
  savedTitle: string;
}): boolean {
  if (params.editorContent === undefined) return false;
  return (
    params.editorContent !== params.savedContent ||
    titleHasUnsavedEdit(params.title, params.savedTitle)
  );
}

/* Ids compared as the file system and the store's `collision_key` do: a case
 * or Unicode-normalization variant names the same file on macOS and Windows. */
const fileKey = collisionKey;

export function hasDuplicateNoteTitle(
  checkTitle: string,
  notes: NotePreview[],
  originalId: string | null,
  pendingFolder: string | null,
): boolean {
  const leaf = sanitizeFilename(normalizeTitleForPersistence(checkTitle));
  const parentFolder = originalId ? idParent(originalId) : (pendingFolder ?? '');
  const checkId = parentFolder ? `${parentFolder}/${leaf}` : leaf;
  const checkKey = fileKey(checkId);
  return notes.some((note) => fileKey(note.id) === checkKey && note.id !== originalId);
}
