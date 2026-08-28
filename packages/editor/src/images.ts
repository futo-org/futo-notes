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

/**
 * The markdown an image reference is written as when the editor inserts one.
 *
 * Every insertion path — the toolbar Camera/Image picker, clipboard paste on
 * every shell, and the host's `insertImage` bridge call — produces the same
 * spelling, so a pasted image is indistinguishable on disk from a picked one.
 * The trailing newline closes the paragraph the image was dropped into.
 */
export function imageReferenceMarkdown(filename: string): string {
  return `![](${filename})\n`;
}
