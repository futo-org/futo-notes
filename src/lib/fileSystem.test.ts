import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';

const searchMocks = vi.hoisted(() => ({
  engineNotify: vi.fn(async () => {}),
}));

vi.mock('$lib/platform');
vi.mock('$features/search/searchEngine', () => ({
  engineNotify: searchMocks.engineNotify,
}));

import { testFS } from '$lib/platform';
import { writeSuppressor } from './writeSuppression';
import { deleteNoteFileToTrash } from './fileSystem';

beforeEach(() => {
  testFS._reset();
  searchMocks.engineNotify.mockClear();
});

afterEach(() => {
  delete (testFS as { deleteNoteToTrash?: unknown }).deleteNoteToTrash;
});

afterAll(() => {
  testFS._cleanup();
});

describe('deleteNoteFileToTrash', () => {
  it('routes through deleteNoteToTrash and does not call the hard-delete path when the platform implements it', async () => {
    await testFS.writeNote('doomed', 'goodbye');
    const trashSpy = vi.fn(async () => {});
    testFS.deleteNoteToTrash = trashSpy;
    const hardDeleteSpy = vi.spyOn(testFS, 'deleteNoteFile');

    await deleteNoteFileToTrash('doomed');

    expect(trashSpy).toHaveBeenCalledWith('doomed');
    expect(hardDeleteSpy).not.toHaveBeenCalled();
  });

  it('falls back to permanent delete when the platform does not implement deleteNoteToTrash', async () => {
    await testFS.writeNote('doomed', 'goodbye');
    expect(testFS.deleteNoteToTrash).toBeUndefined();

    await deleteNoteFileToTrash('doomed');

    expect(await testFS.noteExists('doomed')).toBe(false);
  });

  it('records the write suppression and notifies the search engine on both paths', async () => {
    await testFS.writeNote('doomed', 'goodbye');
    const recordWriteSpy = vi.spyOn(writeSuppressor, 'recordWrite');

    await deleteNoteFileToTrash('doomed');

    expect(recordWriteSpy).toHaveBeenCalledWith('doomed.md');
    expect(searchMocks.engineNotify).toHaveBeenCalledWith('unlink', 'doomed.md');
  });
});
