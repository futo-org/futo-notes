import { EditorView } from '@codemirror/view';
import { getFS, isTauri } from '$lib/platform';
import { registerLocalImageUrl } from '$lib/liveMarkdownTransform';

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/bmp', 'image/avif', 'image/heic'];

function getImageFile(clipboardData: DataTransfer): File | null {
  for (let i = 0; i < clipboardData.items.length; i++) {
    const item = clipboardData.items[i];
    if (item.kind === 'file' && IMAGE_TYPES.includes(item.type)) {
      return item.getAsFile();
    }
  }
  return null;
}

function extFromMime(mime: string): string {
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
export const imagePasteHandler = EditorView.domEventHandlers({
  paste: (event, view) => {
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

    // WebKitGTK on Wayland returns empty clipboardData for images.
    // Fall back to the Tauri native clipboard plugin.
    if (isTauri && clipboardData.items.length === 0) {
      event.preventDefault();
      void pasteFromNativeClipboard(view, { saveImageBytes, getImageUrl }).catch((err) => {
        console.error('Native clipboard image paste failed:', err);
      });
      return true;
    }

    return false;
  }
});
