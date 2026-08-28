import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearVaultImageUrlCache,
  isRemoteImageSource,
  onVaultImageSrcChange,
  registerVaultImageUrl,
  resolveVaultImageSrc,
  setVaultImageBaseUrl,
} from './vaultImageSrc';

beforeEach(() => {
  clearVaultImageUrlCache();
  setVaultImageBaseUrl('');
});

describe('resolveVaultImageSrc', () => {
  it('returns remote and data sources untouched', () => {
    expect(resolveVaultImageSrc('https://example.com/a.png')).toBe('https://example.com/a.png');
    expect(resolveVaultImageSrc('http://example.com/a.png')).toBe('http://example.com/a.png');
    expect(resolveVaultImageSrc('data:image/png;base64,AAA')).toBe('data:image/png;base64,AAA');
  });

  it('returns an empty string for a vault filename before any base URL is registered', () => {
    expect(resolveVaultImageSrc('photo.png')).toBe('');
  });

  it('joins a vault filename onto the registered base URL, percent-encoded', () => {
    setVaultImageBaseUrl('futo-asset://vault/');
    expect(resolveVaultImageSrc('my photo.png')).toBe('futo-asset://vault/my%20photo.png');
  });

  it('prefers a per-file registered URL over the base URL', () => {
    setVaultImageBaseUrl('futo-asset://vault/');
    registerVaultImageUrl('photo.png', 'asset://localhost/tmp/photo.png');
    expect(resolveVaultImageSrc('photo.png')).toBe('asset://localhost/tmp/photo.png');
  });
});

describe('onVaultImageSrcChange', () => {
  it('notifies subscribers when the base URL changes', () => {
    const seen = vi.fn();
    onVaultImageSrcChange(seen);
    setVaultImageBaseUrl('futo-asset://vault/');
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('does not notify when the base URL is set to the value it already had', () => {
    setVaultImageBaseUrl('futo-asset://vault/');
    const seen = vi.fn();
    onVaultImageSrcChange(seen);
    setVaultImageBaseUrl('futo-asset://vault/');
    expect(seen).not.toHaveBeenCalled();
  });

  it('notifies subscribers when a per-file URL is registered', () => {
    const seen = vi.fn();
    onVaultImageSrcChange(seen);
    registerVaultImageUrl('photo.png', 'blob:abc');
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('stops notifying after the returned unsubscribe runs', () => {
    const seen = vi.fn();
    const off = onVaultImageSrcChange(seen);
    off();
    setVaultImageBaseUrl('futo-asset://vault/');
    expect(seen).not.toHaveBeenCalled();
  });

  it('keeps notifying the other subscribers when one throws', () => {
    const second = vi.fn();
    onVaultImageSrcChange(() => {
      throw new Error('subscriber blew up');
    });
    onVaultImageSrcChange(second);
    expect(() => setVaultImageBaseUrl('futo-asset://vault/')).not.toThrow();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('registerVaultImageUrl', () => {
  it('revokes the blob URL it replaces, and never a non-blob URL', () => {
    const revoke = vi.fn();
    vi.stubGlobal('URL', { ...URL, revokeObjectURL: revoke });

    registerVaultImageUrl('photo.png', 'blob:first');
    registerVaultImageUrl('photo.png', 'blob:second');
    expect(revoke).toHaveBeenCalledWith('blob:first');

    revoke.mockClear();
    registerVaultImageUrl('other.png', 'asset://one');
    registerVaultImageUrl('other.png', 'asset://two');
    expect(revoke).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});

describe('isRemoteImageSource', () => {
  it('treats http, https and data sources as remote and a bare filename as local', () => {
    expect(isRemoteImageSource('https://a/b.png')).toBe(true);
    expect(isRemoteImageSource('data:image/png;base64,AA')).toBe(true);
    expect(isRemoteImageSource('photo.png')).toBe(false);
  });
});
