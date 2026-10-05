import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_NOTE_SORT_ORDER } from '../localNoteStore';
import { webLocalNoteStore } from './webLocalNoteStore';

async function ids(): Promise<string[]> {
  return (await webLocalNoteStore.snapshot()).notes.map((note) => note.id);
}

describe('web harness note order', () => {
  beforeEach(async () => {
    await webLocalNoteStore.reset();
    await webLocalNoteStore.setSortOrder(DEFAULT_NOTE_SORT_ORDER);
    await webLocalNoteStore.save(null, 'banana', '', 3_000);
    await webLocalNoteStore.save(null, 'Cherry', '', 2_000);
    await webLocalNoteStore.save(null, 'Sub/apple', '', 1_000);
    await webLocalNoteStore.save(null, 'Apple', '', 1_000);
  });

  it('defaults to newest first with the id tiebreak, like the engine', async () => {
    expect(await ids()).toEqual(['banana', 'Cherry', 'Apple', 'Sub/apple']);
  });

  it('sorts by title case-insensitively in either direction', async () => {
    await webLocalNoteStore.setSortOrder({ key: 'name', direction: 'ascending' });
    expect(await ids()).toEqual(['Apple', 'Sub/apple', 'banana', 'Cherry']);
    await webLocalNoteStore.setSortOrder({ key: 'name', direction: 'descending' });
    expect(await ids()).toEqual(['Cherry', 'banana', 'Apple', 'Sub/apple']);
  });

  it('reports mutation positions in the active order', async () => {
    await webLocalNoteStore.setSortOrder({ key: 'name', direction: 'ascending' });
    const mutation = await webLocalNoteStore.save(null, 'Az', '', 9_000);
    const inserted = mutation.upserted.find((entry) => entry.note.id === 'Az');
    expect(inserted?.position).toBe(2);
  });

  it('breaks ties by code point like the engine, not by UTF-16 unit', async () => {
    await webLocalNoteStore.reset();
    await webLocalNoteStore.save(null, '\u{1F600}', '', 5_000);
    await webLocalNoteStore.save(null, '\u{FDFD}', '', 5_000);
    expect(await ids()).toEqual(['\u{FDFD}', '\u{1F600}']);
  });

  it('installs the persisted order with the startup listing', async () => {
    const listing = await webLocalNoteStore.startupListing({
      key: 'lastModified',
      direction: 'ascending',
    });
    expect(listing.notes.map(([id]) => id)).toEqual(['Apple', 'Sub/apple', 'Cherry', 'banana']);
  });
});
