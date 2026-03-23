// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

// Mock platform module before importing the module under test
vi.mock('$lib/platform', () => ({
  getFS: vi.fn(),
}));

vi.mock('$lib/liveMarkdownTransform', () => ({
  registerLocalImageUrl: vi.fn(),
}));

import { handleImagePaste, insertImageMarkdown } from './markdownToolbar';
import { getFS } from '$lib/platform';
import { registerLocalImageUrl } from '$lib/liveMarkdownTransform';

const mockedGetFS = vi.mocked(getFS);
const mockedRegisterLocalImageUrl = vi.mocked(registerLocalImageUrl);

function createView(doc: string, anchor: number, head?: number): EditorView {
  return new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor, head: head ?? anchor },
    }),
  });
}

function makeFile(type: string, name = 'image.png'): File {
  return new File([new Uint8Array([0x89, 0x50])], name, { type });
}

describe('insertImageMarkdown', () => {
  it('inserts image markdown at cursor', () => {
    const view = createView('hello world', 5);
    insertImageMarkdown(view, 'photo.png');
    expect(view.state.doc.toString()).toBe('hello![](photo.png)\n world');
  });

  it('replaces selected text', () => {
    const view = createView('hello world', 0, 5);
    insertImageMarkdown(view, 'photo.png');
    expect(view.state.doc.toString()).toBe('![](photo.png)\n world');
  });
});

describe('handleImagePaste', () => {
  let mockSaveImageBytes: ReturnType<typeof vi.fn>;
  let mockGetImageUrl: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSaveImageBytes = vi.fn().mockResolvedValue('saved-image.png');
    mockGetImageUrl = vi.fn().mockResolvedValue('blob:http://localhost/abc');
  });

  it('inserts markdown for a pasted image and replaces selection', async () => {
    mockedGetFS.mockReturnValue({
      saveImageBytes: mockSaveImageBytes,
      getImageUrl: mockGetImageUrl,
    } as any);

    const view = createView('replace me', 0, 10);
    await handleImagePaste(view, [makeFile('image/png')]);

    expect(mockSaveImageBytes).toHaveBeenCalledOnce();
    expect(mockGetImageUrl).toHaveBeenCalledWith('saved-image.png');
    expect(mockedRegisterLocalImageUrl).toHaveBeenCalledWith(
      'saved-image.png',
      'blob:http://localhost/abc',
    );
    expect(view.state.doc.toString()).toBe('![](saved-image.png)\n');
  });

  it('no-ops when saveImageBytes is not available', async () => {
    mockedGetFS.mockReturnValue({
      getImageUrl: mockGetImageUrl,
    } as any);

    const view = createView('hello', 5);
    await handleImagePaste(view, [makeFile('image/png')]);

    expect(view.state.doc.toString()).toBe('hello');
  });

  it('continues to next image when one fails', async () => {
    let callCount = 0;
    mockSaveImageBytes.mockImplementation(() => {
      callCount++;
      if (callCount === 1) throw new Error('disk full');
      return Promise.resolve('second.png');
    });
    mockGetImageUrl.mockResolvedValue('blob:http://localhost/def');

    mockedGetFS.mockReturnValue({
      saveImageBytes: mockSaveImageBytes,
      getImageUrl: mockGetImageUrl,
    } as any);

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = createView('', 0);
    await handleImagePaste(view, [makeFile('image/png'), makeFile('image/jpeg')]);

    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(view.state.doc.toString()).toBe('![](second.png)\n');
    consoleSpy.mockRestore();
  });

  it('inserts multiple images sequentially', async () => {
    let call = 0;
    mockSaveImageBytes.mockImplementation(() => {
      call++;
      return Promise.resolve(`img${call}.png`);
    });
    mockGetImageUrl.mockResolvedValue('blob:url');

    mockedGetFS.mockReturnValue({
      saveImageBytes: mockSaveImageBytes,
      getImageUrl: mockGetImageUrl,
    } as any);

    const view = createView('', 0);
    await handleImagePaste(view, [makeFile('image/png'), makeFile('image/jpeg')]);

    expect(view.state.doc.toString()).toBe('![](img1.png)\n![](img2.png)\n');
  });

  it('skips files with unsupported MIME types', async () => {
    mockedGetFS.mockReturnValue({
      saveImageBytes: mockSaveImageBytes,
      getImageUrl: mockGetImageUrl,
    } as any);

    const view = createView('', 0);
    await handleImagePaste(view, [
      makeFile('application/pdf', 'doc.pdf'),
      makeFile('image/png', 'screenshot.png'),
    ]);

    expect(mockSaveImageBytes).toHaveBeenCalledOnce();
    expect(view.state.doc.toString()).toBe('![](saved-image.png)\n');
  });
});
