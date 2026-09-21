/*
 * Where a pasted image goes — the capture half of image paste, shared by both
 * editor engines.
 *
 * Two hosts capture a pasted image two different ways, so the difference is a
 * SINK, chosen once per host rather than branched on at every paste:
 *
 *   - Native shells (iOS/Android WebView) have no filesystem. The bytes go out
 *     over the bridge (`saveImageData`), the host writes them into the vault
 *     and calls `FutoEditor.insertImage(filename)` back — so the sink inserts
 *     nothing itself and returns null. iOS's WKWebView also hides a clipboard
 *     bitmap from the JS paste event entirely, which is what the payload-less
 *     `pasteClipboardImage` message exists for (bridge contract v5).
 *   - Tauri desktop writes the bytes through `PlatformFS` itself and inserts
 *     the filename it gets back. Linux/WebKitGTK hides a screenshot from the
 *     paste event the same way iOS does, so the `fs_paste_clipboard_image`
 *     command reads it off the OS clipboard.
 *
 * WHICH pastes count as an image is not decided here — `classifyImagePaste` in
 * `./imagePaste.ts` owns that, for both engines.
 *
 * Consumers: the Milkdown editor installs `createImagePasteHandler` as
 * ProseMirror's `handlePaste` prop and inserts the filename itself
 * (`milkdown/MilkdownEditor.svelte`); the CodeMirror editor inside a native
 * Reached from the editor's own ProseMirror `handlePaste` prop
 * (MilkdownEditor.svelte) on every platform.
 */
import {
  hasNativeBridgeHost,
  postToHost,
  type FutoEditorOutboundMessage,
} from '@futo-notes/editor';

import { registerVaultImageUrl } from '$features/images/vaultImageSrc';

import type { ImageInsertTarget } from './imageInsertTarget';
import {
  classifyImagePaste,
  extFromMime,
  readFileAsBase64,
  resolveVaultImageFs,
} from './imagePaste';

export interface ImagePasteSink {
  /**
   * Capture a pasted image file. Resolves to the vault filename to insert, or
   * null when the host inserts it itself (the native shells call `insertImage`
   * back over the bridge once they have written the file).
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

/** The native iOS/Android sink: bytes out over the bridge, host inserts. */
export function createBridgeImagePasteSink(
  post: (message: FutoEditorOutboundMessage) => void = postToHost,
): ImagePasteSink {
  return {
    async captureFile(file) {
      post({
        type: 'saveImageData',
        data: await readFileAsBase64(file),
        ext: extFromMime(file.type),
      });
      return null;
    },
    captureHiddenBitmap() {
      post({ type: 'pasteClipboardImage' });
      return Promise.resolve(null);
    },
    canCaptureHiddenBitmap: true,
  };
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
   * (`imageInsertTarget.ts`). Omitted where the HOST inserts: a bridge sink
   * always resolves to null and the native shell calls `FutoEditor.insertImage`
   * back over the bridge, gated by its own attachment generation.
   */
  insertImage?: ImageInsertTarget;
  reportError?: (message: string, error: unknown) => void;
}

/**
 * Returns a paste handler: true means the paste was claimed as an image and the
 * editor must not also paste it as content. The signature matches ProseMirror's
 * `handlePaste` prop, which is how the Milkdown editor installs it; a plain DOM
 * `paste` listener can call it just as well.
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
 * factory judge, `pnpm run dev`). The decision lives here rather than in
 * `MilkdownEditor.svelte` because components never branch on platform
 * (src/AGENTS.md) — the same reason `blockDragMode.ts` exists.
 *
 * A native host wins over the filesystem: the embed running inside a shell has
 * no vault access of its own, and inside the shell `getFS()` is the web
 * fallback, which cannot write anything.
 */
export function resolveImagePasteSink(): ImagePasteSink | null {
  if (hasNativeBridgeHost()) return createBridgeImagePasteSink();

  const fs = resolveVaultImageFs();
  if (!fs) return null;

  return createVaultFsImagePasteSink({
    saveImageBytes: fs.saveImageBytes,
    getImageUrl: fs.getImageUrl,
    readClipboardImage: fs.pasteClipboardImage,
  });
}
