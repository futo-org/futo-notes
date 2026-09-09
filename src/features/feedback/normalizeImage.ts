import type { PickedImage } from '$lib/platform/types';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const JPEG_QUALITY = 0.95;

const SERVER_ACCEPTED_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp']);

export function needsTranscode(extension: string, byteLength: number): boolean {
  return !SERVER_ACCEPTED_EXTENSIONS.has(extension.toLowerCase()) || byteLength > MAX_IMAGE_BYTES;
}

export class ImageTooLargeError extends Error {
  constructor() {
    super('That screenshot is still over 5 MB after compressing. Try a smaller one.');
    this.name = 'ImageTooLargeError';
  }
}

async function transcodeToJpeg(bytes: ArrayBuffer): Promise<ArrayBuffer> {
  const bitmap = await createImageBitmap(new Blob([bytes]));
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no 2d context');
    context.drawImage(bitmap, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
    return await blob.arrayBuffer();
  } finally {
    bitmap.close();
  }
}

export async function normalizeFeedbackImage(picked: PickedImage): Promise<ArrayBuffer> {
  if (!needsTranscode(picked.extension, picked.bytes.byteLength)) return picked.bytes;

  const transcoded = await transcodeToJpeg(picked.bytes);
  if (transcoded.byteLength > MAX_IMAGE_BYTES) {
    throw new ImageTooLargeError();
  }
  return transcoded;
}
