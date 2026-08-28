// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearVaultImageUrlCache,
  resolveVaultImageSrc,
  setVaultImageBaseUrl,
} from '$features/images/vaultImageSrc';

import {
  createBridgeImagePasteSink,
  createImagePasteHandler,
  createVaultFsImagePasteSink,
} from './imagePasteSink';

function pngFile(name = 'shot.png', type = 'image/png'): File {
  // The bytes are a PNG magic-number prefix; base64 of them is 'iVBORw0KGgo='.
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x0a])], name, {
    type,
  });
}

/** A DataTransfer stand-in — jsdom cannot build one carrying a File. */
function clipboard(options: { types?: string[]; files?: File[]; html?: string }): DataTransfer {
  const files = options.files ?? [];
  const items = files.map((file) => ({
    kind: 'file' as const,
    type: file.type,
    getAsFile: () => file,
  }));
  return {
    types: options.types ?? files.map((f) => f.type),
    items: { length: items.length, ...items } as unknown as DataTransferItemList,
    getData: (type: string) => (type === 'text/html' ? (options.html ?? '') : ''),
  } as unknown as DataTransfer;
}

function pasteEvent(data: DataTransfer | null): ClipboardEvent {
  return { clipboardData: data, preventDefault: vi.fn() } as unknown as ClipboardEvent;
}

beforeEach(() => {
  clearVaultImageUrlCache();
  setVaultImageBaseUrl('');
});

describe('createBridgeImagePasteSink', () => {
  it('posts saveImageData with base64 bytes and the extension, and inserts nothing itself', async () => {
    const post = vi.fn();
    const sink = createBridgeImagePasteSink(post);

    await expect(sink.captureFile(pngFile())).resolves.toBeNull();
    expect(post).toHaveBeenCalledWith({
      type: 'saveImageData',
      data: 'iVBORw0KGgoK',
      ext: 'png',
    });
  });

  it('maps the MIME type to the vault extension', async () => {
    const post = vi.fn();
    await createBridgeImagePasteSink(post).captureFile(pngFile('a.jpg', 'image/jpeg'));
    expect(post.mock.calls[0][0].ext).toBe('jpg');
  });

  it('posts pasteClipboardImage for a bitmap the paste event never exposed', async () => {
    const post = vi.fn();
    await expect(createBridgeImagePasteSink(post).captureHiddenBitmap()).resolves.toBeNull();
    expect(post).toHaveBeenCalledWith({ type: 'pasteClipboardImage' });
  });
});

describe('createVaultFsImagePasteSink', () => {
  it('saves the bytes, registers the renderable URL, and returns the vault filename', async () => {
    const sink = createVaultFsImagePasteSink({
      saveImageBytes: vi.fn().mockResolvedValue('image-1.png'),
      getImageUrl: vi.fn().mockResolvedValue('asset://vault/image-1.png'),
    });

    await expect(sink.captureFile(pngFile())).resolves.toBe('image-1.png');
    expect(resolveVaultImageSrc('image-1.png')).toBe('asset://vault/image-1.png');
  });

  it('passes the extension derived from the file MIME to the FS', async () => {
    const saveImageBytes = vi.fn().mockResolvedValue('image-1.webp');
    await createVaultFsImagePasteSink({
      saveImageBytes,
      getImageUrl: vi.fn().mockResolvedValue('asset://x'),
    }).captureFile(pngFile('a.webp', 'image/webp'));

    expect(saveImageBytes.mock.calls[0][1]).toBe('webp');
  });

  it('reads a hidden bitmap off the OS clipboard and registers its URL', async () => {
    const sink = createVaultFsImagePasteSink({
      saveImageBytes: vi.fn(),
      getImageUrl: vi.fn().mockResolvedValue('asset://vault/image-2.png'),
      readClipboardImage: vi.fn().mockResolvedValue('image-2.png'),
    });

    await expect(sink.captureHiddenBitmap()).resolves.toBe('image-2.png');
    expect(resolveVaultImageSrc('image-2.png')).toBe('asset://vault/image-2.png');
  });

  it('cannot capture a hidden bitmap without an OS clipboard reader', () => {
    const sink = createVaultFsImagePasteSink({
      saveImageBytes: vi.fn(),
      getImageUrl: vi.fn(),
    });
    expect(sink.canCaptureHiddenBitmap).toBe(false);
  });
});

describe('createImagePasteHandler', () => {
  const sink = () => ({
    captureFile: vi.fn().mockResolvedValue('image-9.png'),
    captureHiddenBitmap: vi.fn().mockResolvedValue(null),
    canCaptureHiddenBitmap: true,
  });

  it('claims a paste carrying an image file and inserts the filename the sink returns', async () => {
    const insertImage = vi.fn();
    const s = sink();
    const handler = createImagePasteHandler({ sink: s, insertImage });
    const event = pasteEvent(clipboard({ files: [pngFile()] }));

    expect(handler(event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    await vi.waitFor(() => expect(insertImage).toHaveBeenCalledWith('image-9.png'));
  });

  it('inserts nothing when the sink returns null — the host inserts it', async () => {
    const insertImage = vi.fn();
    const s = { ...sink(), captureFile: vi.fn().mockResolvedValue(null) };
    createImagePasteHandler({ sink: s, insertImage })(
      pasteEvent(clipboard({ files: [pngFile()] })),
    );

    await vi.waitFor(() => expect(s.captureFile).toHaveBeenCalled());
    expect(insertImage).not.toHaveBeenCalled();
  });

  it('claims a hidden-bitmap paste and asks the sink for it', async () => {
    const s = sink();
    const handler = createImagePasteHandler({ sink: s, insertImage: vi.fn() });

    expect(handler(pasteEvent(clipboard({ types: [] })))).toBe(true);
    await vi.waitFor(() => expect(s.captureHiddenBitmap).toHaveBeenCalled());
  });

  it('leaves a hidden-bitmap paste alone when the host cannot capture one', () => {
    const s = { ...sink(), canCaptureHiddenBitmap: false };
    const handler = createImagePasteHandler({ sink: s, insertImage: vi.fn() });

    expect(handler(pasteEvent(clipboard({ types: [] })))).toBe(false);
    expect(s.captureHiddenBitmap).not.toHaveBeenCalled();
  });

  it('leaves a text paste alone so the editor pastes it normally', () => {
    const s = sink();
    const handler = createImagePasteHandler({ sink: s, insertImage: vi.fn() });

    expect(handler(pasteEvent(clipboard({ types: ['text/plain'] })))).toBe(false);
    expect(s.captureFile).not.toHaveBeenCalled();
  });

  it('leaves every paste alone when there is no sink for this host', () => {
    const handler = createImagePasteHandler({ sink: null, insertImage: vi.fn() });
    expect(handler(pasteEvent(clipboard({ files: [pngFile()] })))).toBe(false);
  });

  it('leaves a paste with no clipboard data alone', () => {
    const handler = createImagePasteHandler({ sink: sink(), insertImage: vi.fn() });
    expect(handler(pasteEvent(null))).toBe(false);
  });

  it('reports a capture failure instead of throwing, and inserts nothing', async () => {
    const reportError = vi.fn();
    const insertImage = vi.fn();
    const s = { ...sink(), captureFile: vi.fn().mockRejectedValue(new Error('disk full')) };

    createImagePasteHandler({ sink: s, insertImage, reportError })(
      pasteEvent(clipboard({ files: [pngFile()] })),
    );

    await vi.waitFor(() => expect(reportError).toHaveBeenCalled());
    expect(insertImage).not.toHaveBeenCalled();
  });
});
