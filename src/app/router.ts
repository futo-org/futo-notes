import { resolveWikilink } from '$shared/note/wikilinks';

// Desktop history model is tabs, not a nav stack (nav.md). The window URL hash
// mirrors the active tab (`#/note/<id>`, `#/note/new`, `#/` for the For You
// home); external navigation (webview back/forward, deep link, tests) flows
// back through the hash into the current tab.

const NOTE_HASH_RE = /^#\/note\/(.+)$/;

/** Parse a location hash into the note id it addresses, or `null` for home. */
export function parseNoteIdFromHash(hash: string): string | null {
  const match = NOTE_HASH_RE.exec(hash);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/** The hash that mirrors a given note id (`null` = For You home). */
export function hashForNoteId(noteId: string | null): string {
  if (noteId === null) return '#/';
  if (noteId === 'new') return '#/note/new';
  return `#/note/${encodeURIComponent(noteId)}`;
}

/** The note id addressed by an internal navigate() path (`/note/x`, `/`). */
export function noteIdFromPath(path: string): string | null {
  if (path === '/' || path === '') return null;
  const withoutLeading = path.startsWith('/') ? path.slice(1) : path;
  const parts = withoutLeading.split('/');
  if (parts[0] !== 'note') return null;
  const rest = parts.slice(1).join('/');
  if (!rest) return null;
  if (rest === 'new') return 'new';
  try {
    return decodeURIComponent(rest);
  } catch {
    return rest;
  }
}

/**
 * Resolve an existing desktop wikilink to its canonical note id. Broken or
 * ambiguous links keep their raw target so the deferred create-on-first-save
 * flow can bind the empty editor to exactly what the user wrote.
 */
export function resolveDesktopWikilinkTarget(target: string, allNoteIds: Iterable<string>): string {
  return resolveWikilink(target, allNoteIds) ?? target;
}
