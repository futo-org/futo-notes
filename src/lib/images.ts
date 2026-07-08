import { getFS } from './platform';

// ── Constants ──────────────────────────────────────────────

const ALLOWED_IMAGE_EXTS = new Set([
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'svg',
  'bmp',
  'ico',
  'avif',
  'heic',
]);

const MAX_EXT_LENGTH = 10;

// ── Types ──────────────────────────────────────────────────

export interface ImageFileEntry {
  filename: string;
  size: number;
  mtime: number;
}

// ── Pure validation helpers ────────────────────────────────

/** Check if a filename has an allowed image extension (case-insensitive). */
export function isImageFilename(filename: string): boolean {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return false;
  const ext = filename.slice(dot + 1);
  if (ext.length === 0) return false;
  return ALLOWED_IMAGE_EXTS.has(ext.toLowerCase());
}

/**
 * Validate that an extension is an allowed image type.
 * Accepts with or without leading dot. Rejects traversal attempts.
 * Returns the normalized lowercase extension (without dot).
 */
export function validateImageExt(ext: string): string {
  // Strip optional leading dot
  const raw = ext.startsWith('.') ? ext.slice(1) : ext;
  if (raw.length > MAX_EXT_LENGTH) {
    throw new Error('image extension too long');
  }
  if (raw.includes('/') || raw.includes('\\') || raw.includes('..') || raw.includes('\0')) {
    throw new Error('image extension contains invalid characters');
  }
  const lower = raw.toLowerCase();
  if (!ALLOWED_IMAGE_EXTS.has(lower)) {
    throw new Error(`disallowed image extension: ${lower}`);
  }
  return lower;
}

/** Generate a unique image filename with the given extension. */
export function generateImageFilename(ext: string): string {
  const validated = validateImageExt(ext);
  const timestamp = Date.now();
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `image-${timestamp}-${hex}.${validated}`;
}

// ── Platform-backed operations ─────────────────────────────

/** List all image files in the notes root, sorted by mtime descending. */
export async function listImageFiles(): Promise<ImageFileEntry[]> {
  const allFiles = await getFS().listDirFiles();
  const images = allFiles
    .filter((f) => isImageFilename(f.name))
    .map((f) => ({ filename: f.name, size: f.size, mtime: f.mtime }));
  images.sort((a, b) => b.mtime - a.mtime);
  return images;
}

/** Delete an image file from the notes root. Validates before deleting. */
export async function deleteImage(filename: string): Promise<void> {
  if (!isImageFilename(filename)) {
    throw new Error('not an image filename');
  }
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    throw new Error('invalid filename');
  }
  await getFS().deleteFile(filename);
}
