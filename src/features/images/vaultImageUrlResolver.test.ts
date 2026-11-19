// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getPlatformFS } = vi.hoisted(() => ({ getPlatformFS: vi.fn() }));
vi.mock('$lib/platform', () => ({ getPlatformFS, isTauri: false }));

import {
  clearVaultImageUrlCache,
  requestVaultImageUrl,
  resolveVaultImageSrc,
  setVaultImageBaseUrl,
  setVaultImageUrlResolver,
} from './vaultImageSrc';
import {
  installVaultImageUrlResolver,
  uninstallVaultImageUrlResolver,
} from './vaultImageUrlResolver';

beforeEach(() => {
  clearVaultImageUrlCache();
  setVaultImageBaseUrl('');
  setVaultImageUrlResolver(null);
  getPlatformFS.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('installVaultImageUrlResolver', () => {
  it('installs the platform getImageUrl, so a rendered filename resolves per file', async () => {
    getPlatformFS.mockResolvedValue({
      getImageUrl: vi.fn().mockResolvedValue('asset://vault/pic.png'),
    });

    expect(installVaultImageUrlResolver()).toBe(true);

    requestVaultImageUrl('pic.png');
    await vi.waitFor(() => expect(resolveVaultImageSrc('pic.png')).toBe('asset://vault/pic.png'));
  });

  /* The host serves the whole vault off ONE base URL. A per-file resolver there
   * would race it, and the web FS `getImageUrl` inside a shell throws — so a
   * registered failure or a junk URL would win over the base URL forever. */
  it('installs nothing when a native bridge host is present', () => {
    vi.stubGlobal('futoBridge', { postMessage: vi.fn() });
    const getImageUrl = vi.fn();
    getPlatformFS.mockResolvedValue({ getImageUrl });

    expect(installVaultImageUrlResolver()).toBe(false);

    requestVaultImageUrl('pic.png');
    expect(getImageUrl).not.toHaveBeenCalled();
  });

  /* The editor mounts with the restored tab before bootstrap has resolved the platform: a
   * resolver installed then has to resolve once the platform is there. */
  it('installed before the platform FS is ready, resolves once it is', async () => {
    let platformReady: (fs: { getImageUrl: () => Promise<string> }) => void = () => {};
    getPlatformFS.mockReturnValue(new Promise((resolve) => (platformReady = resolve)));

    expect(installVaultImageUrlResolver()).toBe(true);
    const resolved = requestVaultImageUrl('pic.png');
    platformReady({ getImageUrl: vi.fn().mockResolvedValue('asset://vault/pic.png') });

    expect(await resolved).toBe(true);
    expect(resolveVaultImageSrc('pic.png')).toBe('asset://vault/pic.png');
  });

  it('uninstalls the resolver it installed', () => {
    const getImageUrl = vi.fn().mockResolvedValue('asset://vault/pic.png');
    getPlatformFS.mockResolvedValue({ getImageUrl });
    installVaultImageUrlResolver();

    uninstallVaultImageUrlResolver();

    requestVaultImageUrl('pic.png');
    expect(getImageUrl).not.toHaveBeenCalled();
  });
});
