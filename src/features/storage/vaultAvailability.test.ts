import { beforeEach, describe, expect, it, vi } from 'vitest';

const vaultStatus = vi.hoisted(() => vi.fn());
vi.mock('$lib/platform/tauri', () => ({ vaultStatus }));

const status = (available: boolean) => ({
  displayPath: 'C:\\Users\\Admin\\Documents\\futo-notes',
  isCustom: false,
  available,
  deletesArePermanent: false,
  folderDeletesArePermanent: false,
});

async function freshModule() {
  vi.resetModules();
  return import('./vaultAvailability.svelte');
}

describe('vaultAvailability', () => {
  beforeEach(() => vaultStatus.mockReset());

  it('says nothing is wrong before the startup read lands', async () => {
    const { vaultAvailability } = await freshModule();
    expect(vaultAvailability.status).toBeNull();
    expect(vaultAvailability.unavailable).toBe(false);
  });

  it('is unavailable once Rust reports a folder it cannot use', async () => {
    vaultStatus.mockResolvedValue(status(false));
    const { loadVaultAvailability, vaultAvailability } = await freshModule();
    await loadVaultAvailability();
    expect(vaultAvailability.unavailable).toBe(true);
    expect(vaultAvailability.status?.displayPath).toBe('C:\\Users\\Admin\\Documents\\futo-notes');
  });

  it('asks Rust once however many callers want the answer', async () => {
    vaultStatus.mockResolvedValue(status(true));
    const { loadVaultAvailability, vaultAvailability } = await freshModule();
    await Promise.all([loadVaultAvailability(), loadVaultAvailability()]);
    expect(vaultStatus).toHaveBeenCalledOnce();
    expect(vaultAvailability.unavailable).toBe(false);
  });
});
