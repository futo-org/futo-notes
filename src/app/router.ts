export function navigate(path: string) {
  window.location.hash = `#${path}`;
}

export function noteIdFromHash(rawHash: string): string | null {
  const trimmed = (rawHash || '').replace(/^#/, '') || '/';
  if (trimmed === '/' || trimmed === '') return null;
  const match = trimmed.match(/^\/note\/(.+)$/);
  if (!match) return null;
  const id = match[1];
  return id === 'new' ? 'new' : decodeURIComponent(id);
}
