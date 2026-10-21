import { beforeEach, vi } from 'vitest';
import { clearVaultImageUrlCache } from '$features/images/vaultImageSrc';
import { createImageInsertTarget, type ImageInsertTarget } from '../imageInsertTarget';

const { getFS } = vi.hoisted(() => ({ getFS: vi.fn() }));
export { getFS };
vi.mock('$lib/platform', () => ({ getFS, isTauri: false }));

export function pngFile(name = 'photo.png', type = 'image/png'): File {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type });
}

/**
 * An insert target over ONE note that never changes — the ordinary case, where
 * the user stays put. The cases that swap the note mid-save build their own.
 */
export function into(insert: (filename: string) => void): ImageInsertTarget {
  return createImageInsertTarget({ documentToken: () => 'the note', insert });
}

/**
 * A stand-in for the `DataTransfer` on a drop event. jsdom does not implement
 * the real one, and these functions only ever read `.files` — a real browser
 * `DataTransfer` is exercised by the Playwright drop spec instead.
 */
export function transferWith(...files: File[]): DataTransfer {
  return { files } as unknown as DataTransfer;
}

/**
 * A stand-in for a `DataTransfer` carrying text data — `getData`/`types`,
 * the shape WebKitGTK's file drop (and the editor's own block drag) uses.
 * `files` defaults to empty, matching WebKitGTK, which never populates it.
 */
export function transferWithData(
  data: Partial<Record<'text/uri-list' | 'text/plain' | 'text/html', string>>,
) {
  const entries = Object.entries(data).filter(([, value]) => value !== undefined) as [
    string,
    string,
  ][];
  return {
    files: [],
    types: entries.map(([type]) => type),
    getData: (type: string) => entries.find(([t]) => t === type)?.[1] ?? '',
  } as unknown as DataTransfer;
}

/** A vault FS that records what it was asked to write. */
export function fakeFs(overrides: Partial<Record<string, unknown>> = {}) {
  let counter = 0;
  return {
    saveImagePath: vi.fn(async (source: string) => `image-from-${source.split('/').pop()}`),
    saveImageBytes: vi.fn(async (_data: ArrayBuffer, ext: string) => `image-${++counter}.${ext}`),
    getImageUrl: vi.fn(async (filename: string) => `asset://${filename}`),
    ...overrides,
  };
}

/** Resets the vault URL cache and the mocked FS before each test of the calling file. */
export function useImageInsertMocks(): void {
  beforeEach(() => {
    clearVaultImageUrlCache();
    getFS.mockReset();
  });
}
