import { getNotesRoot as resolveNotesRoot } from '../tauriPaths';

let cachedNotesRoot: string | null = null;

export async function getNotesRoot(): Promise<string> {
  if (!cachedNotesRoot) cachedNotesRoot = await resolveNotesRoot();
  return cachedNotesRoot;
}

export function invalidateNotesRootCache(): void {
  cachedNotesRoot = null;
}
