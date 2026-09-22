import { FALLBACK_TITLE } from '$lib/rules';

export function shouldWriteNoteToDisk(params: {
  savedTitle: string;
  newTitle: string;
  content: string;
  newContent: string;
}): boolean {
  return !(params.newTitle === params.savedTitle && params.newContent === params.content);
}

export function normalizeTitleForPersistence(title: string): string {
  return title.trim() || FALLBACK_TITLE;
}

/**
 * Whether the editor is answering for a note it does not hold (CRITICAL).
 *
 * An editor whose parse threw, or which was destroyed and re-created under a
 * live session, holds an EMPTY document for a note that has content — and its
 * `''` is indistinguishable from "the user selected everything and deleted it"
 * to anything that only compares strings. The discriminator is the session's
 * own live buffer: a real clear reaches the session as a change notification
 * first, so `content` has already moved off `savedContent` by the time a save
 * reads the editor. An editor that went blank on its own never notified anyone.
 *
 * 2026-09-03: three notes were overwritten with 0 bytes in a live vault this
 * way (two under a hot-module reload, one after a parse threw). The editor's
 * own half of the fix is in MilkdownEditor — it must not report a document it
 * failed to load — and this is the save pipeline's, so no future editor that
 * goes blank can reach the disk through it. → docs/spec/editor.md
 *
 * The cost is deliberate and one-sided: a select-all-delete flushed inside the
 * editor's change debounce is dropped rather than written. Losing a deletion
 * is one keystroke to redo; losing the note is not.
 */
export function editorLostTheNote(params: {
  editorContent: string | undefined;
  savedContent: string;
  content: string;
}): boolean {
  if (params.editorContent !== '') return false;
  if (params.savedContent === '') return false;
  return params.content === params.savedContent;
}

export function editorHasUnseenChanges(params: {
  editorContent: string | undefined;
  savedContent: string;
  content: string;
  title: string;
  savedTitle: string;
}): boolean {
  if (params.editorContent === undefined) return false;
  const titleChanged =
    normalizeTitleForPersistence(params.title) !== normalizeTitleForPersistence(params.savedTitle);
  // A blank editor's body is not a change; a rename typed alongside it still is.
  if (editorLostTheNote(params)) return titleChanged;
  return params.editorContent !== params.savedContent || titleChanged;
}

export function isEditorChangeEcho(params: {
  nextContent: string | undefined;
  content: string;
  savedContent: string;
}): boolean {
  if (params.nextContent === undefined) return false;
  return params.nextContent === params.content && params.nextContent === params.savedContent;
}
