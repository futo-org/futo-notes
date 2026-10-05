import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  availability: { unavailable: false },
  openNote: vi.fn(() => ({ id: 'tab-1' })),
  setPendingFolder: vi.fn(),
}));

vi.mock('$features/storage/vaultAvailability.svelte', () => ({
  vaultAvailability: mocks.availability,
}));
vi.mock('$features/tabs/tabsStore.svelte', () => ({
  tabsStore: { openNote: mocks.openNote, setPendingFolder: mocks.setPendingFolder },
}));

import { createNewNote } from './createNewNote';

describe('createNewNote', () => {
  beforeEach(() => vi.clearAllMocks());

  it('opens a new note in the given folder', () => {
    mocks.availability.unavailable = false;
    createNewNote('projects');
    expect(mocks.openNote).toHaveBeenCalledWith('new', 'current');
    expect(mocks.setPendingFolder).toHaveBeenCalledWith('tab-1', 'projects');
  });

  // Typing into it would end in "Couldn't save note" and text lost on quit.
  it('does nothing while the vault is unusable', () => {
    mocks.availability.unavailable = true;
    createNewNote('projects');
    expect(mocks.openNote).not.toHaveBeenCalled();
  });
});
