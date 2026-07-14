const IMAGE_MIME_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  heic: 'image/heic',
};

export function imageMimeForExtension(extension: string): string {
  return IMAGE_MIME_TYPES[extension.toLowerCase()] ?? 'image/png';
}

export async function canDecodeImageUrl(url: string): Promise<boolean> {
  if (typeof Image !== 'function') return false;

  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('asset decode failed'));
      image.src = url;
    });
    return image.naturalWidth > 0;
  } catch {
    return false;
  }
}
