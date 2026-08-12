import { makePreview, noteTags } from '$features/notes/notesIndex';
import type {
  LocalFlushDraftResult,
  LocalNoteBootstrap,
  LocalNoteInventoryItem,
  LocalNoteListingSnapshot,
  LocalNoteMetadata,
  LocalNoteMutation,
  LocalNoteRename,
  LocalNoteSnapshot,
  LocalNoteStore,
  LocalSearchHit,
} from '../localNoteStore';

type HarnessNote = { content: string; modifiedMs: number };

/**
 * Mutable backing for the unshipped web preview and Chromium UI tests.
 * It supports only collision-free happy paths; Rust remains the sole owner of
 * naming, conflict, ordering, relinking, and durable-storage behavior.
 */
class WebLocalNoteStore implements LocalNoteStore {
  private notes = new Map<string, HarnessNote>();
  private folders = new Set<string>();

  async startupListing(): Promise<LocalNoteListingSnapshot> {
    return {
      notes: this.metadata().map(({ id, title, folder, modifiedMs }) => [
        id,
        title,
        folder,
        modifiedMs,
      ]),
      folders: this.folderPaths(),
    };
  }

  async bootstrap(): Promise<LocalNoteBootstrap> {
    return { snapshot: await this.snapshot(), seeded: 0, migrated: 0, warnings: [] };
  }

  async snapshot(): Promise<LocalNoteSnapshot> {
    return { notes: this.metadata(), folders: this.folderPaths() };
  }

  async inventory(): Promise<LocalNoteInventoryItem[]> {
    return this.entries().map(([id, note]) => ({
      name: `${id}.md`,
      mtimeMs: note.modifiedMs,
      sizeBytes: new TextEncoder().encode(note.content).byteLength,
    }));
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
    modifiedMs = Date.now(),
  ): Promise<LocalNoteMutation> {
    if (originalId && !this.notes.has(originalId)) throw new Error('source note does not exist');
    this.refuseCollision(wantedId, originalId);
    if (originalId && originalId !== wantedId) this.notes.delete(originalId);
    this.put(wantedId, { content, modifiedMs });
    const renamed =
      originalId && originalId !== wantedId ? [{ from: originalId, to: wantedId }] : [];
    return this.mutation({
      removed: renamed.map(({ from }) => from),
      renamed,
      finalId: wantedId,
    });
  }

  async flushDraft(id: string, _base: string, content: string): Promise<LocalFlushDraftResult> {
    const note = this.notes.get(id);
    if (note?.content === content) return { disposition: { kind: 'converged' }, mutation: null };
    this.put(id, { content, modifiedMs: Date.now() });
    return {
      disposition: { kind: note ? 'wrote' : 'recreated' },
      mutation: this.mutation({ finalId: id }),
    };
  }

  async move(id: string, wantedId: string): Promise<LocalNoteMutation> {
    const note = this.notes.get(id);
    if (!note) throw new Error('source note does not exist');
    if (id === wantedId) return this.mutation({ finalId: id });
    this.refuseCollision(wantedId, id);
    this.notes.delete(id);
    this.put(wantedId, note);
    return this.mutation({
      removed: [id],
      renamed: [{ from: id, to: wantedId }],
      finalId: wantedId,
    });
  }

  async delete(id: string): Promise<LocalNoteMutation> {
    const removed = this.notes.delete(id) ? [id] : [];
    return this.mutation({ removed });
  }

  async createFolder(path: string): Promise<LocalNoteMutation> {
    this.addFolderAndAncestors(path);
    return this.mutation();
  }

  async renameFolder(from: string, to: string): Promise<LocalNoteMutation> {
    const prefix = `${from}/`;
    const renamed = [...this.notes.keys()]
      .filter((id) => id.startsWith(prefix))
      .map((id) => ({ from: id, to: `${to}/${id.slice(prefix.length)}` }));
    for (const rename of renamed) {
      this.refuseCollision(rename.to, rename.from);
      const note = this.notes.get(rename.from)!;
      this.notes.delete(rename.from);
      this.put(rename.to, note);
    }
    for (const folder of [...this.folders]) {
      if (folder !== from && !folder.startsWith(prefix)) continue;
      this.folders.delete(folder);
      this.folders.add(folder === from ? to : `${to}/${folder.slice(prefix.length)}`);
    }
    this.addFolderAndAncestors(to);
    return this.mutation({
      removed: renamed.map(({ from: id }) => id),
      renamed,
      finalFolder: to,
    });
  }

