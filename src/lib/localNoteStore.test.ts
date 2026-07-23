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

// The one draft-saving verb (persist-or-park, issue #37): the browser adapter
// honors the same four-outcome flush contract as the Rust engine
// (crates/futo-notes-store flush_draft tests), so desktop save behavior is
// exercisable in vitest/Playwright without a real vault.
describe('BrowserLocalNoteStore flush contract', () => {
  const today = () => new Date().toISOString().slice(0, 10);

  it('writes when the note still holds the base', async () => {
    const store = new BrowserLocalNoteStore();
    await store.save(null, 'note', 'base text');

    const result = await store.flushDraft('note', 'base text', 'draft text');

    expect(result.disposition).toEqual({ kind: 'wrote' });
    expect(result.mutation?.finalId).toBe('note');
    expect(await store.read('note')).toBe('draft text');
  });

  it('reports convergence without rewriting identical bytes', async () => {
    const store = new BrowserLocalNoteStore();
    await store.save(null, 'note', 'same text', 1000);

    const result = await store.flushDraft('note', 'stale base', 'same text');

    expect(result.disposition).toEqual({ kind: 'converged' });
    expect(result.mutation).toBeNull();
    const [note] = (await store.snapshot()).notes;
    expect(note.modifiedMs).toBe(1000);
  });

  it('recreates a peer-deleted note at the original id with a positioned mutation', async () => {
    const store = new BrowserLocalNoteStore();
    await store.save(null, 'other', 'x', 1000);

    const result = await store.flushDraft('Gone', 'old base', 'surviving draft');

    expect(result.disposition).toEqual({ kind: 'recreated' });
    expect(result.mutation?.finalId).toBe('Gone');
    expect(result.mutation?.upserted[0]).toMatchObject({ position: 0 });
    expect(await store.read('Gone')).toBe('surviving draft');
  });

  it('parks instead of recreating beside a case-colliding note', async () => {
    const store = new BrowserLocalNoteStore();
    await store.save(null, 'note', 'surviving peer');

    const result = await store.flushDraft('Note', 'old base', 'my draft');

    expect(result.disposition).toEqual({
      kind: 'parkedConflict',
      parkedId: `Note (conflict ${today()})`,
    });
    expect(await store.read('note')).toBe('surviving peer');
    expect(await store.read(`Note (conflict ${today()})`)).toBe('my draft');
  });

  it('parks a diverged draft as a dated conflict copy, leaving the note untouched', async () => {
    const store = new BrowserLocalNoteStore();
    await store.save(null, 'note', 'peer version');

    const result = await store.flushDraft('note', 'original base', 'my draft');

    const parkedId = `note (conflict ${today()})`;
    expect(result.disposition).toEqual({ kind: 'parkedConflict', parkedId });
    expect(result.mutation?.finalId).toBe(parkedId);
    expect(await store.read('note')).toBe('peer version');
    expect(await store.read(parkedId)).toBe('my draft');
  });

  it('parks an identical draft twice into ONE copy and counters a distinct one', async () => {
    const store = new BrowserLocalNoteStore();
    await store.save(null, 'note', 'peer version');

    const first = await store.flushDraft('note', 'original', 'my draft');
    const again = await store.flushDraft('note', 'original', 'my draft');
    const distinct = await store.flushDraft('note', 'original', 'another draft');

    const parkedId = `note (conflict ${today()})`;
    expect(first.disposition).toEqual({ kind: 'parkedConflict', parkedId });
    expect(again.disposition).toEqual({ kind: 'parkedConflict', parkedId });
    expect(again.mutation).toBeNull();
    expect(distinct.disposition).toEqual({
      kind: 'parkedConflict',
      parkedId: `note (conflict ${today()} 2)`,
    });
    expect((await store.snapshot()).notes).toHaveLength(3);
  });

  it('skips a case-colliding conflict-copy id', async () => {
    const store = new BrowserLocalNoteStore();
    await store.save(null, 'note', 'peer version');
    await store.save(null, `Note (conflict ${today()})`, 'unrelated copy');

    const result = await store.flushDraft('note', 'original', 'my draft');

    expect(result.disposition).toEqual({
      kind: 'parkedConflict',
      parkedId: `note (conflict ${today()} 2)`,
    });
    expect(await store.read(`Note (conflict ${today()})`)).toBe('unrelated copy');
    expect(await store.read(`note (conflict ${today()} 2)`)).toBe('my draft');
  });

  it('does not stack conflict suffixes when parking a conflict copy', async () => {
    const store = new BrowserLocalNoteStore();
    await store.save(null, 'note (conflict 2026-01-01)', 'peer version');

    const result = await store.flushDraft('note (conflict 2026-01-01)', 'original', 'my draft');

    expect(result.disposition).toEqual({
      kind: 'parkedConflict',
      parkedId: `note (conflict ${today()})`,
    });
  });

  it('ignores a similarly-named note in the park idempotency guard', async () => {
    const store = new BrowserLocalNoteStore();
    await store.save(null, 'note', 'peer version');
    await store.save(null, `note (conflict ${today()}) draft`, 'my draft');

    const result = await store.flushDraft('note', 'original', 'my draft');

    expect(result.disposition).toEqual({
      kind: 'parkedConflict',
      parkedId: `note (conflict ${today()})`,
    });
  });

  it('parks inside the note folder', async () => {
    const store = new BrowserLocalNoteStore();
    await store.save(null, 'Projects/note', 'peer version');

    const result = await store.flushDraft('Projects/note', 'original', 'my draft');

    expect(result.disposition).toEqual({
      kind: 'parkedConflict',
      parkedId: `Projects/note (conflict ${today()})`,
    });
  });
});
