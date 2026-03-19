import { deleteImageFileRust } from './rustCore';
import { markLocalDeleteForSync } from './syncState';

export async function deleteImage(filename: string): Promise<void> {
  await deleteImageFileRust(filename);
  await markLocalDeleteForSync(filename);
}
