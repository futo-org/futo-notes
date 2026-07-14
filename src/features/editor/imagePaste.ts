import { EditorView } from '@codemirror/view';
import { getFS, isTauri } from '$lib/platform';
import { registerLocalImageUrl } from './liveMarkdownTransform';

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

export function looksLikeImagePaste(
  clipboardData: Pick<DataTransfer, 'types' | 'items' | 'getData'>,
): boolean {
  const types = Array.from(clipboardData.types);
  if (types.includes('text/plain')) return false;
  if (clipboardData.items.length === 0) return true;
  if (types.some((t) => t.startsWith('image/'))) return true;
  if (types.includes('text/html')) return /<img\b/i.test(clipboardData.getData('text/html'));
  return false;
}

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

export function handlePasteEvent(event: ClipboardEvent, view: EditorView): boolean {
  const clipboardData = event.clipboardData;
  if (!clipboardData) return false;

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
