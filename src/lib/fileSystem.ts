import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Capacitor } from '@capacitor/core';
// Documents directory — on iOS visible in Files app → On My iPhone → FUTO Notes
// On Android, stored in public Documents/futo-notes folder (scoped storage on Android 11+)
const notesDirectory = Directory.Documents;
const NOTES_SUBFOLDER = 'futo-notes';

export interface NoteFile {
  name: string;
  mtime: number;
}

/** Ensure the subfolder exists, migrate any .md files from the Documents root. */
export async function ensureNotesFolder(): Promise<void> {
  // Create subfolder if it doesn't exist
  try {
    await Filesystem.mkdir({
      path: NOTES_SUBFOLDER,
      directory: notesDirectory,
      recursive: false
    });
  } catch {
    // Already exists — fine
  }

  // Migrate .md files from Documents root into the subfolder
  try {
    const root = await Filesystem.readdir({ path: '', directory: notesDirectory });
    for (const f of root.files) {
      if (f.name.endsWith('.md')) {
        try {
          await Filesystem.rename({
            from: f.name,
            to: `${NOTES_SUBFOLDER}/${f.name}`,
            directory: notesDirectory,
            toDirectory: notesDirectory
          });
        } catch {
          // File with same name already exists in subfolder — skip
        }
      }
    }
  } catch {
    // Root listing failed — nothing to migrate
  }
}

export async function listNoteFiles(): Promise<NoteFile[]> {
  const result = await Filesystem.readdir({
    path: NOTES_SUBFOLDER,
    directory: notesDirectory
  });
  return result.files
    .filter(f => f.name.endsWith('.md'))
    .map(f => ({ name: f.name, mtime: f.mtime || 0 }));
}

export async function readNote(id: string): Promise<string> {
  const result = await Filesystem.readFile({
    path: `${NOTES_SUBFOLDER}/${id}.md`,
    directory: notesDirectory,
    encoding: Encoding.UTF8
  });
  return result.data as string;
}

export async function writeNote(id: string, content: string): Promise<number> {
  await Filesystem.writeFile({
    path: `${NOTES_SUBFOLDER}/${id}.md`,
    data: content,
    directory: notesDirectory,
    encoding: Encoding.UTF8
  });
  return Date.now();
}

export async function deleteNoteFile(id: string): Promise<void> {
  await Filesystem.deleteFile({
    path: `${NOTES_SUBFOLDER}/${id}.md`,
    directory: notesDirectory
  });
}

export async function noteExists(id: string): Promise<boolean> {
  try {
    await Filesystem.stat({
      path: `${NOTES_SUBFOLDER}/${id}.md`,
      directory: notesDirectory
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

// Image file helpers

/** Copy an image from a temp path into futo-notes/{timestamp}-{4char}.{ext}, return just the filename. */
export async function saveImageFile(sourcePath: string): Promise<string> {
  const ext = sourcePath.split('.').pop()?.toLowerCase() || 'jpg';
  const timestamp = Date.now();
  const rand = Math.random().toString(36).slice(2, 6);
  const filename = `${timestamp}-${rand}.${ext}`;

  await Filesystem.copy({
    from: sourcePath,
    to: `${NOTES_SUBFOLDER}/${filename}`,
    toDirectory: notesDirectory
  });

  return filename;
}

/** Resolve a local image filename to a web-displayable URL. */
export async function getImageWebPath(filename: string): Promise<string> {
  const result = await Filesystem.getUri({
    path: `${NOTES_SUBFOLDER}/${filename}`,
    directory: notesDirectory
  });
  return Capacitor.convertFileSrc(result.uri);
}
