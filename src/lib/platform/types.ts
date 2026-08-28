export interface FileChangeEvent {
  type: 'add' | 'change' | 'unlink' | 'rename';
  /** Relative path under the notes root (forward-slash separated). */
  filename: string;
  from?: string;
}

export interface DirFileEntry {
  name: string;
  size: number;
  mtime: number;
}

/** Platform-owned app-data, image, and shell services. Note/folder behavior
 * deliberately lives on the separate LocalNoteStore port. */
export interface PlatformStorage {
  readAppData(path: string): Promise<string | null>;
  writeAppData(path: string, content: string): Promise<void>;
  deleteAppData(path: string): Promise<void>;
  listAppData(dir: string): Promise<string[]>;
  listDirFiles(): Promise<DirFileEntry[]>;
  deleteFile(filename: string): Promise<void>;
  saveImage(sourcePath: string): Promise<string>;
  saveImageBytes?(data: ArrayBuffer, ext: string): Promise<string>;
  getImageUrl(filename: string): Promise<string>;
  getAppVersion(): Promise<string>;
}

export interface NativeCapabilities {
  pickImage?(): Promise<string | null>;
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
