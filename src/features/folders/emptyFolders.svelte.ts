import { getLocalNoteStore } from '$lib/localNoteStore';
import type { NotePreview } from '$shared/types/note';

let emptyFolders = $state<Set<string>>(new Set());

export function getEmptyFolders(): ReadonlySet<string> {
  return emptyFolders;
}

export function setFolderSnapshot(allFolders: string[], notes: NotePreview[]): void {
  const populatedFolders = populatedFolderPaths(notes);
  emptyFolders = new Set(allFolders.filter((path) => !populatedFolders.has(path)));
}

export async function refreshEmptyFolders(notes: NotePreview[]): Promise<void> {
  try {
    const snapshot = await (await getLocalNoteStore()).snapshot();
    setFolderSnapshot(snapshot.folders, notes);
  } catch {
    // A failed directory scan should leave the note-derived tree usable.
  }
}

function populatedFolderPaths(notes: NotePreview[]): Set<string> {
  const populatedFolders = new Set<string>();
  for (const note of notes) {
    const components = note.id.split('/');
    for (let index = 1; index < components.length; index++) {
      populatedFolders.add(components.slice(0, index).join('/'));
    }
  }
  return populatedFolders;
}

export function rebaseEmptyFolders(fromPath: string, toPath: string): void {
  emptyFolders = new Set(
    [...emptyFolders].map((path) => {
      if (path === fromPath) return toPath;
      if (path.startsWith(`${fromPath}/`)) return `${toPath}/${path.slice(fromPath.length + 1)}`;
      return path;
    }),
  );
}

export function removeEmptyFolderTree(path: string): void {
  emptyFolders = new Set(
    [...emptyFolders].filter((item) => item !== path && !item.startsWith(`${path}/`)),
  );
}
