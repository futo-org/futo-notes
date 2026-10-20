import { describe, expect, it, vi } from 'vitest';
import type { LocalNoteMetadata } from '$lib/localNoteStore';
import {
  bootstrapResult,
  fakeStore,
  metadata,
  mutation,
  upsert,
} from './__test__/notesContractFixtures';

// The notes readiness promise is module-scoped, so these suites load a fresh
// module per test for clean initialization.
async function freshModules() {
  vi.resetModules();
  const notes = await import('./notes.svelte');
  const ln = await import('$lib/localNoteStore');
  return { notes, ln };
}

function listingResult(notes: LocalNoteMetadata[] = []) {
  return {
    notes: notes.map(({ id, title, folder, modifiedMs }) => [id, title, folder, modifiedMs]),
    folders: [],
  };
}

// A4: the engine-owned readiness wait is bounded and a rejection cannot poison
// later searches.
describe('the recorded save identity change', () => {
  it('is dropped once the renamed-from id names a note again', async () => {
    const { notes } = await freshModules();
    notes.recordSaveIdentityChange('Draft', 'Draft final');
    expect(notes.getSaveIdentityChange()).toEqual({ from: 'Draft', to: 'Draft final' });

    notes._applyLocalMutation(mutation({ upserted: [upsert('Draft')] }));

    expect(notes.getSaveIdentityChange()).toBeNull();
  });

  it('survives a mutation that touches other notes', async () => {
    const { notes } = await freshModules();
    notes.recordSaveIdentityChange('Draft', 'Draft final');

    notes._applyLocalMutation(mutation({ upserted: [upsert('Unrelated')] }));

    expect(notes.getSaveIdentityChange()).toEqual({ from: 'Draft', to: 'Draft final' });
  });
});

describe('search readiness (A4)', () => {
  it('survives a rejected readiness wait without poisoning search', async () => {
    const { notes, ln } = await freshModules();
    ln._setLocalNoteStoreForTest(
      fakeStore({
        bootstrap: vi.fn(async () => bootstrapResult([metadata('X', 'body')])),
        waitUntilSearchReady: vi.fn(async () => {
          throw new Error('transient wait failure');
        }),
        search: vi.fn(async () => [{ noteId: 'X', score: 1, source: 'keyword' }]),
      }),
    );
    await notes.initNotes();

    const results = await notes.search('q');
    expect(results.map((item) => item.id)).toEqual(['X']);
  });
});

// #33: a failed startup bootstrap must still settle the readiness promise, or
// every awaiter (tab hydration → hash routing) hangs forever.
describe('notes readiness settles on bootstrap failure (#33)', () => {
  it('resolves whenNotesReady as ready after a successful init', async () => {
    const { notes, ln } = await freshModules();
    ln._setLocalNoteStoreForTest(fakeStore({ bootstrap: vi.fn(async () => bootstrapResult()) }));

    await notes.initNotes();

    await expect(notes.whenNotesReady()).resolves.toBe('ready');
  });

  it('rejects initNotes and settles whenNotesReady as failed when bootstrap rejects', async () => {
    const { notes, ln } = await freshModules();
    ln._setLocalNoteStoreForTest(
      fakeStore({
        startupListing: vi.fn(async () => {
          throw new Error('vault scan failed');
        }),
      }),
    );

    await expect(notes.initNotes()).rejects.toThrow('vault scan failed');

    // Before the fix this hung forever (the promise never settled).
    await expect(notes.whenNotesReady()).resolves.toBe('failed');
  });

  it('publishes the ordered listing without waiting for content hydration', async () => {
    const { notes, ln } = await freshModules();
    const hydration = new Promise<never>(() => {});
    ln._setLocalNoteStoreForTest(
      fakeStore({
        startupListing: vi.fn(async () => listingResult([metadata('Fast')])),
        bootstrap: vi.fn(() => hydration),
      }),
    );

    await notes.initNotes();

    expect(notes.getAllNotes().map((note) => note.id)).toEqual(['Fast']);
  });

  it('re-reads hydration rather than overwriting a mutation that landed in flight', async () => {
    const { notes, ln } = await freshModules();
    let resolveHydration!: (result: ReturnType<typeof bootstrapResult>) => void;
    const hydration = new Promise<ReturnType<typeof bootstrapResult>>((resolve) => {
      resolveHydration = resolve;
    });
    const snapshot = vi.fn(async () => ({
      notes: [metadata('New'), metadata('Existing')],
      folders: [],
    }));
    ln._setLocalNoteStoreForTest(
      fakeStore({
        startupListing: vi.fn(async () => listingResult([metadata('Existing')])),
        bootstrap: vi.fn(() => hydration),
        snapshot,
      }),
    );
    await notes.initNotes();
    notes._applyLocalMutation(mutation({ upserted: [upsert('New')] }));

    resolveHydration(bootstrapResult([metadata('Existing')]));
    await expect(notes.whenNotesReady()).resolves.toBe('ready');

    expect(snapshot).toHaveBeenCalledOnce();
    expect(notes.getAllNotes().map((note) => note.id)).toEqual(['New', 'Existing']);
  });

  it('settles readiness as failed when authoritative hydration rejects', async () => {
    const { notes, ln } = await freshModules();
    ln._setLocalNoteStoreForTest(
      fakeStore({
        bootstrap: vi.fn(async () => {
          throw new Error('recovery failed');
        }),
      }),
    );

    await notes.initNotes();

    await expect(notes.whenNotesReady()).resolves.toBe('failed');
  });
});
