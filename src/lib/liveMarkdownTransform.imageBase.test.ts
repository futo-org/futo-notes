/**
 * The native-embed image-base seam: when the host registers a base URL via
 * FutoEditor.setImageBaseUrl (→ setLocalImageBaseUrl), local image filenames
 * that miss the per-file URL cache resolve against it. Desktop never sets a
 * base, so its cache-miss behavior ('' → broken-image styling) is unchanged.
 */

import { describe, expect, it, afterEach } from 'vitest';
import {
  registerLocalImageUrl,
  resolveImageSrc,
  setLocalImageBaseUrl,
} from './liveMarkdownTransform';

afterEach(() => {
  setLocalImageBaseUrl('');
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
