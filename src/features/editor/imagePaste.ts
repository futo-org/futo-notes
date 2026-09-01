import { getFS } from '$lib/platform';

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

function getImageFile(clipboardData: DataTransfer): File | null {
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

function looksLikeImagePaste(
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
