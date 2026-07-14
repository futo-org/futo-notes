import { getLocalNoteStore } from '$lib/localNoteStore';
import {
  _injectTestNote,
  createNote,
  deleteNote,
  getAllNotes,
  moveNote,
} from '$features/notes/notes.svelte';
import { installTestSync } from '$features/sync/testSync';

export async function installDevelopmentHooks(): Promise<void> {
  if (!(import.meta.env.DEV || import.meta.env.VITE_INCLUDE_TEST_HOOKS === 'true')) return;

  const notes = await getLocalNoteStore();
  Object.assign(window, {
    __testNotes: {
      createNote,
      getAllNotes,
      _injectTestNote,
      listNoteFiles: async () =>
        (await notes.inventory()).map((file) => ({
          name: file.name,
          mtime: file.mtimeMs,
          size: file.sizeBytes,
        })),
      readNote: (id: string) => notes.read(id),
      writeNote: async (id: string, content: string, modifiedAtMs?: number) => {
        const mutation = await notes.save(
          (await notes.exists(id)) ? id : null,
          id,
          content,
          modifiedAtMs,
        );
        return mutation.upserted.find((note) => note.id === id)?.modifiedMs ?? Date.now();
      },
      deleteNoteFile: (id: string) => notes.delete(id),
      deleteNote,
      deleteAllContent: () => notes.reset(),
      noteExists: (id: string) => notes.exists(id),
      listFolders: async () => (await notes.snapshot()).folders.map((path) => ({ path })),
      createFolder: (path: string) => notes.createFolder(path),
      renameFolder: (from: string, to: string) => notes.renameFolder(from, to),
      deleteFolder: (path: string) => notes.deleteFolder(path),
      moveNote: (fromId: string, toId: string) => notes.move(fromId, toId),
      moveNoteWithCollisions: moveNote,
    },
  });
  installTestSync();
  Object.assign(window, {
    __testSearch: {
      search: (query: string) => notes.search(query),
      isPopulated: async () => (await notes.searchStatus()).keyword.ready,
    },
  });
}
