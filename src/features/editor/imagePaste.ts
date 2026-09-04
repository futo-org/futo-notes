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

/**
 * The subset of `PlatformFS` the editor's image entry points need.
 *
 * All four of them — clipboard paste, the `/image` picker, an OS file drop that
 * arrives as bytes, and one that arrives as a path — end at the same two
 * questions: write these bytes into the vault, and what URL renders the file
 * that came back. They resolve that FS through one function so a new entry
 * point cannot quietly grow a second, differently-gated copy of it.
 */
export type VaultImageFs = {
  /** Copy a file the user already has on disk into the vault. */
  saveImage: (sourcePath: string) => Promise<string>;
  saveImageBytes: (data: ArrayBuffer, ext: string) => Promise<string>;
  getImageUrl: (filename: string) => Promise<string>;
  pasteClipboardImage?: () => Promise<string>;
  /** Opens the host's file picker. Absent where there is no picker. */
  pickImage?: () => Promise<string | null>;
};

/**
 * The vault-writing FS for this host, with its methods bound, or null where
 * images cannot be written at all (a plain browser: `pnpm run dev`, Playwright,
 * the factory judge — `web.ts` has no `saveImageBytes` and its `getImageUrl`
 * throws). Every image entry point resolves it through here.
 *
 * `saveImageBytes` is the gate rather than `saveImage`, which every `PlatformFS`
 * declares: on the web fallback `saveImage` exists and throws, so its presence
 * says nothing about whether this host has a vault to write to.
 */
export function resolveVaultImageFs(): VaultImageFs | null {
  let fs: ReturnType<typeof getFS>;
  try {
    fs = getFS();
  } catch {
    return null;
  }
  if (!fs.saveImageBytes) return null;
  return {
    saveImage: fs.saveImage.bind(fs),
    saveImageBytes: fs.saveImageBytes.bind(fs),
    getImageUrl: fs.getImageUrl.bind(fs),
    pasteClipboardImage: fs.pasteClipboardImage?.bind(fs),
    pickImage: fs.pickImage?.bind(fs),
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
