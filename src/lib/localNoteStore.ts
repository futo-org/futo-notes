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

export interface LocalNoteUpsert {
  note: LocalNoteMetadata;
  position: number;
}

export interface LocalNoteMutation {
  upserted: LocalNoteUpsert[];
  removed: string[];
  renamed: LocalNoteRename[];
  folders: string[];
  finalId: string | null;
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
  createFolder(path: string): Promise<LocalNoteMutation>;
  renameFolder(from: string, to: string): Promise<LocalNoteMutation>;
  deleteFolder(path: string): Promise<LocalNoteMutation>;
  reset(): Promise<void>;
  search(query: string, limit?: number): Promise<LocalSearchHit[]>;
  /** Bounded, engine-owned keyword readiness wait; shells do not poll. */
  waitUntilSearchReady(timeoutMs: number): Promise<boolean>;
  rescan(): Promise<void>;
}

type BrowserNote = { content: string; mtime: number };

/** Browser twin of Rust note ordering (drift-registered). Code-point id
 * comparison matches Rust UTF-8 ordering where native JS UTF-16 would differ. */
function compareNoteOrder(
  a: { modifiedMs: number; id: string },
  b: { modifiedMs: number; id: string },
): number {
  if (a.modifiedMs !== b.modifiedMs) return b.modifiedMs - a.modifiedMs;
  let i = 0;
  while (i < a.id.length && i < b.id.length) {
    const codePointA = a.id.codePointAt(i)!;
    const codePointB = b.id.codePointAt(i)!;
    if (codePointA !== codePointB) return codePointA - codePointB;
    // Equal code points occupy the same number of UTF-16 units in both ids.
    i += codePointA > 0xffff ? 2 : 1;
  }
  return a.id.length - b.id.length;
}

/** Browser-only adapter for tests and previews; production note behavior
 * remains Rust-owned. */
export class BrowserLocalNoteStore implements LocalNoteStore {
  private notes = new Map<string, BrowserNote>();
  private emptyFolders = new Set<string>();

  async bootstrap(): Promise<LocalNoteBootstrap> {
    return { snapshot: await this.snapshot(), seeded: 0, migrated: 0, warnings: [] };
  }

  async snapshot(): Promise<LocalNoteSnapshot> {
    const notes = [...this.notes].map(([id, note]) => this.metadata(id, note));
    notes.sort(compareNoteOrder);
    return { notes, folders: this.folderPaths() };
  }

  private folderPaths(): string[] {
    const folders = new Set(this.emptyFolders);
    for (const id of this.notes.keys()) {
      const parts = id.split('/');
      for (let depth = 1; depth < parts.length; depth++) {
        folders.add(parts.slice(0, depth).join('/'));
      }
    }
    return [...folders].sort();
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
    const changed = this.relink(renamed);
    changed.add(id);
    return this.finish({
      upsertedIds: changed,
      removed: renamed.map((rename) => rename.from),
      renamed,
      finalId: id,
    });
  }

  async move(id: string, wantedId: string): Promise<LocalNoteMutation> {
    const note = this.notes.get(id);
    if (!note) throw new Error('source note does not exist');
    const finalId = this.unique(wantedId, id);
    if (id === finalId) {
      return this.finish({ upsertedIds: [id], finalId: id });
    }
    this.notes.delete(id);
    this.notes.set(finalId, note);
    const renamed = [{ from: id, to: finalId }];
    const changed = this.relink(renamed);
    changed.add(finalId);
    return this.finish({ upsertedIds: changed, removed: [id], renamed, finalId });
  }

  async delete(id: string): Promise<LocalNoteMutation> {
    const removed = this.notes.delete(id) ? [id] : [];
    return this.finish({ upsertedIds: [], removed });
  }

  async createFolder(path: string): Promise<LocalNoteMutation> {
    if (!path) throw new Error('folder path required');
    const parts = path.split('/');
    for (let depth = 1; depth <= parts.length; depth++) {
      this.emptyFolders.add(parts.slice(0, depth).join('/'));
    }
    return this.finish({ upsertedIds: [] });
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
    const changed = this.relink(renames);
    for (const rename of renames) changed.add(rename.to);
    return this.finish({
      upsertedIds: changed,
      removed: renames.map((rename) => rename.from),
      renamed: renames,
    });
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
    const changed = this.relink(renames);
    for (const rename of renames) changed.add(rename.to);
    return this.finish({
      upsertedIds: changed,
      removed: renames.map((rename) => rename.from),
      renamed: renames,
    });
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

  async waitUntilSearchReady(): Promise<boolean> {
    return true;
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

  /** Rewrite wikilinks affected by `renames`; returns the ids whose content
   * changed. */
  private relink(renames: LocalNoteRename[]): Set<string> {
    let ids = [...this.notes.keys()];
    const changed = new Set<string>();
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
    return changed;
  }

  /** Build the committed mutation: attach each upserted note's position in
   * the post-mutation sorted list and order the entries ascending, mirroring
   * the Rust engine's `place_upserted`. */
  private finish(input: {
    upsertedIds: Iterable<string>;
    removed?: string[];
    renamed?: LocalNoteRename[];
    finalId?: string | null;
  }): LocalNoteMutation {
    const order = [...this.notes]
      .map(([id, note]) => ({ id, modifiedMs: note.mtime }))
      .sort(compareNoteOrder);
    const index = new Map(order.map((entry, position) => [entry.id, position]));
    const upserted = [...new Set(input.upsertedIds)]
      .filter((id) => this.notes.has(id))
      .map((id) => ({
        note: this.metadata(id, this.notes.get(id)!),
        position: index.get(id) ?? order.length,
      }))
      .sort((a, b) => a.position - b.position || (a.note.id < b.note.id ? -1 : 1));
    return {
      upserted,
      removed: input.removed ?? [],
      renamed: input.renamed ?? [],
      folders: this.folderPaths(),
      finalId: input.finalId ?? null,
      warnings: [],
    };
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
