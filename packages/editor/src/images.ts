/** Image extensions accepted by the editor and note vault. */
export const IMAGE_EXTENSIONS = [
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
] as const;

const IMAGE_EXTENSION_SET = new Set<string>(IMAGE_EXTENSIONS);

/** Check whether a filename has an accepted image extension. */
export function isImageFilename(filename: string): boolean {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return false;
  return IMAGE_EXTENSION_SET.has(filename.slice(dot + 1).toLowerCase());
}
