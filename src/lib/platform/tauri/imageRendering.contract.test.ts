// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const RED_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x00, 0x03, 0x00, 0x01, 0x18, 0xdd, 0x8d, 0xb0, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
]);

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === 'resolve_default_notes_root') return '/home/user/Documents/futo-notes';
    if (cmd === 'notes_dir_override_load') return null;
    return null;
  }),
  convertFileSrc: vi.fn((p: string) => `asset://localhost/${encodeURI(p)}`),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock('@tauri-apps/api/path', () => ({
  documentDir: vi.fn(() => Promise.resolve('/home/user/Documents')),
  appDataDir: vi.fn(() => Promise.resolve('/home/user/.local/share/com.futo.notes')),
  join: vi.fn((...parts: string[]) => Promise.resolve(parts.join('/'))),
  isAbsolute: vi.fn((p: string) => Promise.resolve(p.startsWith('/'))),
}));

const disk = new Map<string, Uint8Array>();

vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(() => Promise.reject(new Error('not found'))),
  writeTextFile: vi.fn(() => Promise.resolve()),
  readFile: vi.fn(async (path: string) => {
    const bytes = disk.get(path);
    if (!bytes) throw new Error(`not found: ${path}`);
    return bytes;
  }),
  writeFile: vi.fn(async (path: string, data: Uint8Array) => {
    disk.set(path, data);
  }),
  readDir: vi.fn(() => Promise.resolve([])),
  remove: vi.fn(() => Promise.resolve()),
  mkdir: vi.fn(() => Promise.resolve()),
  rename: vi.fn(() => Promise.resolve()),
  exists: vi.fn(() => Promise.resolve(true)),
  stat: vi.fn(() => Promise.resolve({ mtime: new Date() })),
}));

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: vi.fn(() => Promise.resolve('0.0.0-test')),
}));

const blobBytes = new Map<string, Uint8Array>();
let assetSchemeServable = false;

class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 0;
  private _src = '';
  set src(value: string) {
    this._src = value;
    queueMicrotask(() => {
      if (value.startsWith('asset://') ? assetSchemeServable : true) {
        this.naturalWidth = 1;
        this.onload?.();
      } else {
        this.onerror?.();
      }
    });
  }
  get src(): string {
    return this._src;
  }
}

async function bytesRenderedFrom(url: string): Promise<Uint8Array | null> {
  if (url.startsWith('blob:')) {
    return blobBytes.get(url) ?? null;
  }
  if (url.startsWith('data:')) {
    const buf = await (await fetch(url)).arrayBuffer();
    return new Uint8Array(buf);
  }
  if (assetSchemeServable) return blobBytes.get(url) ?? null;
  return null;
}

beforeEach(() => {
  disk.clear();
  blobBytes.clear();
  assetSchemeServable = false;
  vi.unstubAllGlobals();
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function saveAndResolve(): Promise<{ url: string; assetUrl: string }> {
  const { tauriFS } = await import('../tauri');

  const filename = await tauriFS.saveImageBytes!(RED_PNG.buffer.slice(0) as ArrayBuffer, 'png');
  const path = `/home/user/Documents/futo-notes/${filename}`;
  expect(disk.get(path)).toEqual(RED_PNG);

  const assetUrl = `asset://localhost/${encodeURI(path)}`;

  let n = 0;
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn((blob: Blob) => {
      const url = `blob:nodedata:${n++}`;
      expect(blob.size).toBe(RED_PNG.byteLength);
      blobBytes.set(url, RED_PNG);
      return url;
    }),
    revokeObjectURL: vi.fn(),
  });
  vi.stubGlobal('Image', FakeImage);

  const url = await tauriFS.getImageUrl(filename);
  return { url, assetUrl };
}

describe('pasted image renders its real pixels (not pure white)', () => {
  it('(A) asset URL undecodable (macOS white-box): falls back to a URL that delivers the saved bytes', async () => {
    const { url } = await saveAndResolve();

    expect(url.startsWith('asset://')).toBe(false);

    const rendered = await bytesRenderedFrom(url);
    expect(rendered).not.toBeNull();
    expect(rendered).toEqual(RED_PNG);
  });

  it('(B) asset URL decodable (happy path): keeps the zero-copy asset protocol', async () => {
    assetSchemeServable = true;

    const { url, assetUrl } = await saveAndResolve();
    blobBytes.set(assetUrl, RED_PNG);

    expect(url).toBe(assetUrl);

    const rendered = await bytesRenderedFrom(url);
    expect(rendered).toEqual(RED_PNG);
  });
});
