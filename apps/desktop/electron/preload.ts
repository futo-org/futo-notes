import { contextBridge, ipcRenderer } from 'electron';

export interface ElectronAPI {
  // Filesystem
  listFiles(): Promise<{ name: string; mtime: number }[]>;
  readFile(filename: string): Promise<string>;
  writeFile(filename: string, content: string): Promise<number>;
  deleteFile(filename: string): Promise<void>;
  fileExists(filename: string): Promise<boolean>;

  // App
  getNotesDir(): Promise<string>;
  getPlatform(): Promise<string>;
  getConfig(): Promise<{ notesDir: string; sidebarWidth?: number }>;
  saveConfig(updates: Record<string, unknown>): Promise<void>;
  getAppVersion(): Promise<string>;

  // Dialogs
  openDirectoryDialog(): Promise<string | null>;
  pickImage(): Promise<string | null>;

  // App data (dotfiles in notes directory)
  readAppData(relPath: string): Promise<string | null>;
  writeAppData(relPath: string, content: string): Promise<void>;
  deleteAppData(relPath: string): Promise<void>;
  listAppData(dir: string): Promise<string[]>;

  // Images
  saveImage(sourcePath: string): Promise<string>;
  getImageUrl(filename: string): Promise<string>;

  // Events from main process
  onFileChange(callback: (event: { type: string; filename: string }) => void): () => void;
  onMenuAction(callback: (action: string) => void): () => void;
  onNotesDirChanged(callback: (newDir: string) => void): () => void;
}

const api: ElectronAPI = {
  // Filesystem
  listFiles: () => ipcRenderer.invoke('fs:listFiles'),
  readFile: (filename) => ipcRenderer.invoke('fs:readFile', filename),
  writeFile: (filename, content) => ipcRenderer.invoke('fs:writeFile', filename, content),
  deleteFile: (filename) => ipcRenderer.invoke('fs:deleteFile', filename),
  fileExists: (filename) => ipcRenderer.invoke('fs:fileExists', filename),

  // App
  getNotesDir: () => ipcRenderer.invoke('app:getNotesDir'),
  getPlatform: () => ipcRenderer.invoke('app:platform'),
  getConfig: () => ipcRenderer.invoke('app:getConfig'),
  saveConfig: (updates) => ipcRenderer.invoke('app:saveConfig', updates),
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),

  // Dialogs
  openDirectoryDialog: () => ipcRenderer.invoke('dialog:openDirectory'),
  pickImage: () => ipcRenderer.invoke('dialog:pickImage'),

  // App data
  readAppData: (relPath) => ipcRenderer.invoke('appdata:read', relPath),
  writeAppData: (relPath, content) => ipcRenderer.invoke('appdata:write', relPath, content),
  deleteAppData: (relPath) => ipcRenderer.invoke('appdata:delete', relPath),
  listAppData: (dir) => ipcRenderer.invoke('appdata:list', dir),

  // Images
  saveImage: (sourcePath) => ipcRenderer.invoke('fs:saveImage', sourcePath),
  getImageUrl: (filename) => ipcRenderer.invoke('fs:getImageUrl', filename),

  // Events
  onFileChange: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { type: string; filename: string }) => callback(data);
    ipcRenderer.on('fs:change', handler);
    return () => ipcRenderer.removeListener('fs:change', handler);
  },

  onMenuAction: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, action: string) => callback(action);
    ipcRenderer.on('menu:action', handler);
    return () => ipcRenderer.removeListener('menu:action', handler);
  },

  onNotesDirChanged: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, newDir: string) => callback(newDir);
    ipcRenderer.on('app:notesDirChanged', handler);
    return () => ipcRenderer.removeListener('app:notesDirChanged', handler);
  },
};

contextBridge.exposeInMainWorld('electronAPI', api);