  async moveFolder(from: string, destinationParent: string): Promise<LocalNoteMutation> {
    if (destinationParent === from || destinationParent.startsWith(`${from}/`)) {
      throw new Error('cannot move a folder into itself or a descendant');
    }
    const leaf = from.slice(from.lastIndexOf('/') + 1);
    return this.renameFolder(from, destinationParent ? `${destinationParent}/${leaf}` : leaf);
  }

  async deleteFolder(path: string): Promise<LocalNoteMutation> {
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const prefix = `${path}/`;
    const renamed: LocalNoteRename[] = [];
    for (const id of [...this.notes.keys()].filter((candidate) => candidate.startsWith(prefix))) {
      const to = parent ? `${parent}/${id.slice(prefix.length)}` : id.slice(prefix.length);
      this.refuseCollision(to, id);
      const note = this.notes.get(id)!;
      this.notes.delete(id);
      this.put(to, note);
      renamed.push({ from: id, to });
    }
    for (const folder of [...this.folders]) {
      if (folder === path || folder.startsWith(prefix)) this.folders.delete(folder);
    }
    return this.mutation({
      removed: renamed.map(({ from }) => from),
      renamed,
    });
  }

  async reset(): Promise<void> {
    this.notes.clear();
    this.folders.clear();
  }

  async search(query: string, limit = 50): Promise<LocalSearchHit[]> {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return [];
    return this.entries()
      .filter(([id, note]) => `${id}\n${note.content}`.toLocaleLowerCase().includes(needle))
      .slice(0, limit)
      .map(([noteId]) => ({ noteId, score: 1, source: 'web-ui-harness' }));
  }

  async waitUntilSearchReady(): Promise<boolean> {
    return true;
  }

  /** Nothing writes this in-memory map from outside, so the current
   * projection is the whole answer. */
  async refreshExternalChanges(): Promise<LocalNoteMutation> {
    return this.mutation();
  }

  async rescan(): Promise<void> {}

  private put(id: string, note: HarnessNote): void {
    this.notes.delete(id);
    this.notes.set(id, note);
    const slash = id.lastIndexOf('/');
    if (slash !== -1) this.addFolderAndAncestors(id.slice(0, slash));
  }

  private entries(): Array<[string, HarnessNote]> {
    return [...this.notes.entries()].reverse();
  }

  private metadata(): LocalNoteMetadata[] {
    return this.entries().map(([id, note]) => {
      const slash = id.lastIndexOf('/');
      const preview = makePreview(note.content);
      return {
        id,
        title: slash === -1 ? id : id.slice(slash + 1),
        folder: slash === -1 ? '' : id.slice(0, slash),
        modifiedMs: note.modifiedMs,
        preview,
        richPreview: preview,
        tags: noteTags(note.content),
      };
    });
  }

  private addFolderAndAncestors(path: string): void {
    const parts = path.split('/').filter(Boolean);
    for (let depth = 1; depth <= parts.length; depth++) {
      this.folders.add(parts.slice(0, depth).join('/'));
    }
  }

  private folderPaths(): string[] {
    return [...this.folders].sort();
  }

  private refuseCollision(wantedId: string, currentId: string | null): void {
    if (wantedId !== currentId && this.notes.has(wantedId)) {
      throw new Error('web UI harness requires collision-free fixtures');
    }
  }

  private mutation(
    input: {
      removed?: string[];
      renamed?: LocalNoteRename[];
      finalId?: string | null;
      finalFolder?: string | null;
    } = {},
  ): LocalNoteMutation {
    return {
      upserted: this.metadata().map((note, position) => ({ note, position })),
      removed: input.removed ?? [],
      renamed: input.renamed ?? [],
      folders: this.folderPaths(),
      finalId: input.finalId ?? null,
      finalFolder: input.finalFolder ?? null,
      warnings: [],
    };
  }
}

export const webLocalNoteStore: LocalNoteStore = new WebLocalNoteStore();
