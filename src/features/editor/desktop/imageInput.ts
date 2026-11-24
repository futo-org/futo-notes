/* Images pasted, dropped or picked into the note (docs/spec/editor/desktop/paste.md, the `/`
 * menu's Image in slash-menu.md): the shared image doors (imagePasteSink.ts for the clipboard,
 * imageInsert.ts for a drop or the file picker) save the file into the vault through
 * PlatformFS, and the engine writes its reference where the claim taken at the paste, drop or
 * pick says (imageClaimTarget.ts). Nothing shows while the file saves. */
import { deleteImage } from '$features/images/imageFiles';
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
import { createImageClaimTarget } from './imageClaimTarget';
import { scrollerOf } from './paneScroll';
import type { EditorView } from './view';

/** Whether a drag carries files from the OS: WebKit and WebView2 name them `Files`, and
 *  WebKitGTK advertises `text/uri-list` with no files (imageInsert.ts `filePathsFromDrop`). */
function dragCarriesOsFiles(transfer: DataTransfer | null): boolean {
  const types = Array.from(transfer?.types ?? []);
  return types.includes('Files') || types.includes('text/uri-list');
}

export class EditorImageInput {
  private readonly target: ImageInsertTarget;

  constructor(private readonly view: EditorView) {
    this.target = createImageClaimTarget({ view, discard: deleteImage });
  }

  /** A paste carrying an image: true when it is claimed, so the text paste does not run. An
   *  image file wins over text beside it; a bitmap the event hides is read off the OS clipboard
   *  only when no plain text came with it (imagePaste.ts `classifyImagePaste`). */
  paste(event: ClipboardEvent): boolean {
    if (!this.editable()) return false;
    const claim = createImagePasteHandler({
      sink: resolveImagePasteSink(),
      insertImage: this.target,
    });
    return claim(event);
  }

  /** An OS file drag over the note may drop here: the window's guard refuses it everywhere
   *  else (externalFileDropGuard.ts), so it goes no further. */
  dragOver(event: DragEvent): void {
    if (!dragCarriesOsFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = this.editable() ? 'copy' : 'none';
  }

  /** A file drop is always claimed, so the webview never opens the file in place of the app;
   *  its images land at the drop point, in the order dropped, and anything else is ignored. */
  drop(event: DragEvent): void {
    const transfer = event.dataTransfer;
    if (dropCarriesFiles(transfer)) {
      event.preventDefault();
      const images = imageFilesIn(transfer);
      if (images.length === 0 || !this.placeCaret(event.clientX, event.clientY)) return;
      void resolveImageInserter(this.target).insertFiles(images);
      return;
    }
    const paths = filePathsFromDrop(transfer);
    if (paths.length === 0) return;
    event.preventDefault();
    this.dropPaths(paths, event.clientX, event.clientY);
  }

  /** The window's own drop event (a webview still running its native drop layer): only the
   *  drops on the note are the editor's. Returns the unsubscribe. */
  listenForWindowDrops(): () => void {
    return onFileDrop(({ paths, x, y }) => {
      const box = this.view.dom.getBoundingClientRect();
      if (x < box.left || x > box.right || y < box.top || y > box.bottom) return;
      this.dropPaths(paths, x, y);
    });
  }

  /** Open the host's image picker and write the picked file at the caret; `paths` answers the
   *  picker without its dialog (Puppet). Nothing without a picker or a note to edit. */
  pick(paths?: readonly string[]): void {
    if (!this.editable()) return;
    void resolveImageInserter(this.target).pick(paths);
  }

  private dropPaths(paths: readonly string[], x: number, y: number): void {
    const images = imagePathsIn(paths);
    if (images.length === 0 || !this.placeCaret(x, y)) return;
    void resolveImageInserter(this.target).insertPaths(images);
  }

  /** The caret where a press at viewport `x`, `y` would put it; false with no note to edit. */
  private placeCaret(x: number, y: number): boolean {
    const view = this.view;
    if (!this.editable() || !view.lineModel()) return false;
    const hit = view.hitTest.offsetAt(x, y, scrollerOf(view.dom), true);
    view.focus(false);
    return view.selection.selectRange(hit.offset, hit.offset);
  }

  /** A note is open and not read-only (view.ts `setReadonly`). */
  private editable(): boolean {
    return this.view.dom.contentEditable === 'true';
  }
}
