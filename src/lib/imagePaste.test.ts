import { describe, expect, it, vi } from 'vitest';
import { pasteImageIntoView } from './imagePaste';
import { resolveImageSrc } from './liveMarkdownTransform';

describe('pasteImageIntoView', () => {
  it('saves the image, registers the URL, and inserts markdown', async () => {
    const dispatch = vi.fn();
    const focus = vi.fn();
    const view = {
      state: { selection: { main: { head: 4 } } },
      dispatch,
      focus,
    };
    const imageFile = {
      type: 'image/png',
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
    };

    const result = await pasteImageIntoView(
      view as never,
      imageFile,
      {
        saveImageBytes: vi.fn().mockResolvedValue('pasted.png'),
        getImageUrl: vi.fn().mockResolvedValue('asset://pasted.png'),
      },
    );

    expect(result).toBe(true);
    expect(dispatch).toHaveBeenCalledWith({
      changes: { from: 4, insert: '![](pasted.png)\n' },
      selection: { anchor: 20 },
    });
    expect(focus).toHaveBeenCalled();
    expect(resolveImageSrc('pasted.png')).toBe('asset://pasted.png');
  });

  it('reports failures and does not dispatch editor changes', async () => {
    const dispatch = vi.fn();
    const focus = vi.fn();
    const reportError = vi.fn();
    const view = {
      state: { selection: { main: { head: 0 } } },
      dispatch,
      focus,
    };
    const imageFile = {
      type: 'image/jpeg',
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
    };
    const failure = new Error('disk full');

    const result = await pasteImageIntoView(
      view as never,
      imageFile,
      {
        saveImageBytes: vi.fn().mockRejectedValue(failure),
        getImageUrl: vi.fn(),
      },
      reportError,
    );

    expect(result).toBe(false);
    expect(reportError).toHaveBeenCalledWith('Image paste failed:', failure);
    expect(dispatch).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });
});
