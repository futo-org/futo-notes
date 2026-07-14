import { describe, expect, it, afterEach, vi } from 'vitest';
import {
  clearLocalImageUrlCache,
  registerLocalImageUrl,
  resolveImageSrc,
  setLocalImageBaseUrl,
} from './liveMarkdownTransform';

afterEach(() => {
  setLocalImageBaseUrl('');
  clearLocalImageUrlCache();
  vi.restoreAllMocks();
});

describe('setLocalImageBaseUrl', () => {
  it('cache miss with no base resolves to empty (desktop unchanged)', () => {
    expect(resolveImageSrc('missing.png')).toBe('');
  });

  it('cache miss falls back to base + encodeURIComponent(src)', () => {
    setLocalImageBaseUrl('futo-asset:///');
    expect(resolveImageSrc('photo 1.png')).toBe('futo-asset:///photo%201.png');
  });

  it('a registered per-file URL wins over the base', () => {
    setLocalImageBaseUrl('file:///notes/');
    registerLocalImageUrl('cached.png', 'asset://cached.png');
    expect(resolveImageSrc('cached.png')).toBe('asset://cached.png');
  });

  it('remote URLs and data URIs pass through untouched', () => {
    setLocalImageBaseUrl('file:///notes/');
    expect(resolveImageSrc('https://example.com/a.png')).toBe('https://example.com/a.png');
    expect(resolveImageSrc('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
  });

  it('clearing the base restores the empty-string miss', () => {
    setLocalImageBaseUrl('file:///notes/');
    setLocalImageBaseUrl('');
    expect(resolveImageSrc('missing2.png')).toBe('');
  });
});

describe('local image blob URL eviction', () => {
  it('revokes a replaced blob: URL when the cache entry changes', () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    registerLocalImageUrl('a.png', 'blob:fake-1');
    registerLocalImageUrl('a.png', 'blob:fake-2');
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith('blob:fake-1');
    expect(resolveImageSrc('a.png')).toBe('blob:fake-2');
  });

  it('does not revoke when the replacement value is identical', () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    registerLocalImageUrl('b.png', 'blob:same');
    registerLocalImageUrl('b.png', 'blob:same');
    expect(revoke).not.toHaveBeenCalled();
  });

  it('does not revoke non-blob (asset://) URLs on replacement', () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    registerLocalImageUrl('c.png', 'asset://c.png?v=1');
    registerLocalImageUrl('c.png', 'asset://c.png?v=2');
    expect(revoke).not.toHaveBeenCalled();
  });

  it('clearLocalImageUrlCache revokes all outstanding blob: URLs', () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    registerLocalImageUrl('d.png', 'blob:d');
    registerLocalImageUrl('e.png', 'asset://e.png');
    registerLocalImageUrl('f.png', 'blob:f');
    clearLocalImageUrlCache();
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(revoke).toHaveBeenCalledWith('blob:d');
    expect(revoke).toHaveBeenCalledWith('blob:f');
  });
});
