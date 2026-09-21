import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearVaultImageUrlCache,
  isRemoteImageSource,
  onVaultImageSrcChange,
  registerVaultImageUrl,
  requestVaultImageUrl,
  resolveVaultImageSrc,
  setVaultImageBaseUrl,
  setVaultImageUrlResolver,
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

  it('stops resolving when the base URL is cleared', () => {
    setVaultImageBaseUrl('file:///notes/');
    setVaultImageBaseUrl('');
    expect(resolveVaultImageSrc('photo.png')).toBe('');
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

    // Re-registering the SAME blob URL must not revoke the URL still in use.
    revoke.mockClear();
    registerVaultImageUrl('same.png', 'blob:same');
    registerVaultImageUrl('same.png', 'blob:same');
    expect(revoke).not.toHaveBeenCalled();
    expect(resolveVaultImageSrc('same.png')).toBe('blob:same');

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

describe('requestVaultImageUrl', () => {
  beforeEach(() => {
    setVaultImageUrlResolver(null);
  });

  it('registers the URL the resolver produces, which re-resolves the filename', async () => {
    const resolve = vi.fn().mockResolvedValue('asset://vault/photo.png');
    setVaultImageUrlResolver(resolve);

    requestVaultImageUrl('photo.png');
    await vi.waitFor(() =>
      expect(resolveVaultImageSrc('photo.png')).toBe('asset://vault/photo.png'),
    );
    expect(resolve).toHaveBeenCalledWith('photo.png');
  });

  it('asks the resolver once for a filename, however many renders request it', async () => {
    const resolve = vi.fn().mockResolvedValue('asset://vault/photo.png');
    setVaultImageUrlResolver(resolve);

    requestVaultImageUrl('photo.png');
    requestVaultImageUrl('photo.png');
    requestVaultImageUrl('photo.png');
    await vi.waitFor(() => expect(resolveVaultImageSrc('photo.png')).not.toBe(''));
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('never asks for a filename that already resolves', () => {
    const resolve = vi.fn();
    setVaultImageUrlResolver(resolve);
    registerVaultImageUrl('photo.png', 'blob:already-here');

    requestVaultImageUrl('photo.png');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('never asks for a remote source', () => {
    const resolve = vi.fn();
    setVaultImageUrlResolver(resolve);

    requestVaultImageUrl('https://example.com/a.png');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('is a no-op with no resolver installed (the native shells use a base URL)', () => {
    expect(() => requestVaultImageUrl('photo.png')).not.toThrow();
    expect(resolveVaultImageSrc('photo.png')).toBe('');
  });

  /* A missing or unreadable file must not wedge the filename: sync delivers an
   * image alongside its note, not necessarily before it, so a later render has
   * to be able to ask again. Modelled the way it actually happens — renders
   * keep asking. */
  it('lets a later render retry after the resolver rejects', async () => {
    const resolve = vi
      .fn()
      .mockRejectedValueOnce(new Error('no such file'))
      .mockResolvedValue('asset://vault/photo.png');
    setVaultImageUrlResolver(resolve);

    requestVaultImageUrl('photo.png');
    await vi.waitFor(() => {
      requestVaultImageUrl('photo.png');
      expect(resolveVaultImageSrc('photo.png')).toBe('asset://vault/photo.png');
    });
    expect(resolve.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('clearVaultImageUrlCache', () => {
  it('revokes every outstanding blob: URL and leaves other schemes alone', () => {
    const revoke = vi.fn();
    vi.stubGlobal('URL', { ...URL, revokeObjectURL: revoke });

    registerVaultImageUrl('d.png', 'blob:d');
    registerVaultImageUrl('e.png', 'asset://e.png');
    registerVaultImageUrl('f.png', 'blob:f');
    clearVaultImageUrlCache();

    expect(revoke.mock.calls.map(([url]) => url).sort()).toEqual(['blob:d', 'blob:f']);
    vi.unstubAllGlobals();
  });

  it('notifies subscribers, so a live renderer drops a revoked blob: src', () => {
    registerVaultImageUrl('photo.png', 'blob:doomed');
    const seen = vi.fn();
    onVaultImageSrcChange(seen);

    clearVaultImageUrlCache();

    expect(seen).toHaveBeenCalledTimes(1);
    expect(resolveVaultImageSrc('photo.png')).toBe('');
  });
});
