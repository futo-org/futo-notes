/*
 * Where a pasted image goes — the capture half of image paste.
 *
 * Tauri desktop writes the bytes through `PlatformFS` and inserts the filename
 * it gets back. Linux/WebKitGTK hides a screenshot from the paste event, so the
 * `fs_paste_clipboard_image` command reads it off the OS clipboard. A host that
 * cannot write image bytes (a plain browser) has no sink.
 *
 * WHICH pastes count as an image is not decided here — `classifyImagePaste` in
 * `./imagePaste.ts` owns that.
 *
 * The desktop editor installs `createImagePasteHandler` on its `paste` event
 * (`desktop/imageInput.ts`) and inserts the filename itself.
 */
import { registerVaultImageUrl } from '$features/images/vaultImageSrc';

import type { ImageInsertTarget } from './imageInsertTarget';
import { classifyImagePaste, extFromMime, resolveVaultImageFs } from './imagePaste';

export interface ImagePasteSink {
  /**
   * Capture a pasted image file. Resolves to the vault filename to insert, or
   * null when there is nothing to insert.
   */
  captureFile(file: File): Promise<string | null>;
  /**
   * Capture a clipboard bitmap the paste event never exposed as a file. Same
   * return contract as {@link captureFile}.
   */
  captureHiddenBitmap(): Promise<string | null>;
  /**
   * Whether this host can recover a hidden bitmap at all. When it cannot, such
   * a paste is left alone rather than swallowed — suppressing the default paste
   * for something we then fail to insert would lose the user's clipboard.
   */
  readonly canCaptureHiddenBitmap: boolean;
}

export interface VaultFsImagePasteDeps {
  saveImageBytes: (data: ArrayBuffer, ext: string) => Promise<string>;
  getImageUrl: (filename: string) => Promise<string>;
  /** Reads a bitmap off the OS clipboard into the vault; absent off desktop. */
  readClipboardImage?: () => Promise<string>;
}

/** The Tauri desktop sink: write into the vault here, insert the filename. */
export function createVaultFsImagePasteSink(deps: VaultFsImagePasteDeps): ImagePasteSink {
  async function register(filename: string): Promise<string> {
    registerVaultImageUrl(filename, await deps.getImageUrl(filename));
    return filename;
  }

  const { readClipboardImage } = deps;
  return {
    async captureFile(file) {
      return register(await deps.saveImageBytes(await file.arrayBuffer(), extFromMime(file.type)));
    },
    async captureHiddenBitmap() {
      if (!readClipboardImage) return null;
      return register(await readClipboardImage());
    },
    canCaptureHiddenBitmap: Boolean(readClipboardImage),
  };
}

interface ImagePasteHandlerOptions {
  /** Null when this host cannot capture images at all (a plain browser). */
  sink: ImagePasteSink | null;
  /**
   * Where the captured filename goes — the note that was open when the paste
   * happened, not whichever one the editor holds when the bytes land
   * (`imageInsertTarget.ts`).
   */
  insertImage?: ImageInsertTarget;
  reportError?: (message: string, error: unknown) => void;
}

/**
 * Returns a paste handler: true means the paste was claimed as an image and the
 * editor must not also paste it as content. A `paste` listener calls it.
 *
 * The claim is made SYNCHRONOUSLY — capture is async, and a paste event cannot
 * be prevented after the fact.
 */
export function createImagePasteHandler(
  options: ImagePasteHandlerOptions,
): (event: ClipboardEvent) => boolean {
  const { sink, insertImage, reportError = console.error } = options;

  /**
   * `complete` is claimed by the CALLER, synchronously inside the paste event —
   * the document the user pasted into is the one that was live then, not the
   * one still live whenever the capture resolves.
   */
  function capture(complete: ((filename: string) => void) | null, work: Promise<string | null>) {
    void work
      .then((filename) => {
        if (filename) complete?.(filename);
      })
      .catch((error: unknown) => reportError('Image paste failed:', error));
  }

  return (event: ClipboardEvent): boolean => {
    if (!sink) return false;
    const clipboardData = event.clipboardData;
    if (!clipboardData) return false;

    const action = classifyImagePaste(clipboardData);
    if (action.kind === 'file') {
      event.preventDefault();
      capture(insertImage?.begin() ?? null, sink.captureFile(action.file));
      return true;
    }
    if (action.kind === 'hiddenBitmap' && sink.canCaptureHiddenBitmap) {
      event.preventDefault();
      capture(insertImage?.begin() ?? null, sink.captureHiddenBitmap());
      return true;
    }
    return false;
  };
}

/**
 * The sink for whichever host this editor is running in, or null when none can
 * capture an image (a plain browser: Playwright without a fake host, the
 * factory judge, `pnpm run dev`). The decision lives here rather than in the
 * editor component because components never branch on platform (src/AGENTS.md).
 */
export function resolveImagePasteSink(): ImagePasteSink | null {
  const fs = resolveVaultImageFs();
  if (!fs) return null;

  return createVaultFsImagePasteSink({
    saveImageBytes: fs.saveImageBytes,
    getImageUrl: fs.getImageUrl,
    readClipboardImage: fs.pasteClipboardImage,
  });
}
