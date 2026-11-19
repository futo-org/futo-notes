// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/platform', () => ({ hasFileSystem: true }));
vi.mock('./notes.svelte', () => ({
  noteExists: vi.fn(async () => true),
  createNote: vi.fn(async (id: string) => ({ id, mtime: 0 })),
  deleteNote: vi.fn(async () => {}),
  getNoteById: vi.fn(() => undefined),
}));

import { createNoteLoader } from './createNoteLoader';
import { createNote, deleteNote, noteExists } from './notes.svelte';

/** A promise whose settlement the test controls. */
function gate() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Note A open; the editor holds what it last opened, and `openNote` is the test's: it
 *  may name the note the host holds (a stale row's "plan" opens "Plan"). */
function makeHarness(openNote: (id: string | null) => Promise<string | void>) {
  let heldId: string | null = 'A';
  const patchState = vi.fn();
  const flushSave = vi.fn(async () => {});
  const loader = createNoteLoader({
    autoResizeTitle: vi.fn(),
    clearTitleWarning: vi.fn(),
    flushSave,
    focusEditor: vi.fn(),
    getEditorNoteId: () => heldId,
    getNoteBody: () => undefined,
    getPendingFolder: () => null,
    onNoteRenamed: vi.fn(),
    patchState,
    resetState: vi.fn(),
    openNote: vi.fn(async (id: string | null) => {
      heldId = (await openNote(id)) || id;
    }),
  });
  /** Every patch that moved the session to another note. */
  const identityPatches = () =>
    patchState.mock.calls.filter(([patch]) => 'originalId' in patch).map(([patch]) => patch);
  return { loader, flushSave, identityPatches };
}

describe('a note switch', () => {
  beforeEach(() => {
    vi.mocked(noteExists).mockClear();
    vi.mocked(createNote).mockClear();
    vi.mocked(deleteNote).mockClear();
  });

  it('describes the incoming note only once the editor holds it', async () => {
    const opening = gate();
    const h = makeHarness(() => opening.promise);

    const loading = h.loader.load('B');
    await vi.waitFor(() => expect(noteExists).toHaveBeenCalledWith('B'));
    await Promise.resolve();
    expect(h.identityPatches()).toEqual([]);

    opening.resolve();
    await loading;
    expect(h.identityPatches()).toEqual([expect.objectContaining({ originalId: 'B', title: 'B' })]);
  });

  it('fails the load and leaves the session alone when the editor cannot open the note', async () => {
    const h = makeHarness(async () => {
      throw new Error('editor host closed');
    });

    await expect(h.loader.load('B')).rejects.toThrow('editor host closed');
    expect(h.identityPatches()).toEqual([]);
  });

  it('opens nothing when the outgoing save fails', async () => {
    const openNote = vi.fn(async () => {});
    const h = makeHarness(openNote);
    h.flushSave.mockRejectedValueOnce(new Error('disk full'));

    await expect(h.loader.load('B')).rejects.toThrow('disk full');
    expect(openNote).not.toHaveBeenCalled();
    expect(h.identityPatches()).toEqual([]);
  });

  it('refuses a note it cannot classify, never creating it', async () => {
    vi.mocked(noteExists).mockRejectedValueOnce(new Error('read failed'));
    const openNote = vi.fn(async () => {});
    const h = makeHarness(openNote);

    await expect(h.loader.load('B')).rejects.toThrow('read failed');
    expect(createNote).not.toHaveBeenCalled();
    expect(openNote).not.toHaveBeenCalled();
  });

  it('creates a missing note before the editor attaches it', async () => {
    vi.mocked(noteExists).mockResolvedValueOnce(false);
    const openNote = vi.fn(async () => {});
    const h = makeHarness(openNote);

    await h.loader.load('Missing');
    expect(createNote).toHaveBeenCalledExactlyOnceWith('Missing', '');
    expect(openNote).toHaveBeenCalledWith('Missing');
    expect(h.identityPatches()).toEqual([
      expect.objectContaining({ originalId: 'Missing', createdNoteId: 'Missing' }),
    ]);
  });

  it('records the note the host opened, as the host names it', async () => {
    const h = makeHarness(async () => 'Plan');
    await h.loader.load('plan');
    expect(h.identityPatches()).toEqual([
      expect.objectContaining({ originalId: 'Plan', title: 'Plan' }),
    ]);
  });

  it('deletes the note it created when a newer load overtook the editor opening it', async () => {
    vi.mocked(noteExists).mockResolvedValueOnce(false);
    const opening = gate();
    const h = makeHarness((id) => (id === 'Missing' ? opening.promise : Promise.resolve()));

    const overtaken = h.loader.load('Missing');
    await vi.waitFor(() => expect(createNote).toHaveBeenCalledOnce());
    await Promise.resolve();
    const newer = h.loader.load('B');
    opening.resolve();
    await Promise.all([overtaken, newer]);

    expect(deleteNote).toHaveBeenCalledExactlyOnceWith('Missing');
    expect(h.identityPatches()).toEqual([expect.objectContaining({ originalId: 'B' })]);
  });

  it('leaves the session alone when the editor cannot let go of the outgoing note for home', async () => {
    const h = makeHarness(async () => {
      throw new Error('disk full');
    });

    await expect(h.loader.load(null)).rejects.toThrow('disk full');
    expect(h.identityPatches()).toEqual([]);
  });
});
