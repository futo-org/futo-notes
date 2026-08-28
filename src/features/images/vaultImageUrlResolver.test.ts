// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getFS } = vi.hoisted(() => ({ getFS: vi.fn() }));
vi.mock('$lib/platform', () => ({ getFS, isTauri: false }));

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
  getFS.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('installVaultImageUrlResolver', () => {
  it('installs the platform getImageUrl, so a rendered filename resolves per file', async () => {
    getFS.mockReturnValue({ getImageUrl: vi.fn().mockResolvedValue('asset://vault/pic.png') });

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
    getFS.mockReturnValue({ getImageUrl });

    expect(installVaultImageUrlResolver()).toBe(false);

    requestVaultImageUrl('pic.png');
    expect(getImageUrl).not.toHaveBeenCalled();
  });

  it('installs nothing when there is no platform FS at all', () => {
    getFS.mockImplementation(() => {
      throw new Error('no platform FS in this environment');
    });
    expect(installVaultImageUrlResolver()).toBe(false);
  });

  it('uninstalls the resolver it installed', () => {
    const getImageUrl = vi.fn().mockResolvedValue('asset://vault/pic.png');
    getFS.mockReturnValue({ getImageUrl });
    installVaultImageUrlResolver();

    uninstallVaultImageUrlResolver();

    requestVaultImageUrl('pic.png');
    expect(getImageUrl).not.toHaveBeenCalled();
  });
});
