import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';

export interface NoteFile {
  name: string;
  mtime: number;
}

export async function listNoteFiles(): Promise<NoteFile[]> {
  const result = await Filesystem.readdir({
    path: '',
    directory: Directory.Documents
  });
  return result.files
    .filter(f => f.name.endsWith('.md'))
    .map(f => ({ name: f.name, mtime: f.mtime || 0 }));
}

export async function readNote(id: string): Promise<string> {
  const result = await Filesystem.readFile({
    path: `${id}.md`,
    directory: Directory.Documents,
    encoding: Encoding.UTF8
  });
  return result.data as string;
}

export async function writeNote(id: string, content: string): Promise<number> {
  await Filesystem.writeFile({
    path: `${id}.md`,
    data: content,
    directory: Directory.Documents,
    encoding: Encoding.UTF8
  });
  return Date.now();
}

export async function deleteNoteFile(id: string): Promise<void> {
  await Filesystem.deleteFile({
    path: `${id}.md`,
    directory: Directory.Documents
  });
}

export async function noteExists(id: string): Promise<boolean> {
  try {
    await Filesystem.stat({
      path: `${id}.md`,
      directory: Directory.Documents
    });
    return true;
  } catch {
    return false;
  }
}

export async function getUniqueNoteId(baseId: string, excludeId?: string): Promise<string> {
  if (baseId === excludeId || !(await noteExists(baseId))) {
    return baseId;
  }

  let counter = 2;
  let candidateId = `${baseId}-${counter}`;
  while (await noteExists(candidateId)) {
    counter++;
    candidateId = `${baseId}-${counter}`;
  }
  return candidateId;
}

export async function renameNote(oldId: string, newId: string, content: string): Promise<number> {
  await deleteNoteFile(oldId);
  return writeNote(newId, content);
}
