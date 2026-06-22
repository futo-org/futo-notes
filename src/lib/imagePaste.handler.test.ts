import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock is hoisted above top-level consts, so define the spies via vi.hoisted.
const { invoke, saveImageBytes, getImageUrl } = vi.hoisted(() => ({
  invoke: vi.fn(),
  saveImageBytes: vi.fn(),
  getImageUrl: vi.fn(),
}));

// Mock the native clipboard read (dynamic-imported inside pasteFromNativeClipboard).
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
// Mock the platform layer so the handler runs the Tauri branch.
vi.mock('$lib/platform', () => ({ getFS: () => ({ saveImageBytes, getImageUrl }), isTauri: true }));

import { handlePasteEvent } from './imagePaste';

function makeView() {
  return {
    state: { selection: { main: { head: 0 } }, doc: { length: 0 } },
    dispatch: vi.fn(),
    focus: vi.fn(),
  };
}

function pasteEvent(clipboardData: unknown) {
  return { preventDefault: vi.fn(), clipboardData };
}

describe('handlePasteEvent (Tauri) — guards the WebKitGTK clipboard-shape wiring', () => {
  beforeEach(() => {
    invoke.mockReset();
    getImageUrl.mockReset();
    saveImageBytes.mockReset();
  });

  it('routes a browser "Copy Image" (lone text/html, no file) to the native clipboard read', async () => {
    // This is the exact shape WebKitGTK/Wayland delivers for "Copy Image".
    // Regression guard: if the native fallback gate narrows back to
    // `items.length === 0`, this paste is dropped and the test fails.
    invoke.mockResolvedValue('native-clip.png');
    getImageUrl.mockResolvedValue('asset://native-clip.png');
    const view = makeView();
    const event = pasteEvent({
      types: ['text/html'],
      items: [{ kind: 'string', type: 'text/html', getAsFile: () => null }],
      files: [],
      getData: (t: string) => (t === 'text/html' ? '<img src="https://x/y.jpg">' : ''),
    });

    const handled = handlePasteEvent(event as never, view as never);

    expect(handled).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    await vi.waitFor(() => expect(view.dispatch).toHaveBeenCalled());
    expect(invoke).toHaveBeenCalledWith('fs_paste_clipboard_image');
    expect(view.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ changes: { from: 0, insert: '![](native-clip.png)\n' } }),
    );
  });

  it('uses the standard file path when an image file IS exposed (e.g. WebView2/Chromium)', () => {
    saveImageBytes.mockResolvedValue('pasted.png');
    getImageUrl.mockResolvedValue('asset://pasted.png');
    const file = { type: 'image/png', arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)) };
    const view = makeView();
    const event = pasteEvent({
      types: ['Files'],
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
      files: [file],
    });

    const handled = handlePasteEvent(event as never, view as never);

    expect(handled).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled(); // standard path, not the native fallback
  });

  it('does NOT hijack a plain-text paste', () => {
    const view = makeView();
    const event = pasteEvent({
      types: ['text/plain'],
      items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }],
      files: [],
    });

    const handled = handlePasteEvent(event as never, view as never);

    expect(handled).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });
});
