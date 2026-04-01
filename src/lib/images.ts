import { deleteImageFileRust } from './rustCore';

export async function deleteImage(filename: string): Promise<void> {
  await deleteImageFileRust(filename);
}
