// @vitest-environment jsdom
/**
 * Regression test for the "pasted image renders pure white / blank" bug.
 *
 * Repro (macOS, also reported on Linux/WebKitGTK): copy a screenshot, paste it
 * into the editor. A correct-looking `![](image-….png)` link is inserted and the
 * editor reserves layout space, but the image renders as a PURE WHITE box — the
 * real pixels never appear.
 *
 * Root cause: `tauriFS.getImageUrl` (src/lib/platform/tauri.ts) decided whether
 * to use the Tauri asset protocol by sending ONE `HEAD` probe and trusting
 * `probe.ok`. The asset-protocol custom-scheme handler in WKWebView can answer a
 * `HEAD` with 200 OK while the same `asset://` URL delivers NO decodable image
 * bytes to an `<img>` (the very condition the inline comment warns about:
 * "Tauri v2's asset protocol can reject paths even when fs:scope covers them").
 * The probe's false positive poisoned the session-global `assetProtocolWorks`
 * flag, so every pasted image was rendered from a bare `asset://` URL that the
 * webview won't paint — a blank/white box at the reserved size. The image bytes
 * ARE on disk and intact (the blob fallback would show them), but `getImageUrl`
 * handed back the unrenderable asset URL instead.
 *
 * The fix replaces the HEAD probe with an actual <img>-decode probe
 * (`assetUrlDecodes`): a HEAD/GET 200 is not evidence an <img> will paint the
 * URL, so the gate now requires a real `onload` + `naturalWidth > 0`; any
 * non-decode falls back to the reliable readFile→blob path.
 *
 * This test pins the contract on BOTH sides so it can tell the real fix apart
 * from a degenerate "always use blob" one:
 *
 *   (A) macOS white-box condition — the asset:// URL does NOT decode in an
 *       <img>. getImageUrl MUST fall back to a URL that delivers the saved
 *       bytes (the blob path), not return the unrenderable asset URL.
 *
 *   (B) happy path — the asset:// URL DOES decode in an <img>. getImageUrl MUST
 *       keep using the zero-copy asset protocol (a degenerate always-blob fix
 *       would wrongly abandon it).
 *
 * It drives the real `assetUrlDecodes` code path by stubbing `Image` with a fake
 * that fires onload/onerror based on a per-scenario "asset scheme servable" flag
 * (jsdom's real Image never fires either event), so the asset-decode branch is
 * genuinely exercised rather than short-circuited.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The real PNG bytes a "screenshot" paste would write: a tiny but non-white,
// fully-decodable 1x1 red PNG.
const RED_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x00, 0x03, 0x00, 0x01, 0x18, 0xdd, 0x8d, 0xb0, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
]);

// ── Mock the Tauri module graph that src/lib/platform/tauri.ts pulls in ──

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === 'resolve_default_notes_root') return '/home/user/Documents/futo-notes';
    if (cmd === 'notes_dir_override_load') return null;
    return null;
  }),
  // Real Tauri returns asset://localhost/<encoded-abs-path>; the shape is what
  // matters here.
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

// In-memory disk so saveImageBytes → getImageUrl round-trips the real bytes.
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

// ── Test harness: model what an <img> would actually paint ───────────────────
//
// `getImageUrl` either returns the asset:// URL (zero-copy) or a blob: URL it
// creates from the on-disk bytes. To assert "the screenshot really shows", we
// resolve each kind of URL the way the webview would:
//
//  - blob: → its underlying bytes (always paintable). jsdom's `fetch(blob:)`
//    does NOT resolve blob contents, so we register the bytes when
//    URL.createObjectURL is called and read them back from that registry.
//  - asset:// → paints iff the asset scheme is servable in this webview. The
//    macOS/WebKitGTK white-box bug is exactly the case where it is NOT.
//
// The `assetSchemeServable` flag toggles between the two scenarios. We also
// drive the real `assetUrlDecodes` probe inside getImageUrl via a fake `Image`
// whose onload/onerror fire from the SAME flag — so an asset URL "decodes" in
// the probe iff it would actually paint, mirroring reality.

const blobBytes = new Map<string, Uint8Array>();
// Whether the webview's asset:// scheme decodes/paints in the current scenario.
// macOS/WebKitGTK white-box bug = false; healthy desktop = true. The saved
// filename (timestamp+random) isn't known until saveImageBytes runs, while the
// decode probe runs DURING getImageUrl, so this is a per-scenario flag rather
// than a per-URL set.
let assetSchemeServable = false;

class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 0;
  private _src = '';
  set src(value: string) {
    this._src = value;
    // Fire asynchronously like a real Image, but synchronously enough that the
    // awaiting probe resolves without a timeout.
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
  // asset:// — the webview's custom scheme. Paints iff servable.
  if (assetSchemeServable) return blobBytes.get(url) ?? null;
  return null;
}

beforeEach(() => {
  disk.clear();
  blobBytes.clear();
  assetSchemeServable = false;
  vi.unstubAllGlobals();
  // Reset modules so the session-global `assetProtocolWorks` cache in tauri.ts
  // starts null for each scenario (otherwise test A's "doesn't decode" decision
  // would leak into test B).
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Save the screenshot bytes through the real save path, then return the URL
 * getImageUrl produces with the harness wired:
 *  - `Image` is the FakeImage that decodes an asset URL iff the asset scheme is
 *    servable this scenario, so the real `assetUrlDecodes` probe inside
 *    getImageUrl is genuinely exercised.
 *  - `URL.createObjectURL` is intercepted so a blob URL maps back to the exact
 *    bytes the fix wrapped (asserting the Blob actually carries the on-disk
 *    pixels), since jsdom's `fetch(blob:)` does not resolve blob contents.
 */
