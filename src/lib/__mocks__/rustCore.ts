import type { V2SyncState } from '../appState';

// Access the same testFS instance used by the platform mock (stored on globalThis)
const g = globalThis as unknown as {
  __futoActiveFS?: {
    listNoteFiles(): Promise<Array<{ name: string; mtime: number }>>;
    readNote(id: string): Promise<string>;
    writeNote(id: string, content: string, modifiedAtMs?: number): Promise<number>;
    deleteNoteFile(id: string): Promise<void>;
  };
};

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const arr = Array.from(new Uint8Array(digest));
  return arr.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function hasRustCore(): boolean {
  return true;
}

export async function prepareSyncPayloadV2(state: V2SyncState): Promise<{
  nextState: V2SyncState;
  inventory: { filename: string; hash: string }[];
  changed: { filename: string; content: string; hash: string }[];
  new: { filename: string; content: string; hash: string }[];
  deleted: string[];
  elapsedMs: number;
}> {
  const fs = g.__futoActiveFS!;
  const files = await fs.listNoteFiles();
  const hashCache: Record<string, { modifiedAt: number; hash: string }> = state.hashCache ? { ...state.hashCache } : {};
  const inventory: { filename: string; hash: string }[] = [];
  const changed: { filename: string; content: string; hash: string }[] = [];
  const newNotes: { filename: string; content: string; hash: string }[] = [];

  for (const file of files) {
    const id = file.name.replace(/\.md$/, '');
    const filename = file.name;
    const cached = hashCache[id];
    let hash: string;
    let content: string | undefined;

    if (cached && cached.modifiedAt === file.mtime) {
      hash = cached.hash;
    } else {
      content = await fs.readNote(id);
      hash = await sha256Hex(content);
      hashCache[id] = { modifiedAt: file.mtime || Date.now(), hash };
    }

    inventory.push({ filename, hash });
    const lastHash = state.fileHashes[filename];
    if (!lastHash) {
      if (content === undefined) content = await fs.readNote(id);
      newNotes.push({ filename, content, hash });
    } else if (hash !== lastHash) {
      if (content === undefined) content = await fs.readNote(id);
      changed.push({ filename, content, hash });
    }
  }

  const currentFilenames = new Set(files.map(f => f.name));
  const deleted = Object.keys(state.fileHashes).filter(f => !currentFilenames.has(f));

  return {
    nextState: { ...state, hashCache },
    inventory,
    changed,
    new: newNotes,
    deleted,
    elapsedMs: 0,
  };
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
