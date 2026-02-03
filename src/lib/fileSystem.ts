import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';

const NOTES_DIR = 'notes';

export async function ensureNotesDir(): Promise<void> {
  try {
    await Filesystem.mkdir({
      path: NOTES_DIR,
      directory: Directory.Documents,
      recursive: true
    });
  } catch { /* already exists */ }
}

export async function listNoteFiles(): Promise<Array<{ name: string; mtime: number }>> {
  const result = await Filesystem.readdir({
    path: NOTES_DIR,
    directory: Directory.Documents
  });
  return result.files
    .filter(f => f.name.endsWith('.md'))
    .map(f => ({ name: f.name, mtime: f.mtime || 0 }));
}

export async function readNote(id: string): Promise<string> {
  const result = await Filesystem.readFile({
    path: `${NOTES_DIR}/${id}.md`,
    directory: Directory.Documents,
    encoding: Encoding.UTF8
  });
  return result.data as string;
}

export async function writeNote(id: string, content: string): Promise<number> {
  await Filesystem.writeFile({
    path: `${NOTES_DIR}/${id}.md`,
    data: content,
    directory: Directory.Documents,
    encoding: Encoding.UTF8
  });
  return Date.now();
}

export async function deleteNoteFile(id: string): Promise<void> {
  await Filesystem.deleteFile({
    path: `${NOTES_DIR}/${id}.md`,
    directory: Directory.Documents
  });
}

export async function renameNote(oldId: string, newId: string, content: string): Promise<number> {
  await deleteNoteFile(oldId);
  return writeNote(newId, content);
}