async function saveAndResolve(): Promise<{ url: string; assetUrl: string }> {
  // Single fresh import per test (vi.resetModules clears the session cache).
  const { tauriFS } = await import('./tauri');

  const filename = await tauriFS.saveImageBytes!(RED_PNG.buffer.slice(0) as ArrayBuffer, 'png');
  const path = `/home/user/Documents/futo-notes/${filename}`;
  // Sanity: the bytes really are on disk and intact (the file is NOT blank).
  expect(disk.get(path)).toEqual(RED_PNG);

  const assetUrl = `asset://localhost/${encodeURI(path)}`;

  let n = 0;
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn((blob: Blob) => {
      const url = `blob:nodedata:${n++}`;
      // The fix reads the on-disk bytes then wraps them in a Blob; assert the
      // Blob actually carries the real bytes (jsdom Blob.size is exact), then
      // register them so bytesRenderedFrom can resolve the blob URL.
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
    // The asset scheme answers but an <img> can't decode it — the white-box
    // condition. (servable stays empty for the asset URL.)
    const { url } = await saveAndResolve();

    // MUST NOT return the unrenderable asset URL (the pure-white box).
    expect(url.startsWith('asset://')).toBe(false);

    // The returned URL must actually deliver the saved pixels so the screenshot
    // shows.
    const rendered = await bytesRenderedFrom(url);
    expect(rendered).not.toBeNull();
    expect(rendered).toEqual(RED_PNG);
  });

  it('(B) asset URL decodable (happy path): keeps the zero-copy asset protocol', async () => {
    // The asset scheme decodes fine in an <img>. The saved filename isn't known
    // until saveImageBytes runs but the probe runs during getImageUrl, so mark
    // the asset scheme servable for this scenario.
    assetSchemeServable = true;

    const { url, assetUrl } = await saveAndResolve();
    blobBytes.set(assetUrl, RED_PNG);

    // A correct fix preserves the zero-copy asset path when it actually
    // decodes — a degenerate always-blob fix would wrongly return a blob URL.
    expect(url).toBe(assetUrl);

    // And of course it still delivers the real pixels.
    const rendered = await bytesRenderedFrom(url);
    expect(rendered).toEqual(RED_PNG);
  });
});
