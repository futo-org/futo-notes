import { EditorView } from '@codemirror/view';
import { imageReferenceMarkdown } from '@futo-notes/editor';
import { getFS } from '$lib/platform';
import { registerVaultImageUrl } from '$features/images/vaultImageSrc';

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

/** The subset of `PlatformFS` an image capture needs. */
export type ImagePasteFS = {
  saveImageBytes: (data: ArrayBuffer, ext: string) => Promise<string>;
  getImageUrl: (filename: string) => Promise<string>;
  pasteClipboardImage?: () => Promise<string>;
};

/**
 * The vault-writing FS for this host, with its methods bound, or null where
 * images cannot be written at all (a plain browser: `pnpm run dev`, Playwright,
 * the factory judge — `web.ts` has no `saveImageBytes` and its `getImageUrl`
 * throws). Both engines' paste paths resolve it through here.
 */
export function resolveImagePasteFs(): ImagePasteFS | null {
  let fs: ReturnType<typeof getFS>;
  try {
    fs = getFS();
  } catch {
    return null;
  }
  if (!fs.saveImageBytes) return null;
  return {
    saveImageBytes: fs.saveImageBytes.bind(fs),
    getImageUrl: fs.getImageUrl.bind(fs),
    pasteClipboardImage: fs.pasteClipboardImage?.bind(fs),
  };
}

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

/**
 * What a clipboard paste carries, image-wise. Both editor engines classify a
 * paste through this one function so the two paste handlers cannot drift on
 * WHICH pastes count as an image (`installNativeImagePaste.ts` for CodeMirror,
 * `milkdown/imagePasteSink.ts` for Milkdown) — only on how they capture it.
 */
export type ImagePasteAction =
  { kind: 'file'; file: File } | { kind: 'hiddenBitmap' } | { kind: 'none' };

export function classifyImagePaste(
  clipboardData: Pick<DataTransfer, 'types' | 'items' | 'getData'>,
): ImagePasteAction {
  const file = getImageFile(clipboardData as DataTransfer);
  if (file) return { kind: 'file', file };
  if (looksLikeImagePaste(clipboardData)) return { kind: 'hiddenBitmap' };
  return { kind: 'none' };
}

/** Base64 of a file's bytes, as the `saveImageData` bridge message carries it. */
export function readFileAsBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('image read failed'));
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('image read produced no data URL'));
        return;
      }
      const comma = reader.result.indexOf(',');
      resolve(comma >= 0 ? reader.result.slice(comma + 1) : reader.result);
    };
    reader.readAsDataURL(file);
  });
}

async function saveAndInsert(
  view: Pick<EditorView, 'state' | 'dispatch' | 'focus'>,
  buffer: ArrayBuffer,
  ext: string,
  fs: ImagePasteFS,
): Promise<void> {
  const filename = await fs.saveImageBytes(buffer, ext);
  const webUrl = await fs.getImageUrl(filename);
  registerVaultImageUrl(filename, webUrl);

  const pos = view.state.selection.main.head;
  const insert = imageReferenceMarkdown(filename);
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
  if (!fs.pasteClipboardImage) return;
  const filename = await fs.pasteClipboardImage();
  const webUrl = await fs.getImageUrl(filename);
  registerVaultImageUrl(filename, webUrl);

  const pos = view.state.selection.main.head;
  const insert = imageReferenceMarkdown(filename);
  view.dispatch({
    changes: { from: pos, insert },
    selection: { anchor: pos + insert.length },
  });
  view.focus();
}

export function handlePasteEvent(event: ClipboardEvent, view: EditorView): boolean {
  const clipboardData = event.clipboardData;
  if (!clipboardData) return false;

  const fs = resolveImagePasteFs();
  if (!fs) return false;

  /* The SAME decision the Milkdown editor makes (milkdown/vaultImageView.ts's
   * sibling, imagePasteSink.ts) — only the capture and the insert differ. */
  const action = classifyImagePaste(clipboardData);

  if (action.kind === 'file') {
    event.preventDefault();
    void pasteImageIntoView(view, action.file, fs);
    return true;
  }

  /* A bitmap the paste event never exposed. Gated on the CAPABILITY rather than
   * on `isTauri`: only the Tauri adapter has `pasteClipboardImage`, and
   * suppressing the default paste for something we then cannot insert would
   * lose the user's clipboard. */
  if (action.kind === 'hiddenBitmap' && fs.pasteClipboardImage) {
    event.preventDefault();
    void pasteFromNativeClipboard(view, fs).catch((err) => {
      console.error('Native clipboard image paste failed:', err);
    });
    return true;
  }

  return false;
}

export const imagePasteHandler = EditorView.domEventHandlers({ paste: handlePasteEvent });
