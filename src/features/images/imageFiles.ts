import { getFS } from '$lib/platform';
import { isImageFilename } from '$shared/media/imageFiles';

export interface ImageFileEntry {
  filename: string;
  size: number;
  mtime: number;
}

export async function listImageFiles(): Promise<ImageFileEntry[]> {
  const files = await getFS().listDirFiles();
  return files
    .filter((file) => isImageFilename(file.name))
    .map((file) => ({ filename: file.name, size: file.size, mtime: file.mtime }))
    .sort((left, right) => right.mtime - left.mtime);
}

export async function deleteImage(filename: string): Promise<void> {
  if (!isImageFilename(filename)) throw new Error('not an image filename');
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    throw new Error('invalid filename');
  }
  await getFS().deleteFile(filename);
}

export async function getImageWebPath(filename: string): Promise<string> {
  return getFS().getImageUrl(filename);
}
