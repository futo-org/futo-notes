import type { NotePreview } from '$shared/types/note';

let emptyFolders = $state<Set<string>>(new Set());

export function getEmptyFolders(): ReadonlySet<string> {
  return emptyFolders;
}

export function setFolderSnapshot(allFolders: string[], notes: NotePreview[]): void {
  const populatedFolders = populatedFolderPaths(notes);
  emptyFolders = new Set(allFolders.filter((path) => !populatedFolders.has(path)));
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
