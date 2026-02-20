import { contextBridge, ipcRenderer } from 'electron';
import type { ElectronAPI } from './api';

const api: ElectronAPI = {
  // Filesystem
  listFiles: () => ipcRenderer.invoke('fs:listFiles'),
  readFile: (filename) => ipcRenderer.invoke('fs:readFile', filename),
  writeFile: (filename, content, modifiedAtMs) => ipcRenderer.invoke('fs:writeFile', filename, content, modifiedAtMs),
  deleteFile: (filename) => ipcRenderer.invoke('fs:deleteFile', filename),
  deleteAllContent: () => ipcRenderer.invoke('fs:deleteAllContent'),
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
