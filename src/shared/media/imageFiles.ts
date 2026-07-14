import { IMAGE_EXTENSIONS } from '@futo-notes/shared';

const ALLOWED_IMAGE_EXTENSIONS = new Set<string>(IMAGE_EXTENSIONS);

const MAX_EXTENSION_LENGTH = 10;

export function isImageFilename(filename: string): boolean {
  const separator = filename.lastIndexOf('.');
  if (separator < 0) return false;
  const extension = filename.slice(separator + 1);
  return extension.length > 0 && ALLOWED_IMAGE_EXTENSIONS.has(extension.toLowerCase());
}

export function validateImageExtension(extension: string): string {
  const candidate = extension.startsWith('.') ? extension.slice(1) : extension;
  if (candidate.length > MAX_EXTENSION_LENGTH) throw new Error('image extension too long');
  if (
    candidate.includes('/') ||
    candidate.includes('\\') ||
    candidate.includes('..') ||
    candidate.includes('\0')
  ) {
    throw new Error('image extension contains invalid characters');
  }

  const normalized = candidate.toLowerCase();
  if (!ALLOWED_IMAGE_EXTENSIONS.has(normalized)) {
    throw new Error(`disallowed image extension: ${normalized}`);
  }
  return normalized;
}

export function createImageFilename(extension: string): string {
  const normalized = validateImageExtension(extension);
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `image-${Date.now()}-${suffix}.${normalized}`;
}
