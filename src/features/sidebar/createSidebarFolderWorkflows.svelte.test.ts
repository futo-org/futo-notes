import { describe, expect, it, vi } from 'vitest';

const availability = vi.hoisted(() => ({ unavailable: false }));
vi.mock('$features/storage/vaultAvailability.svelte', () => ({ vaultAvailability: availability }));

import { createSidebarFolderWorkflows } from './createSidebarFolderWorkflows.svelte';

function workflows() {
  return createSidebarFolderWorkflows({
    getActiveNoteId: () => null,
    runWithActiveNoteLock: (operation) => operation(),
    onNoteIdsRenamed: vi.fn(),
    onNoteIdsDeleted: vi.fn(),
    onSelect: vi.fn(),
    onActiveNoteDeleted: vi.fn(),
    onActiveNoteMoved: vi.fn(),
    onNewNoteInFolder: vi.fn(),
  });
}

describe('openCreateFolder', () => {
  it('opens the dialog for a usable vault', () => {
    availability.unavailable = false;
    const folder = workflows();
    folder.openCreateFolder('projects');
    expect(folder.isCreateFolderOpen).toBe(true);
  });

  // The dialog could only fail "Couldn't create folder. Try again." forever.
  it('does nothing while the vault is unusable', () => {
    availability.unavailable = true;
    const folder = workflows();
    folder.openCreateFolder('projects');
    expect(folder.isCreateFolderOpen).toBe(false);
  });
});
