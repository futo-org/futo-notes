import { getFS } from './platform';

export function saveImageFile(sourcePath: string): Promise<string> {
  return getFS().saveImage(sourcePath);
}

export function getImageWebPath(filename: string): Promise<string> {
  return getFS().getImageUrl(filename);
}
