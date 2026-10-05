import { getPlatformFS } from '$lib/platform';
import { isImageFilename } from '$shared/media/imageFiles';

export interface ImageFileEntry {
  /** Vault-relative path — `photo.png` at the top level, `trip/photo.png` in a folder. */
  filename: string;
  size: number;
  mtime: number;
}

// `getPlatformFS()` rather than the synchronous `getFS()`: the sidebar restores
// whichever tab was last open, so this can run before bootstrap has resolved the
// platform — and the images tab then sat on "No images" until you switched tabs
// and back.
export async function listImageFiles(): Promise<ImageFileEntry[]> {
  const files = await (await getPlatformFS()).listVaultFiles(isImageFilename);
  return files
    .map((file) => ({ filename: file.name, size: file.size, mtime: file.mtime }))
    .sort((left, right) => right.mtime - left.mtime);
}

export async function deleteImage(filename: string): Promise<void> {
  if (!isImageFilename(filename)) throw new Error('not an image filename');
  await (await getPlatformFS()).deleteFile(filename);
}

export async function getImageWebPath(filename: string): Promise<string> {
  return (await getPlatformFS()).getImageUrl(filename);
}
