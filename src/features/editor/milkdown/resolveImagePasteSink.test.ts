// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getFS } = vi.hoisted(() => ({ getFS: vi.fn() }));
vi.mock('$lib/platform', () => ({ getFS, isTauri: false }));

import { clearVaultImageUrlCache } from '$features/images/vaultImageSrc';

import { resolveImagePasteSink } from './imagePasteSink';

beforeEach(() => {
  clearVaultImageUrlCache();
  getFS.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function installAndroidHost(postMessage = vi.fn()): void {
  vi.stubGlobal('futoBridge', { postMessage });
}

describe('resolveImagePasteSink', () => {
  it('picks the bridge sink when a native host is listening, whatever the FS says', async () => {
    const postMessage = vi.fn();
    installAndroidHost(postMessage);
    getFS.mockReturnValue({ saveImageBytes: vi.fn(), getImageUrl: vi.fn() });

    const sink = resolveImagePasteSink();
    await sink?.captureFile(new File([new Uint8Array([1])], 'a.png', { type: 'image/png' }));

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(JSON.parse(postMessage.mock.calls[0][0] as string).type).toBe('saveImageData');
  });

  it('picks the vault-FS sink on a host that can write image bytes', async () => {
    getFS.mockReturnValue({
      saveImageBytes: vi.fn().mockResolvedValue('image-1.png'),
      getImageUrl: vi.fn().mockResolvedValue('asset://image-1.png'),
      pasteClipboardImage: vi.fn(),
    });

    const sink = resolveImagePasteSink();
    expect(sink?.canCaptureHiddenBitmap).toBe(true);
    await expect(
      sink?.captureFile(new File([new Uint8Array([1])], 'a.png', { type: 'image/png' })),
    ).resolves.toBe('image-1.png');
  });

  it('reports no hidden-bitmap capture when the host cannot read the OS clipboard', () => {
    getFS.mockReturnValue({ saveImageBytes: vi.fn(), getImageUrl: vi.fn() });
    expect(resolveImagePasteSink()?.canCaptureHiddenBitmap).toBe(false);
  });

  it('returns no sink when the host cannot write image bytes (plain browser)', () => {
    getFS.mockReturnValue({ getImageUrl: vi.fn() });
    expect(resolveImagePasteSink()).toBeNull();
  });

  it('returns no sink when there is no platform FS at all', () => {
    getFS.mockImplementation(() => {
      throw new Error('no platform FS in this environment');
    });
    expect(resolveImagePasteSink()).toBeNull();
  });
});
