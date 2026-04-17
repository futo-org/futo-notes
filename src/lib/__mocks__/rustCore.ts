// Access the same testFS instance used by the platform mock (stored on globalThis)
const g = globalThis as unknown as {
  __futoActiveFS?: {
    listNoteFiles(): Promise<Array<{ name: string; mtime: number }>>;
    readNote(id: string): Promise<string>;
    writeNote(id: string, content: string, modifiedAtMs?: number): Promise<number>;
    deleteNoteFile(id: string): Promise<void>;
  };
};

export function hasRustCore(): boolean {
  return true;
}

export async function applySyncDeltaV2(
  updates: { filename: string; content: string; hash: string; modified_at: number }[],
  deletes: string[],
  conflicts: { filename: string; content: string }[],
  _timestamps: Record<string, number> = {},
): Promise<{
  updatedFilenames: string[];
  deletedFilenames: string[];
  conflictFilenames: string[];
  elapsedMs: number;
}> {
  const fs = g.__futoActiveFS!;
  const updatedFilenames: string[] = [];
  const deletedFilenames: string[] = [];
  const conflictFilenames: string[] = [];

  for (const update of updates) {
    const id = update.filename.replace(/\.md$/i, '');
    await fs.writeNote(id, update.content, update.modified_at);
    updatedFilenames.push(update.filename);
  }
  for (const filename of deletes) {
    const id = filename.replace(/\.md$/i, '');
    try { await fs.deleteNoteFile(id); } catch { /* may already be gone */ }
    deletedFilenames.push(filename);
  }
  for (const conflict of conflicts) {
    const id = conflict.filename.replace(/\.md$/i, '');
    await fs.writeNote(id, conflict.content);
    conflictFilenames.push(conflict.filename);
  }

  return { updatedFilenames, deletedFilenames, conflictFilenames, elapsedMs: 0 };
}
