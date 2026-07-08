import { EditorView } from '@codemirror/view';
import { getFS, isTauri } from '$lib/platform';
import { registerLocalImageUrl } from '$lib/liveMarkdownTransform';

const IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/bmp',
  'image/avif',
  'image/heic',
];

export function getImageFile(clipboardData: DataTransfer): File | null {
  for (let i = 0; i < clipboardData.items.length; i++) {
    const item = clipboardData.items[i];
    if (item.kind === 'file' && IMAGE_TYPES.includes(item.type)) {
      return item.getAsFile();
    }
  }
  return null;
}

export function extFromMime(mime: string): string {
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/bmp': 'bmp',
    'image/avif': 'avif',
    'image/heic': 'heic',
  };
  return map[mime] ?? 'png';
}

type ImagePasteFS = {
  saveImageBytes: (data: ArrayBuffer, ext: string) => Promise<string>;
  getImageUrl: (filename: string) => Promise<string>;
};

/**
 * Should we fall back to reading the image from the OS clipboard natively
 * (when no image file is exposed on the paste event)?
 *
 * WebKitGTK on Wayland hides clipboard image targets from the JS paste event:
 *  - a screenshot copied to the clipboard arrives with EMPTY `items`, and
 *  - a browser "Copy Image" arrives as a lone `text/html` `<img>` fragment
 *    (no file, no `image/*` type),
 * yet in both cases the real OS clipboard still holds the bitmap (which the
 * native `fs_paste_clipboard_image` command can read). Trigger the native read
 * for these shapes, but never when there is `text/plain` to paste — that's a
 * real text/rich-text paste we must leave to the default handler.
 */
export function looksLikeImagePaste(
  clipboardData: Pick<DataTransfer, 'types' | 'items' | 'getData'>,
): boolean {
  const types = Array.from(clipboardData.types);
  if (types.includes('text/plain')) return false;
  // Screenshot copied to the clipboard: WebKitGTK hands JS empty items.
  if (clipboardData.items.length === 0) return true;
  // An explicit image/* type with no file handle (some WebKitGTK paths).
  if (types.some((t) => t.startsWith('image/'))) return true;
  // A browser "Copy Image" arrives as a lone text/html <img> fragment. Require
  // an actual <img> so we don't hijack — and then fail to paste — a non-image
  // HTML or text/uri-list paste that merely happens to lack text/plain.
  if (types.includes('text/html')) return /<img\b/i.test(clipboardData.getData('text/html'));
  return false;
}

/** Save image bytes, register the URL, and insert markdown at the cursor. */
async function saveAndInsert(
  view: Pick<EditorView, 'state' | 'dispatch' | 'focus'>,
  buffer: ArrayBuffer,
  ext: string,
  fs: ImagePasteFS,
): Promise<void> {
  const filename = await fs.saveImageBytes(buffer, ext);
  const webUrl = await fs.getImageUrl(filename);
  registerLocalImageUrl(filename, webUrl);

  const pos = view.state.selection.main.head;
  const insert = `![](${filename})\n`;
  view.dispatch({
    changes: { from: pos, insert },
    selection: { anchor: pos + insert.length },
  });
  view.focus();
}

/**
 * Save a pasted image and insert markdown at the current cursor.
 * Returns false on failure after reporting the error.
 */
export async function pasteImageIntoView(
  view: Pick<EditorView, 'state' | 'dispatch' | 'focus'>,
  imageFile: Pick<File, 'type' | 'arrayBuffer'>,
  fs: ImagePasteFS,
  reportError: (message: string, error: unknown) => void = console.error,
): Promise<boolean> {
  try {
    const buffer = await imageFile.arrayBuffer();
    await saveAndInsert(view, buffer, extFromMime(imageFile.type), fs);
    return true;
  } catch (err) {
    reportError('Image paste failed:', err);
    return false;
  }
}

/**
 * Fallback for WebKitGTK on Wayland where clipboardData is empty.
 * Reads clipboard image and encodes to PNG entirely in Rust — no JS serialization.
 */
async function pasteFromNativeClipboard(view: EditorView, fs: ImagePasteFS): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  const filename = await invoke<string>('fs_paste_clipboard_image');
  const webUrl = await fs.getImageUrl(filename);
  registerLocalImageUrl(filename, webUrl);

  const pos = view.state.selection.main.head;
  const insert = `![](${filename})\n`;
  view.dispatch({
    changes: { from: pos, insert },
    selection: { anchor: pos + insert.length },
  });
  view.focus();
}

/**
 * CodeMirror extension that intercepts paste events containing images.
 * When `saveImageBytes` is available (Tauri desktop/mobile), saves the image
 * to the notes directory and inserts markdown. Otherwise, falls through to
 * default paste behavior.
 */
/**
 * Paste handler logic, extracted from the CodeMirror extension so it can be
 * unit-tested with the platform mocked (see imagePaste.handler.test.ts). Returns
 * true if it took over the paste, false to fall through to the default handler.
 */
export function handlePasteEvent(event: ClipboardEvent, view: EditorView): boolean {
  const clipboardData = event.clipboardData;
  if (!clipboardData) return false;

  // Only handle if the platform supports saving image bytes
  let fs: ReturnType<typeof getFS>;
  try {
    fs = getFS();
  } catch {
    return false;
  }

  if (!fs.saveImageBytes) return false;

  const saveImageBytes = fs.saveImageBytes.bind(fs);
  const getImageUrl = fs.getImageUrl.bind(fs);

  const imageFile = getImageFile(clipboardData);
  if (imageFile) {
    event.preventDefault();
    void pasteImageIntoView(view, imageFile, { saveImageBytes, getImageUrl });
    return true;
  }

  // WebKitGTK on Wayland hides clipboard image targets from the JS paste event
  // (empty items for a screenshot, a lone text/html <img> for a browser "Copy
  // Image") while the OS clipboard still holds the bitmap. Read it natively.
  if (isTauri && looksLikeImagePaste(clipboardData)) {
    event.preventDefault();
    void pasteFromNativeClipboard(view, { saveImageBytes, getImageUrl }).catch((err) => {
      console.error('Native clipboard image paste failed:', err);
    });
    return true;
  }

  return false;
}

export const imagePasteHandler = EditorView.domEventHandlers({ paste: handlePasteEvent });
