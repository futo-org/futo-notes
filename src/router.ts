export function navigate(path: string) {
  window.location.hash = `#${path}`;
}

/**
 * Parse a URL hash fragment into a noteId. Returns `null` for the root,
 * `'new'` for the new-note sentinel, or the decoded id for `#/note/<id>`.
 * Anything else (e.g. settings deep links) also yields `null`.
 */
export function noteIdFromHash(rawHash: string): string | null {
  const trimmed = (rawHash || '').replace(/^#/, '') || '/';
  if (trimmed === '/' || trimmed === '') return null;
  const match = trimmed.match(/^\/note\/(.+)$/);
  if (!match) return null;
  const id = match[1];
  return id === 'new' ? 'new' : decodeURIComponent(id);
}
