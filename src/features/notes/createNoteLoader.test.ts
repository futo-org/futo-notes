// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/platform', () => ({ hasFileSystem: true }));
vi.mock('./notes.svelte', () => ({
  readNote: vi.fn(async () => ''),
  getNoteById: vi.fn(() => undefined),
}));

import { createNoteLoader } from './createNoteLoader';
import { readNote } from './notes.svelte';

/** A promise whose settlement the test controls. */
function gate<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flushMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * A session with note A open and dirty: its save is the `save` gate, armed
 * (`pending`) until the gate settles. `fence` is what the session answers for
 * "may the incoming note be read while that save runs" — null for no.
 */
function makeHarness({ fence }: { fence: (() => boolean) | null }) {
  const save = gate<void>();
  let pending = true;
  let flushes = 0;
  const openNote = vi.fn();
  // As noteSaveQueue: a save that settles either way is no longer pending.
  const flushSave = vi.fn(async () => {
    flushes += 1;
    try {
      await save.promise;
    } finally {
      pending = false;
    }
  });
  const loader = createNoteLoader({
    autoResizeTitle: vi.fn(),
    clearTitleWarning: vi.fn(),
    flushSave,
    focusEditor: vi.fn(),
    getEditorContent: () => 'A body (edited)',
    getNoteBody: () => undefined,
    getNotes: () => [],
    isSavePending: () => pending,
    fenceIncomingRead: () => fence,
    navigate: vi.fn(),
    patchState: vi.fn(),
    resetState: vi.fn(),
    openNote,
  });
  return { loader, save, openNote, flushSave, flushes: () => flushes };
}

describe('a note switch while the outgoing note is saving', () => {
  beforeEach(() => {
    vi.mocked(readNote).mockReset();
    vi.mocked(readNote).mockImplementation(async () => '');
  });

  it('reads the incoming note while the save is still writing (a different file)', async () => {
    const h = makeHarness({ fence: () => true });
    const read = gate<string>();
    vi.mocked(readNote).mockImplementationOnce(() => read.promise);

    const opening = h.loader.load('B');
    await flushMicrotasks();
    // The read started although the save has not settled.
    expect(readNote).toHaveBeenCalledWith('B');
    expect(h.openNote).not.toHaveBeenCalled();

    // The read lands first; the note is NOT opened over a running save.
    read.resolve('B body');
    await flushMicrotasks();
    expect(h.openNote).not.toHaveBeenCalled();

    h.save.resolve();
    await opening;
    expect(h.openNote).toHaveBeenCalledWith('B', 'B body');
    // The read that overlapped the save was the only one: nothing re-read.
    expect(readNote).toHaveBeenCalledTimes(1);
  });

  it('waits for the save before reading when it may touch the incoming note', async () => {
    const h = makeHarness({ fence: null });
    vi.mocked(readNote).mockResolvedValueOnce('A body (saved)');

    const opening = h.loader.load('A');
    await flushMicrotasks();
    expect(readNote).not.toHaveBeenCalled();

    h.save.resolve();
    await opening;
    expect(readNote).toHaveBeenCalledTimes(1);
    expect(h.openNote).toHaveBeenCalledWith('A', 'A body (saved)');
  });

  it('does not open the incoming note when the overlapped save fails', async () => {
    const h = makeHarness({ fence: () => true });
    vi.mocked(readNote).mockResolvedValueOnce('B body');

    const opening = h.loader.load('B');
    await flushMicrotasks();
    expect(readNote).toHaveBeenCalledWith('B');

    h.save.reject(new Error('disk full'));
    await expect(opening).rejects.toThrow('disk full');
    expect(h.openNote).not.toHaveBeenCalled();
  });

  it('does not open the incoming note when the overlapped save fails before the read lands', async () => {
    const h = makeHarness({ fence: () => true });
    const read = gate<string>();
    vi.mocked(readNote).mockImplementationOnce(() => read.promise);

    const opening = h.loader.load('B');
    await flushMicrotasks();
    // The save fails first: nothing is pending any more, and the editor still
    // holds exactly what the read started with.
    h.save.reject(new Error('disk full'));
    await flushMicrotasks();
    read.resolve('B body');

    await expect(opening).rejects.toThrow('disk full');
    expect(h.openNote).not.toHaveBeenCalled();
  });

  it('re-reads when a keystroke landed in the outgoing note during the read', async () => {
    let editorContent = 'A body';
    const save = gate<void>();
    let pending = false;
    const openNote = vi.fn();
    const loader = createNoteLoader({
      autoResizeTitle: vi.fn(),
      clearTitleWarning: vi.fn(),
      flushSave: vi.fn(async () => {
        await save.promise;
        pending = false;
      }),
      focusEditor: vi.fn(),
      getEditorContent: () => editorContent,
      getNoteBody: () => undefined,
      getNotes: () => [],
      isSavePending: () => pending,
      fenceIncomingRead: () => () => true,
      navigate: vi.fn(),
      patchState: vi.fn(),
      resetState: vi.fn(),
      openNote,
    });
    const firstRead = gate<string>();
    vi.mocked(readNote).mockImplementationOnce(() => firstRead.promise);
    vi.mocked(readNote).mockResolvedValueOnce('B body (re-read)');
    save.resolve();

    const opening = loader.load('B');
    await flushMicrotasks();
    // A keystroke: the outgoing note is dirty again, with a save armed.
    editorContent = 'A body typed';
    pending = true;
    firstRead.resolve('B body');
    await opening;
    expect(readNote).toHaveBeenCalledTimes(2);
    expect(openNote).toHaveBeenCalledWith('B', 'B body (re-read)');
  });

  it('reads again behind the flush when a save that may touch the incoming note started mid-read', async () => {
    let fenceHolds = true;
    const h = makeHarness({ fence: () => fenceHolds });
    const firstRead = gate<string>();
    vi.mocked(readNote).mockImplementationOnce(() => firstRead.promise);
    vi.mocked(readNote).mockResolvedValueOnce('B body (after the rename rewrote its links)');

    const opening = h.loader.load('B');
    await flushMicrotasks();
    // A title edit's save starts while B is being read: it may rewrite B.
    fenceHolds = false;
    firstRead.resolve('B body (stale)');
    await flushMicrotasks();
    expect(readNote).toHaveBeenCalledTimes(1);

    h.save.resolve();
    await opening;
    expect(readNote).toHaveBeenCalledTimes(2);
    expect(h.openNote).toHaveBeenCalledWith('B', 'B body (after the rename rewrote its links)');
  });
});
