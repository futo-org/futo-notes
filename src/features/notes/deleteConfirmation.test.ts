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

describe('noteDeleteIsPermanent', () => {
  it('promises no recovery on a vault the OS trash cannot take', async () => {
    mocks.vaultStatus.mockResolvedValue(status(true));
    const { noteDeleteIsPermanent } = await import('./deleteConfirmation');
    await expect(noteDeleteIsPermanent()).resolves.toBe(true);
  });

  it('keeps the trash-backed wording on an ordinary vault', async () => {
    mocks.vaultStatus.mockResolvedValue(status(false));
    const { noteDeleteIsPermanent } = await import('./deleteConfirmation');
    await expect(noteDeleteIsPermanent()).resolves.toBe(false);
  });

  it('asks Rust once per session, not once per delete', async () => {
    mocks.vaultStatus.mockResolvedValue(status(true));
    const { noteDeleteIsPermanent } = await import('./deleteConfirmation');
    await noteDeleteIsPermanent();
    await noteDeleteIsPermanent();
    expect(mocks.vaultStatus).toHaveBeenCalledOnce();
  });

  it('falls back to the milder claim when the vault cannot be read', async () => {
    mocks.vaultStatus.mockRejectedValue(new Error('vault unavailable'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { noteDeleteIsPermanent } = await import('./deleteConfirmation');
    await expect(noteDeleteIsPermanent()).resolves.toBe(false);
  });
});

describe('folderDeleteConfirmation', () => {
  it('discloses the permanently deleted shell where folders cannot be trashed', async () => {
    // A Flatpak default vault: notes trash fine, the folder shell cannot.
    mocks.vaultStatus.mockResolvedValue(status(false, true));
    const { folderDeleteConfirmation } = await import('./deleteConfirmation');
    await expect(folderDeleteConfirmation()).resolves.toEqual({
      path: 'folders.delete.permanentConfirmation',
    });
  });

  it('asks the plain question where the shell goes to the trash', async () => {
    mocks.vaultStatus.mockResolvedValue(status(false));
    const { folderDeleteConfirmation } = await import('./deleteConfirmation');
    await expect(folderDeleteConfirmation()).resolves.toEqual({
      path: 'folders.delete.recoverableConfirmation',
    });
  });
});
