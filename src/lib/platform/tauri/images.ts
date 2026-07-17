import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { readFile, writeFile } from '@tauri-apps/plugin-fs';
import { IMAGE_EXTENSIONS } from '@futo-notes/editor';

import { createImageFilename, isImageFilename } from '$shared/media/imageFiles';

import type { PlatformFS } from '../types';

type TauriImages = Pick<PlatformFS, 'saveImage' | 'saveImageBytes' | 'getImageUrl' | 'pickImage'>;

interface TauriImageDependencies {
  getNotesRoot: () => Promise<string>;
}

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

async function canDecodeImageUrl(url: string): Promise<boolean> {
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

function validateImageFilename(filename: string): void {
  if (!isImageFilename(filename)) throw new Error('not an image filename');
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    throw new Error('invalid filename');
  }
}

export function createTauriImages({ getNotesRoot }: TauriImageDependencies): TauriImages {
  let assetProtocolCapability: Promise<boolean> | null = null;

  function canUseAssetProtocol(assetUrl: string): Promise<boolean> {
    assetProtocolCapability ??= canDecodeImageUrl(assetUrl);
    return assetProtocolCapability;
  }

  return {
    saveImage(sourcePath) {
      return invoke<string>('fs_save_image', { sourcePath });
    },

    async saveImageBytes(data, extension) {
      const filename = createImageFilename(extension);
      await writeFile(`${await getNotesRoot()}/${filename}`, new Uint8Array(data));
      return filename;
    },

    async getImageUrl(filename) {
      validateImageFilename(filename);
      const path = `${await getNotesRoot()}/${filename}`;
      const assetUrl = convertFileSrc(path);
      if (await canUseAssetProtocol(assetUrl)) return assetUrl;

      const extension = filename.split('.').pop() ?? 'png';
      const bytes = await readFile(path);
      return URL.createObjectURL(
        new Blob([new Uint8Array(bytes)], { type: imageMimeForExtension(extension) }),
      );
    },

    async pickImage() {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({
        multiple: false,
        filters: [{ name: 'Images', extensions: [...IMAGE_EXTENSIONS] }],
      });
      return typeof picked === 'string' ? picked : null;
    },
  };
}
