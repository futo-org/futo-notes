import {
  installVaultImageUrlResolver,
  uninstallVaultImageUrlResolver,
} from '$features/images/vaultImageUrlResolver';
import { onFileDrop } from '$lib/platform';
import {
  dropCarriesFiles,
  filePathsFromDrop,
  imageFilesIn,
  imagePathsIn,
  resolveImageInserter,
} from '../imageInsert';
import { createImagePasteHandler, resolveImagePasteSink } from '../imagePasteSink';
import type { ImageInsertTarget } from '../imageInsertTarget';

/** The image doors the editor claims: clipboard paste and an OS file drop. */
export function createImageInput(deps: {
  imageTarget: ImageInsertTarget;
  placeCaretAtCoords: (x: number, y: number) => void;
  getContainer: () => HTMLElement | undefined;
}) {
  const { imageTarget, placeCaretAtCoords, getContainer } = deps;

  /* ---- images ------------------------------------------------------------ *
   * Vault images are bare filenames; `vaultImageView.ts` is the ProseMirror
   * node view that resolves each one against whatever this shell serves the
   * vault over, and re-resolves itself when that arrives late. Nothing here
   * touches rendered image DOM — a post-render sweep is what the node view
   * replaced (see that file's header for the three bugs it had).
   *
   * Pasting an image is `pasteHandler` below: `imagePasteSink.ts` decides how
   * THIS host captures the bytes, and this component only inserts whatever
   * filename comes back. */
  let pasteHandler: ((event: ClipboardEvent) => boolean) | null = null;
  /* Dropping an image FILE from the OS is `dropHandler` plus `stopFileDrop`
   * below — two paths for one gesture, because the two backends deliver it
   * differently and neither is a choice this component gets to make:
   *
   *   - Every desktop platform now disables wry's native drop target
   *     (`dragDropEnabled: false` — Linux joined macOS/Windows in QA #017,
   *     2026-09-11), so the drop arrives as an ordinary HTML5 `drop` —
   *     ProseMirror's `handleDrop` prop. Chromium (macOS/Windows) populates
   *     `dataTransfer.files` with the bytes already read; WebKitGTK (Linux)
   *     does NOT — first fix attempt claimed on `text/uri-list` CONTENT, but
   *     a real capture (QA #017 follow-up, 2026-09-15) showed WebKitGTK
   *     advertises `text/uri-list` in `.types` while `getData` on it returns
   *     an empty string, and the dropped path lives only in the sibling
   *     `text/html`'s `<a>` TEXT CONTENT (no `href`) — so the drop went
   *     unclaimed and the `file:///…` text was inserted literally.
   *     `filePathsFromDrop` reads that real shape now; see its own header.
   *   - The WINDOW path (`PlatformFS`'s `onFileDrop`) stays wired as a
   *     fallback: it was Linux's ONLY path while wry's GTK relay was on, and
   *     that relay never fired at all on a native-Wayland compositor.
   *
   * Both end in `imageInsert.ts`, which is also what the `/image` picker uses.
   * Off Tauri `onFileDrop` is a no-op subscription, so nothing here branches on
   * platform (src/AGENTS.md rule 4.5). */
  let dropHandler: ((event: DragEvent) => boolean) | null = null;
  let stopFileDrop: (() => void) | null = null;
  /* Only true where this editor installed the per-file URL producer (Tauri
   * desktop), so the teardown removes exactly what the mount added. */
  let ownsImageUrlResolver = false;

  return {
    getPasteHandler: () => pasteHandler,
    getDropHandler: () => dropHandler,
    /** Wires the three doors once the engine is up. */
    install(): void {
      pasteHandler = createImagePasteHandler({
        sink: resolveImagePasteSink(),
        insertImage: imageTarget,
      });

      const imageInserter = resolveImageInserter(imageTarget);

      /* The HTML5 half (macOS/Windows/Linux). A drop carrying files, OR one
       * advertising `text/uri-list` with none (WebKitGTK's shape — see the
       * `dropHandler` declaration above), is ALWAYS claimed, images or not:
       * the browser's default for an unclaimed file drop is to navigate the
       * webview to that file, which would tear the app down mid-edit. A
       * non-image file is therefore swallowed and ignored rather than
       * inserted. The editor's OWN block drag matches neither shape — it
       * never advertises `text/uri-list` — so it is never claimed here and
       * falls through to ProseMirror's own drop handling. */
      dropHandler = (event) => {
        const transfer = event.dataTransfer;
        if (dropCarriesFiles(transfer)) {
          event.preventDefault();
          const images = imageFilesIn(transfer);
          if (images.length > 0) {
            placeCaretAtCoords(event.clientX, event.clientY);
            void imageInserter.insertFiles(images);
          }
          return true;
        }
        const paths = filePathsFromDrop(transfer);
        if (paths.length > 0) {
          event.preventDefault();
          const images = imagePathsIn(paths);
          if (images.length > 0) {
            placeCaretAtCoords(event.clientX, event.clientY);
            void imageInserter.insertPaths(images);
          }
          return true;
        }
        return false;
      };

      /* The window half (Linux). It fires for a drop anywhere on the window, so
       * this editor takes only the ones that landed on IT — a drop on the
       * sidebar is not this component's business. */
      stopFileDrop = onFileDrop(({ paths, x, y }) => {
        const box = getContainer()?.getBoundingClientRect();
        if (!box) return;
        if (x < box.left || x > box.right || y < box.top || y > box.bottom) return;
        placeCaretAtCoords(x, y);
        void imageInserter.insertPaths(paths);
      });
      /* Where images resolve per file rather than off a host base URL (Tauri
       * desktop), the node views need something to ask. */
      ownsImageUrlResolver = installVaultImageUrlResolver();
    },
    /** Takes down what `install` put up. */
    dispose(): void {
      stopFileDrop?.();
      stopFileDrop = null;
      dropHandler = null;
      if (ownsImageUrlResolver) {
        uninstallVaultImageUrlResolver();
        ownsImageUrlResolver = false;
      }
    },
  };
}
