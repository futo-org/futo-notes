import { makePreview, noteTags } from '$features/notes/notesIndex';
import { sanitizeTitle } from './rules';
import { rewriteWikilinks } from '$shared/note/wikilinks';
import { isTauri } from './platform';

export interface LocalNoteMetadata {
  id: string;
  title: string;
  folder: string;
  modifiedMs: number;
  preview: string;
  richPreview: string;
  tags: string[];
}

export interface LocalNoteSnapshot {
  notes: LocalNoteMetadata[];
  folders: string[];
}

export interface LocalNoteRename {
  from: string;
  to: string;
}

export interface LocalNoteMutation {
  upserted: LocalNoteMetadata[];
  removed: string[];
  renamed: LocalNoteRename[];
  warnings: string[];
}

export interface LocalNoteBootstrap {
  snapshot: LocalNoteSnapshot;
  seeded: number;
  migrated: number;
  warnings: string[];
}

export interface LocalNoteInventoryItem {
  name: string;
  mtimeMs: number;
  sizeBytes: number;
}

export interface LocalSearchHit {
  noteId: string;
  score: number;
  source: string;
}

export interface LocalNoteStore {
  bootstrap(): Promise<LocalNoteBootstrap>;
  snapshot(): Promise<LocalNoteSnapshot>;
  inventory(): Promise<LocalNoteInventoryItem[]>;
  read(id: string): Promise<string>;
  exists(id: string): Promise<boolean>;
  save(
    originalId: string | null,
    wantedId: string,
    content: string,
    modifiedMs?: number,
  ): Promise<LocalNoteMutation>;
  move(id: string, wantedId: string): Promise<LocalNoteMutation>;
  delete(id: string): Promise<LocalNoteMutation>;
  createFolder(path: string): Promise<string>;
  renameFolder(from: string, to: string): Promise<LocalNoteMutation>;
  deleteFolder(path: string): Promise<LocalNoteMutation>;
  reset(): Promise<void>;
  search(query: string, limit?: number): Promise<LocalSearchHit[]>;
  searchStatus(): Promise<{ keyword: { ready: boolean } }>;
  rescan(): Promise<void>;
}

type BrowserNote = { content: string; mtime: number };

/** Browser-only development harness. Production note behavior always comes
 * from Rust; this small in-memory port keeps Playwright and plain-browser
 * previews useful without becoming a production fallback. */
class BrowserLocalNoteStore implements LocalNoteStore {
  private notes = new Map<string, BrowserNote>();
  private emptyFolders = new Set<string>();

  async bootstrap(): Promise<LocalNoteBootstrap> {
    return { snapshot: await this.snapshot(), seeded: 0, migrated: 0, warnings: [] };
  }

  async snapshot(): Promise<LocalNoteSnapshot> {
    const notes = [...this.notes].map(([id, note]) => this.metadata(id, note));
    notes.sort((a, b) => b.modifiedMs - a.modifiedMs || a.id.localeCompare(b.id));
    const folders = new Set(this.emptyFolders);
    for (const id of this.notes.keys()) {
      const parts = id.split('/');
      for (let depth = 1; depth < parts.length; depth++) {
        folders.add(parts.slice(0, depth).join('/'));
      }
    }
    return { notes, folders: [...folders].sort() };
  }

  async inventory(): Promise<LocalNoteInventoryItem[]> {
    return [...this.notes]
      .map(([id, note]) => ({
        name: `${id}.md`,
        mtimeMs: note.mtime,
        sizeBytes: new TextEncoder().encode(note.content).byteLength,
      }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
  }

  async read(id: string): Promise<string> {
    return this.notes.get(id)?.content ?? '';
  }

  async exists(id: string): Promise<boolean> {
    return this.notes.has(id);
  }

  async save(
    originalId: string | null,
    wantedId: string,
    content: string,
    modifiedMs?: number,
  ): Promise<LocalNoteMutation> {
    const id = originalId
      ? originalId === wantedId
        ? originalId
        : this.unique(wantedId, originalId)
      : this.unique(this.sanitizeId(wantedId));
    const mtime = modifiedMs ?? Date.now();
    if (originalId && originalId !== id) {
      if (!this.notes.has(originalId)) throw new Error('source note does not exist');
      this.notes.delete(originalId);
    }
    this.notes.set(id, { content, mtime });
    const renamed = originalId && originalId !== id ? [{ from: originalId, to: id }] : [];
    const mutation: LocalNoteMutation = {
      upserted: [this.metadata(id, this.notes.get(id)!)],
      removed: renamed.map((rename) => rename.from),
      renamed,
      warnings: [],
    };
    if (renamed.length > 0) this.relink(renamed, mutation);
    return mutation;
  }

  async move(id: string, wantedId: string): Promise<LocalNoteMutation> {
    const note = this.notes.get(id);
    if (!note) throw new Error('source note does not exist');
    const finalId = this.unique(wantedId, id);
    if (id === finalId) {
      return { upserted: [this.metadata(id, note)], removed: [], renamed: [], warnings: [] };
    }
    this.notes.delete(id);
    this.notes.set(finalId, note);
    const mutation: LocalNoteMutation = {
      upserted: [this.metadata(finalId, note)],
      removed: [id],
      renamed: [{ from: id, to: finalId }],
      warnings: [],
    };
    this.relink(mutation.renamed, mutation);
    return mutation;
  }

  async delete(id: string): Promise<LocalNoteMutation> {
    if (!this.notes.delete(id)) return emptyMutation();
    return { ...emptyMutation(), removed: [id] };
  }

  async createFolder(path: string): Promise<string> {
    if (!path) throw new Error('folder path required');
    this.emptyFolders.add(path);
    return path;
  }

  async renameFolder(from: string, to: string): Promise<LocalNoteMutation> {
    const prefix = `${from}/`;
    const renames = [...this.notes.keys()]
      .filter((id) => id.startsWith(prefix))
      .map((id) => ({ from: id, to: `${to}/${id.slice(prefix.length)}` }));
    for (const rename of renames) {
      const note = this.notes.get(rename.from)!;
      this.notes.delete(rename.from);
      this.notes.set(rename.to, note);
    }
    this.rebaseFolders(from, to);
    const mutation: LocalNoteMutation = {
      upserted: renames.map((rename) => this.metadata(rename.to, this.notes.get(rename.to)!)),
      removed: renames.map((rename) => rename.from),
      renamed: renames,
      warnings: [],
    };
    this.relink(renames, mutation);
    return mutation;
  }

  async deleteFolder(path: string): Promise<LocalNoteMutation> {
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const prefix = `${path}/`;
    const renames: LocalNoteRename[] = [];
    for (const id of [...this.notes.keys()].filter((id) => id.startsWith(prefix))) {
      const tail = id.slice(prefix.length);
      const wanted = parent ? `${parent}/${tail}` : tail;
      const to = this.unique(wanted, id, new Set(renames.map((rename) => rename.to)));
      const note = this.notes.get(id)!;
      this.notes.delete(id);
      this.notes.set(to, note);
      renames.push({ from: id, to });
    }
    for (const folder of [...this.emptyFolders]) {
      if (folder === path || folder.startsWith(prefix)) this.emptyFolders.delete(folder);
    }
    const mutation: LocalNoteMutation = {
      upserted: renames.map((rename) => this.metadata(rename.to, this.notes.get(rename.to)!)),
      removed: renames.map((rename) => rename.from),
      renamed: renames,
      warnings: [],
    };
    this.relink(renames, mutation);
    return mutation;
  }

  async reset(): Promise<void> {
    this.notes.clear();
    this.emptyFolders.clear();
  }

  async search(query: string, limit = 50): Promise<LocalSearchHit[]> {
    const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];
    return [...this.notes]
      .map(([id, note]) => {
        const haystack = `${id}\n${note.content}`.toLocaleLowerCase();
        return { noteId: id, score: words.filter((word) => haystack.includes(word)).length };
      })
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score || a.noteId.localeCompare(b.noteId))
      .slice(0, limit)
      .map((hit) => ({ ...hit, source: 'browser-harness' }));
  }

