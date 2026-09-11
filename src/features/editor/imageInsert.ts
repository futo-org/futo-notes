/*
 * Getting an image into the note from somewhere OTHER than the clipboard — the
 * desktop `/image` file picker and an OS file drop.
 *
 * Clipboard paste has its own module (`imagePasteSink.ts`) because a paste has
 * to be CLAIMED synchronously, inside the event, or the editor also pastes it
 * as content. Nothing here is racing an event: the picker and the drop both
 * hand over a finished list of images, so this is the plain half — write it
 * into the vault, register the URL, insert the reference — and both entry
 * points share it rather than each carrying a copy.
 *
 * Two shapes can arrive, and the difference is not a platform branch — it is
 * what the OS handed us:
 *
 *   - FILES (`insertFiles`): an HTML5 `drop`, where the webview already read
 *     the bytes. This is what macOS, Windows AND Linux now all deliver: every
 *     desktop build config sets `dragDropEnabled: false`
 *     (`tauri.macos/windows/linux.conf.json`), so wry installs no native drop
 *     target on any of the three and each webview's own DOM drop handles it.
 *     Linux used to be the exception — no `tauri.linux.conf.json` existed, so
 *     the flag sat at wry's default (`true`) and Linux relied on the PATHS
 *     shape below — until QA #017 (2026-09-11): on a native-Wayland compositor
 *     wry's own GTK-signal relay never fires a real drop at all, so a file
 *     dragged in from a file manager silently did nothing in a PACKAGED
 *     build (dev already forced the flag off everywhere, which is why the bug
 *     never showed up there).
 *   - PATHS (`insertPaths`): Tauri's own drag-drop event, which reports file
 *     paths and no bytes. Nothing currently delivers this shape for a drop —
 *     it is kept wired as a defensive fallback in case some distro/compositor
 *     combination still runs wry's native layer, exactly as inert on Linux now
 *     as it always was on macOS/Windows. It remains the picker's shape either
 *     way — `pickImage` returns a path.
 *
 * WHICH files count as images is `isImageFilename` from the shared media rules,
 * never a second list: the vault's accepted extensions are conformance-locked
 * to the canonical Rust rule (packages/editor/src/images.ts).
 */
import { registerVaultImageUrl } from '$features/images/vaultImageSrc';
import { isImageFilename } from '$shared/media/imageFiles';

import { extFromMime, resolveVaultImageFs, type VaultImageFs } from './imagePaste';

/** The last path segment, for a POSIX or a Windows path. */
function basename(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut >= 0 ? path.slice(cut + 1) : path;
}

/**
 * The extension to store a dropped or picked file under.
 *
 * The file's own name wins over its MIME type: a browser reporting
 * `image/png` for a `.webp` would otherwise rename the file's format, and the
 * name is what the user chose. `extFromMime` covers the case with no usable
 * name at all — a clipboard file, which arrives as `image.png` or bare.
 */
export function imageExtensionFor(file: File): string {
  const name = file.name;
  if (isImageFilename(name)) return name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return extFromMime(file.type);
}

/**
 * The images among `files` — an empty list when there are none, which is how a
 * dropped `.md` or `.zip` ends up ignored rather than inserted as a picture.
 *
 * A file counts on EITHER its MIME type or its name: a drop from a file manager
 * usually carries a type, and a drop from an archive or a network share often
 * carries an empty one.
 */
export function imagesAmong(files: readonly File[]): File[] {
  return files.filter((file) => file.type.startsWith('image/') || isImageFilename(file.name));
}

/** The images among the files a drop carries. */
export function imageFilesIn(transfer: DataTransfer | null | undefined): File[] {
  return transfer ? imagesAmong(Array.from(transfer.files)) : [];
}

/** The same rule for the path list Tauri's drag-drop event reports. */
export function imagePathsIn(paths: readonly string[]): string[] {
  return paths.filter((path) => isImageFilename(basename(path)));
}

/**
 * Whether a drop came from OUTSIDE the app.
 *
 * The editor's own block drag is a drop too, and it must keep working: it
 * carries no `files`, so the file list is the discriminator rather than
 * anything the drag source has to remember to set.
 */
export function dropCarriesFiles(transfer: DataTransfer | null | undefined): boolean {
  return Boolean(transfer && transfer.files.length > 0);
}

export interface ImageInserter {
  /** Open the host's picker and insert whatever comes back. */
  pick(): Promise<void>;
  /** Insert every image among `files`; non-images are ignored. */
  insertFiles(files: readonly File[]): Promise<void>;
  /** Insert every image among `paths`; non-images are ignored. */
  insertPaths(paths: readonly string[]): Promise<void>;
  /**
   * Whether this host has a picker at all. False in a plain browser and on the
   * native shells, whose Image button is the toolbar's `pickImage` bridge
   * message instead.
   */
  readonly canPick: boolean;
}

export interface ImageInserterOptions {
  /** Null where this host cannot write into a vault (a plain browser). */
  fs: VaultImageFs | null;
  /** How the editor puts a vault filename into the document. */
  insert: (filename: string) => void;
  reportError?: (message: string, error: unknown) => void;
}

export function createImageInserter(options: ImageInserterOptions): ImageInserter {
  const { fs, insert, reportError = console.error } = options;

  /**
   * Save through `save`, then insert what came back.
   *
   * The URL is registered BEFORE the insert so the node view resolves on its
   * first render instead of flashing empty — the same order the paste sink
   * uses. A URL that will not resolve is not a reason to drop the image: the
   * bytes are already in the vault, and `vaultImageView.ts` re-asks on a later
   * render (docs/spec/editor.md, "Images").
   */
  async function saveAndInsert(save: () => Promise<string>): Promise<void> {
    const filename = await save();
    try {
      registerVaultImageUrl(filename, await fs!.getImageUrl(filename));
    } catch (error) {
      reportError('Image URL could not be resolved yet:', error);
    }
    insert(filename);
  }

  /** One image's failure must not take the rest of the drop with it. */
  async function insertEach<T>(items: readonly T[], save: (item: T) => Promise<string>) {
    if (!fs) return;
    for (const item of items) {
      try {
        await saveAndInsert(() => save(item));
      } catch (error) {
        reportError('Image insert failed:', error);
      }
    }
  }

  return {
    canPick: Boolean(fs?.pickImage),

    async pick() {
      const pickImage = fs?.pickImage;
      if (!fs || !pickImage) return;
      try {
        const path = await pickImage();
        if (path) await saveAndInsert(() => fs.saveImage(path));
      } catch (error) {
        reportError('Image insert failed:', error);
      }
    },

    insertFiles(files) {
      return insertEach(imagesAmong(files), async (file) =>
        fs!.saveImageBytes(await file.arrayBuffer(), imageExtensionFor(file)),
      );
    },

    insertPaths(paths) {
      return insertEach(imagePathsIn(paths), (path) => fs!.saveImage(path));
    },
  };
}

/**
 * The inserter for whichever host this editor is running in.
 *
 * Resolved here rather than in `MilkdownEditor.svelte` because components never
 * branch on platform (src/AGENTS.md) — the same reason `resolveImagePasteSink`
 * and `blockDragMode.ts` exist.
 */
export function resolveImageInserter(
  insert: (filename: string) => void,
  reportError?: (message: string, error: unknown) => void,
): ImageInserter {
  return createImageInserter({ fs: resolveVaultImageFs(), insert, reportError });
}
