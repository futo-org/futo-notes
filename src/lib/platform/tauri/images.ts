import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { readFile, writeFile } from '@tauri-apps/plugin-fs';
import { IMAGE_EXTENSIONS } from '@futo-notes/editor';

import {
  createImageFilename,
  isImageFilename,
  validateImageExtension,
} from '$shared/media/imageFiles';

import { ensureSafeRelativePath } from '../pathSafety';
import type { PickedImage, PlatformFS } from '../types';

type TauriImages = Pick<
  PlatformFS,
  'saveImageBytes' | 'saveImagePath' | 'getImageUrl' | 'pickImages' | 'pasteClipboardImage'
>;

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

function extensionOf(path: string): string {
  const basename = path.split(/[\\/]/).pop() ?? '';
  const dot = basename.lastIndexOf('.');
  return dot > 0 ? basename.slice(dot + 1) : 'jpg';
}

/** Images live wherever the note that shows them does, so the path may name a
 * folder (`trip/photo.png`) — it just may not leave the vault. */
function validateImagePath(path: string): void {
  if (!isImageFilename(path)) throw new Error('not an image filename');
  ensureSafeRelativePath(path);
}

export function createTauriImages({ getNotesRoot }: TauriImageDependencies): TauriImages {
  let assetProtocolCapability: Promise<boolean> | null = null;

  function canUseAssetProtocol(assetUrl: string): Promise<boolean> {
    assetProtocolCapability ??= canDecodeImageUrl(assetUrl);
    return assetProtocolCapability;
  }

  async function saveImageBytes(data: ArrayBuffer, extension: string): Promise<string> {
    const filename = createImageFilename(extension);
    await writeFile(`${await getNotesRoot()}/${filename}`, new Uint8Array(data));
    return filename;
  }

  return {
    saveImageBytes,

    async getImageUrl(filename) {
      validateImagePath(filename);
      const path = `${await getNotesRoot()}/${filename}`;
      const assetUrl = convertFileSrc(path);
      if (await canUseAssetProtocol(assetUrl)) return assetUrl;

      const extension = filename.split('.').pop() ?? 'png';
      const bytes = await readFile(path);
      return URL.createObjectURL(
        new Blob([new Uint8Array(bytes)], { type: imageMimeForExtension(extension) }),
      );
    },

    async saveImagePath(sourcePath) {
      const extension = validateImageExtension(extensionOf(sourcePath));
      const bytes = await readFile(sourcePath);
      return saveImageBytes(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        extension,
      );
    },

    pasteClipboardImage() {
      return invoke<string>('fs_paste_clipboard_image');
    },

    async pickImages(options) {
      const limit = Math.max(1, options.limit ?? 1);
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({
        multiple: limit > 1,
        filters: [{ name: options.filterName, extensions: [...IMAGE_EXTENSIONS] }],
      });
      const paths = typeof picked === 'string' ? [picked] : (picked ?? []);
      const images: PickedImage[] = [];
      for (const path of paths.slice(0, limit)) {
        const extension = validateImageExtension(extensionOf(path));
        const bytes = await readFile(path);
        images.push({
          bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
          extension,
        });
      }
      return images;
    },
  };
}
