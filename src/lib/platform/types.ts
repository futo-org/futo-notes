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
  getPlatformName(): string;
}

export interface NativeCapabilities {
  readBinaryAppData?(path: string): Promise<ArrayBuffer | null>;
  writeBinaryAppData?(path: string, data: ArrayBuffer): Promise<void>;
  pickImage?(): Promise<string | null>;
}

export interface PlatformFS extends PlatformStorage, NativeCapabilities {}

export type PlatformName = 'tauri' | 'web';
