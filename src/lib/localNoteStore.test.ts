import { describe, expect, it } from 'vitest';
import { BrowserLocalNoteStore, type LocalNoteMutation } from './localNoteStore';

async function idsInOrder(store: BrowserLocalNoteStore): Promise<string[]> {
  return (await store.snapshot()).notes.map((note) => note.id);
}

function applyAsShell(list: string[], mutation: LocalNoteMutation): string[] {
  const affected = new Set([
    ...mutation.removed,
    ...mutation.upserted.map((entry) => entry.note.id),
  ]);
  const next = list.filter((id) => !affected.has(id));
  for (const entry of mutation.upserted) {
    next.splice(Math.min(entry.position, next.length), 0, entry.note.id);
  }
  return next;
}

describe('BrowserLocalNoteStore mutation contract', () => {
  it('emits snapshots most-recently-modified first with id ascending on ties', async () => {
    const store = new BrowserLocalNoteStore();
    await store.save(null, 'z', '', 5000);
    await store.save(null, 'a', '', 5000);
    await store.save(null, 'old', '', 1000);
    await store.save(null, 'new', '', 9000);
    expect(await idsInOrder(store)).toEqual(['new', 'a', 'z', 'old']);
  });

  it('tie-breaks equal-modified ids in UTF-8 byte order like the Rust engine', async () => {
    const store = new BrowserLocalNoteStore();
    // U+FDFD (UTF-8 EF B7 BD) sorts before U+1F600 (UTF-8 F0 9F 98 80) under
    // the engine's byte-wise `cmp`, but AFTER it under UTF-16 code units
    // (D83D DE00 < FDFD) — the surrogate-range divergence this pins.
    await store.save(null, '\u{1F600}', '', 5000);
    await store.save(null, '\u{FDFD}', '', 5000);
    expect(await idsInOrder(store)).toEqual(['\u{FDFD}', '\u{1F600}']);
  });

  it('reports each upserted note position against the post-mutation snapshot', async () => {
    const store = new BrowserLocalNoteStore();
    await store.save(null, 'a', '1', 1000);
    await store.save(null, 'b', '2', 2000);
    await store.save(null, 'c', '3', 3000);

    const edited = await store.save('a', 'a', '1 edited', 4000);
    expect(edited.upserted[0].position).toBe(0);

    const mid = await store.save(null, 'd', '4', 2500);
    expect(mid.upserted[0].position).toBe(2);
    expect(await idsInOrder(store)).toEqual(['a', 'c', 'd', 'b']);
  });

  it('splice-applying removals then positions reproduces the snapshot order', async () => {
    const store = new BrowserLocalNoteStore();
    await store.save(null, 'Lists/groceries', 'self [[groceries]]', 1000);
    await store.save(null, 'pointer', 'see [[Lists/groceries]]', 2000);
    await store.save(null, 'third', 'unrelated', 3000);

    let before = await idsInOrder(store);
    const renamed = await store.move('Lists/groceries', 'Archive/groceries');
    expect(applyAsShell(before, renamed)).toEqual(await idsInOrder(store));

    before = await idsInOrder(store);
    const folderDeleted = await store.deleteFolder('Archive');
    expect(applyAsShell(before, folderDeleted)).toEqual(await idsInOrder(store));

    before = await idsInOrder(store);
    const deleted = await store.delete('pointer');
    expect(applyAsShell(before, deleted)).toEqual(await idsInOrder(store));
  });

  it('reports collision-resolved ids and post-mutation folders', async () => {
    const store = new BrowserLocalNoteStore();
    const folderCreated = await store.createFolder('Empty/Nested');
    expect(folderCreated.folders).toEqual(['Empty', 'Empty/Nested']);

    const created = await store.save(null, 'Note', 'one');
    expect(created.finalId).toBe('Note');

    const collided = await store.save(null, 'Note', 'two');
    expect(collided.finalId).toBe('Note-2');

    const moved = await store.move('Note-2', 'Renamed');
    expect(moved.finalId).toBe('Renamed');

    expect((await store.delete('Renamed')).finalId).toBeNull();
    await store.save(null, 'F/x', '');
    const folderRenamed = await store.renameFolder('F', 'G');
    expect(folderRenamed.finalId).toBeNull();
    expect(folderRenamed.folders).toEqual(['Empty', 'Empty/Nested', 'G']);
    expect((await store.deleteFolder('G')).folders).toEqual(['Empty', 'Empty/Nested']);
  });
});
