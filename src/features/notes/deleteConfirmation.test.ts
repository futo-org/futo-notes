import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ vaultStatus: vi.fn() }));

vi.mock('$lib/platform', () => ({ isTauri: true }));
vi.mock('$lib/platform/tauri', () => ({ vaultStatus: mocks.vaultStatus }));

const status = (deletesArePermanent: boolean, folderDeletesArePermanent = deletesArePermanent) => ({
  displayPath: '/vault',
  isCustom: false,
  available: true,
  deletesArePermanent,
  folderDeletesArePermanent,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe('noteDeleteWarning', () => {
  it('promises no recovery on a vault the OS trash cannot take', async () => {
    mocks.vaultStatus.mockResolvedValue(status(true));
    const { noteDeleteWarning } = await import('./deleteConfirmation');
    await expect(noteDeleteWarning()).resolves.toBe(
      'This deletes the file for good — it does not go to the trash.',
    );
  });

  it('keeps the trash-backed wording on an ordinary vault', async () => {
    mocks.vaultStatus.mockResolvedValue(status(false));
    const { noteDeleteWarning } = await import('./deleteConfirmation');
    await expect(noteDeleteWarning()).resolves.toBe('This action cannot be undone.');
  });

  it('asks Rust once per session, not once per delete', async () => {
    mocks.vaultStatus.mockResolvedValue(status(true));
    const { noteDeleteWarning } = await import('./deleteConfirmation');
    await noteDeleteWarning();
    await noteDeleteWarning();
    expect(mocks.vaultStatus).toHaveBeenCalledOnce();
  });

  it('falls back to the milder claim when the vault cannot be read', async () => {
    mocks.vaultStatus.mockRejectedValue(new Error('vault unavailable'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { noteDeleteWarning } = await import('./deleteConfirmation');
    await expect(noteDeleteWarning()).resolves.toBe('This action cannot be undone.');
  });
});

describe('folderDeleteWarning', () => {
  it('discloses the permanently deleted shell where folders cannot be trashed', async () => {
    // A Flatpak default vault: notes trash fine, the folder shell cannot.
    mocks.vaultStatus.mockResolvedValue(status(false, true));
    const { folderDeleteWarning } = await import('./deleteConfirmation');
    await expect(folderDeleteWarning()).resolves.toBe(
      'Delete this folder? Notes inside it will be moved to the parent folder. ' +
        'Anything else inside it is deleted for good.',
    );
  });

  it('asks the plain question where the shell goes to the trash', async () => {
    mocks.vaultStatus.mockResolvedValue(status(false));
    const { folderDeleteWarning } = await import('./deleteConfirmation');
    await expect(folderDeleteWarning()).resolves.toBe(
      'Delete this folder? Notes inside it will be moved to the parent folder.',
    );
  });
});