  async searchStatus() {
    return { keyword: { ready: true } };
  }

  async rescan(): Promise<void> {}

  private metadata(id: string, note: BrowserNote): LocalNoteMetadata {
    const slash = id.lastIndexOf('/');
    return {
      id,
      title: slash < 0 ? id : id.slice(slash + 1),
      folder: slash < 0 ? '' : id.slice(0, slash),
      modifiedMs: note.mtime,
      preview: makePreview(note.content),
      richPreview: makePreview(note.content),
      tags: noteTags(note.content),
    };
  }

  private sanitizeId(id: string): string {
    const parts = id.split('/');
    const title = sanitizeTitle(parts.pop() ?? '');
    const folder = parts.filter(Boolean).map(sanitizeTitle).join('/');
    return folder ? `${folder}/${title}` : title;
  }

  private unique(wanted: string, exclude?: string, reserved = new Set<string>()): string {
    const occupied = [...this.notes.keys(), ...reserved].filter((id) => id !== exclude);
    const keys = new Set(occupied.map(collisionKey));
    if (!keys.has(collisionKey(wanted))) return wanted;
    for (let suffix = 2; ; suffix++) {
      const candidate = `${wanted}-${suffix}`;
      if (!keys.has(collisionKey(candidate))) return candidate;
    }
  }

  private relink(renames: LocalNoteRename[], mutation: LocalNoteMutation): void {
    let ids = [...this.notes.keys()];
    const changed = new Set(mutation.upserted.map((note) => note.id));
    for (const rename of renames) {
      for (const [id, note] of this.notes) {
        if (!note.content.includes('[[')) continue;
        const result = rewriteWikilinks(note.content, rename.from, rename.to, ids);
        if (result.rewrites === 0) continue;
        note.content = result.text;
        note.mtime = Date.now();
        changed.add(id);
      }
      ids = ids.map((id) => (id === rename.from ? rename.to : id));
    }
    mutation.upserted = [...changed]
      .map((id) => this.notes.get(id) && this.metadata(id, this.notes.get(id)!))
      .filter((note): note is LocalNoteMetadata => Boolean(note));
  }

  private rebaseFolders(from: string, to: string): void {
    for (const folder of [...this.emptyFolders]) {
      if (folder !== from && !folder.startsWith(`${from}/`)) continue;
      this.emptyFolders.delete(folder);
      this.emptyFolders.add(folder === from ? to : `${to}/${folder.slice(from.length + 1)}`);
    }
  }
}

function collisionKey(id: string): string {
  return id.normalize('NFC').toLocaleLowerCase();
}

function emptyMutation(): LocalNoteMutation {
  return { upserted: [], removed: [], renamed: [], warnings: [] };
}

let localNotes: LocalNoteStore | null = null;

export async function getLocalNoteStore(): Promise<LocalNoteStore> {
  if (!localNotes) {
    if (isTauri) {
      const { tauriLocalNoteStore } = await import('./platform/localNoteStore');
      localNotes = tauriLocalNoteStore;
    } else {
      localNotes = new BrowserLocalNoteStore();
    }
  }
  return localNotes;
}

export function currentLocalNoteStore(): LocalNoteStore {
  if (!localNotes) throw new Error('Local note store not initialized');
  return localNotes;
}

export function _setLocalNoteStoreForTest(store: LocalNoteStore | null): void {
  localNotes = store;
}
