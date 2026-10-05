export interface FileChangeEvent {
  type: 'add' | 'change' | 'unlink' | 'rename';
  /** Relative path under the notes root (forward-slash separated). */
  filename: string;
  from?: string;
}

export interface DirFileEntry {
  /** Vault-relative path, forward-slash separated (e.g. `trip/photo.png`). */
  name: string;
  size: number;
  mtime: number;
}

/** A file dropped onto the window from outside the app. */
export interface FileDropEvent {
  /** Absolute paths of the dropped files. The OS gives no bytes, only paths. */
  paths: string[];
  /** Drop point in CSS pixels, relative to the webview viewport. */
  x: number;
  y: number;
}

/** Platform-owned app-data, image, and shell services. Note/folder behavior
 * deliberately lives on the separate LocalNoteStore port. */
export interface PlatformStorage {
  readAppData(path: string): Promise<string | null>;
  writeAppData(path: string, content: string): Promise<void>;
  deleteAppData(path: string): Promise<void>;
  listAppData(dir: string): Promise<string[]>;
  /**
   * Every file in the vault that `include` keeps, folders included — not just
   * the top level. Metadata costs one call per kept file, so pass the narrowest
   * test you have: on a 2,500-note vault, statting everything takes 581ms
   * against 9ms for the images alone.
   */
  listVaultFiles(include: (path: string) => boolean): Promise<DirFileEntry[]>;
  deleteFile(path: string): Promise<void>;
  saveImageBytes?(data: ArrayBuffer, ext: string): Promise<string>;
  getImageUrl(filename: string): Promise<string>;
  getAppVersion(): Promise<string>;
}

export interface PickedImage {
  bytes: ArrayBuffer;
  extension: string;
}

export interface NativeCapabilities {
  pickImages?(options: { limit?: number; filterName: string }): Promise<PickedImage[]>;
  /**
   * Copy an image the OS handed us as a PATH, with no bytes, into the vault and
   * return its vault filename. That shape is a Linux WebKitGTK drop and Tauri's
   * own drag-drop event (src/features/editor/imageInsert.ts) — every other drop
   * arrives as `File` bytes and goes through `saveImageBytes` instead. Present
   * only where the host can read an arbitrary OS path.
   */
  saveImagePath?(sourcePath: string): Promise<string>;
  /**
   * Reads an image off the OS clipboard into the vault and returns its
   * filename. Present only where the OS clipboard is reachable at all (Tauri
   * desktop): the JS paste event hides a screenshot on Linux/WebKitGTK, so
   * this is the only way to recover one. Absent everywhere else.
   */
  pasteClipboardImage?(): Promise<string>;
}

export interface PlatformFS extends PlatformStorage, NativeCapabilities {
  writeClipboardText(text: string): Promise<void>;
}

export type PlatformName = 'tauri' | 'web';
