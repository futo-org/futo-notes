import { app, BrowserWindow, ipcMain, dialog, Menu, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { watch, type FSWatcher } from 'chokidar';
import { autoUpdater } from 'electron-updater';

const isDev = !!process.env.VITE_DEV_SERVER_URL;

// --- Config (stored in userData, not notes dir) ---

interface AppConfig {
  notesDir: string;
  sidebarWidth?: number;
}

function getConfigPath(): string {
  return path.join(app.getPath('userData'), 'config.json');
}

function getWindowStatePath(): string {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadConfig(): AppConfig | null {
  try {
    const configPath = getConfigPath();
    if (existsSync(configPath)) {
      return JSON.parse(readFileSync(configPath, 'utf-8'));
    }
  } catch { /* no config yet */ }
  return null;
}

function saveConfig(config: AppConfig): void {
  try {
    writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
  } catch { /* ignore write errors */ }
}

let notesDir = '';
let appConfig: AppConfig = { notesDir: '' };

function getDefaultNotesDir(): string {
  const xdgDocs = process.env.XDG_DOCUMENTS_DIR;
  const home = app.getPath('home');
  const docsDir = xdgDocs || path.join(home, 'Documents');
  return path.join(docsDir, 'FUTO Notes');
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// --- Window state persistence ---

interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  isMaximized: boolean;
}

function loadWindowState(): WindowState {
  const defaults: WindowState = { width: 1200, height: 800, isMaximized: false };
  try {
    const statePath = getWindowStatePath();
    if (existsSync(statePath)) {
      return { ...defaults, ...JSON.parse(readFileSync(statePath, 'utf-8')) };
    }
  } catch { /* use defaults */ }
  return defaults;
}

function saveWindowState(win: BrowserWindow): void {
  try {
    const isMaximized = win.isMaximized();
    const bounds = isMaximized ? (win as any)._normalBounds || win.getBounds() : win.getBounds();
    const state: WindowState = { ...bounds, isMaximized };
    writeFileSync(getWindowStatePath(), JSON.stringify(state));
  } catch { /* ignore write errors */ }
}

// --- Multi-window management ---

const windows = new Set<BrowserWindow>();

function broadcastToWindows(channel: string, ...args: any[]): void {
  for (const win of windows) {
    win.webContents.send(channel, ...args);
  }
}

// --- File watching ---

let watcher: FSWatcher | null = null;

function startFileWatching(): void {
  if (watcher) watcher.close();

  watcher = watch(notesDir, {
    ignoreInitial: true,
    depth: 0,
    ignored: [/(^|[/\\])\./],
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 50 },
  });

  const forwardEvent = (type: string) => (filePath: string) => {
    if (!filePath.endsWith('.md')) return;
    broadcastToWindows('fs:change', {
      type,
      filename: path.basename(filePath),
    });
  };

  watcher.on('add', forwardEvent('add'));
  watcher.on('change', forwardEvent('change'));
  watcher.on('unlink', forwardEvent('unlink'));
}

function stopFileWatching(): void {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
}

// --- IPC handlers ---

function setupIPC(): void {
  ipcMain.handle('fs:listFiles', async () => {
    const entries = await fs.readdir(notesDir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        const stat = await fs.stat(path.join(notesDir, entry.name));
        files.push({ name: entry.name, mtime: stat.mtimeMs });
      }
    }
    return files;
  });

  ipcMain.handle('fs:readFile', async (_event, filename: string) => {
    return fs.readFile(path.join(notesDir, filename), 'utf-8');
  });

  ipcMain.handle('fs:writeFile', async (_event, filename: string, content: string) => {
    await fs.writeFile(path.join(notesDir, filename), content, 'utf-8');
    const stat = await fs.stat(path.join(notesDir, filename));
    return stat.mtimeMs;
  });

  ipcMain.handle('fs:deleteFile', async (_event, filename: string) => {
    await fs.unlink(path.join(notesDir, filename));
  });

  ipcMain.handle('fs:fileExists', async (_event, filename: string) => {
    try {
      await fs.access(path.join(notesDir, filename));
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('app:getNotesDir', () => notesDir);

  ipcMain.handle('app:platform', () => 'electron');

  ipcMain.handle('app:getConfig', () => appConfig);

  ipcMain.handle('app:saveConfig', (_event, updates: Partial<AppConfig>) => {
    appConfig = { ...appConfig, ...updates };
    saveConfig(appConfig);
  });

  ipcMain.handle('dialog:openDirectory', async () => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select Notes Directory',
      defaultPath: notesDir,
    });
    if (!result.canceled && result.filePaths.length > 0) {
      return result.filePaths[0];
    }
    return null;
  });

  // App data (dotfiles in notes directory)
  ipcMain.handle('appdata:read', async (_event, relPath: string) => {
    try {
      return await fs.readFile(path.join(notesDir, relPath), 'utf-8');
    } catch {
      return null;
    }
  });

  ipcMain.handle('appdata:write', async (_event, relPath: string, content: string) => {
    const fullPath = path.join(notesDir, relPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');
  });

  ipcMain.handle('appdata:delete', async (_event, relPath: string) => {
    try {
      await fs.unlink(path.join(notesDir, relPath));
    } catch { /* not found — fine */ }
  });

  ipcMain.handle('appdata:list', async (_event, relDir: string) => {
    try {
      const entries = await fs.readdir(path.join(notesDir, relDir));
      return entries;
    } catch {
      return [];
    }
  });

  ipcMain.handle('app:getVersion', () => app.getVersion());

  ipcMain.handle('fs:saveImage', async (_event, sourcePath: string) => {
    const ext = path.extname(sourcePath).slice(1).toLowerCase() || 'png';
    const timestamp = Date.now();
    const rand = Math.random().toString(36).slice(2, 6);
    const filename = `${timestamp}-${rand}.${ext}`;
    await fs.copyFile(sourcePath, path.join(notesDir, filename));
    return filename;
  });

  ipcMain.handle('fs:getImageUrl', (_event, filename: string) => {
    return `file://${path.join(notesDir, filename)}`;
  });

  ipcMain.handle('dialog:pickImage', async () => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      title: 'Insert Image',
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] },
      ],
    });
    if (!result.canceled && result.filePaths.length > 0) {
      return result.filePaths[0];
    }
    return null;
  });
}

// --- Auto-updater ---

function setupAutoUpdater(): void {
  if (isDev) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.checkForUpdatesAndNotify().catch(() => {
    // Silently fail — auto-update is best-effort
  });
}

// --- First-run directory picker ---

async function initNotesDir(): Promise<void> {
  const config = loadConfig();

  if (config?.notesDir) {
    notesDir = config.notesDir;
    appConfig = config;
    ensureDir(notesDir);
    return;
  }

  // First run — ask user where to store notes
  const defaultDir = getDefaultNotesDir();
  const result = dialog.showMessageBoxSync({
    type: 'question',
    title: 'Welcome to FUTO Notes',
    message: 'Where would you like to store your notes?',
    detail: `Default location:\n${defaultDir}`,
    buttons: ['Use Default', 'Choose Folder'],
    defaultId: 0,
  });

  if (result === 1) {
    const dirResult = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose Notes Directory',
      defaultPath: path.dirname(defaultDir),
    });
    if (!dirResult.canceled && dirResult.filePaths.length > 0) {
      notesDir = dirResult.filePaths[0];
    } else {
      notesDir = defaultDir;
    }
  } else {
    notesDir = defaultDir;
  }

  appConfig = { notesDir };
  saveConfig(appConfig);
  ensureDir(notesDir);
}

// --- Menu ---

function buildMenu(): Menu {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        {
          label: 'New Note',
          accelerator: 'CmdOrCtrl+N',
          click: (_item, win) => win?.webContents.send('menu:action', 'new-note'),
        },
        {
          label: 'New Window',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => createWindow(),
        },
        { type: 'separator' },
        {
          label: 'Open Notes Folder',
          click: () => shell.openPath(notesDir),
        },
        {
          label: 'Change Notes Folder...',
          click: async () => {
            const win = BrowserWindow.getFocusedWindow();
            if (!win) return;
            const result = await dialog.showOpenDialog(win, {
              properties: ['openDirectory', 'createDirectory'],
              title: 'Change Notes Directory',
              defaultPath: notesDir,
            });
            if (!result.canceled && result.filePaths.length > 0) {
              notesDir = result.filePaths[0];
              appConfig.notesDir = notesDir;
              saveConfig(appConfig);
              ensureDir(notesDir);
              startFileWatching();
              broadcastToWindows('app:notesDirChanged', notesDir);
            }
          },
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        {
          label: 'Find',
          accelerator: 'CmdOrCtrl+F',
          click: (_item, win) => win?.webContents.send('menu:action', 'find'),
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Sidebar',
          accelerator: 'CmdOrCtrl+B',
          registerAccelerator: false, // Handled in renderer (Ctrl+B = bold when editor focused)
          click: (_item, win) => win?.webContents.send('menu:action', 'toggle-sidebar'),
        },
        {
          label: 'Command Palette',
          accelerator: 'CmdOrCtrl+K',
          registerAccelerator: false, // Handled in renderer
          click: (_item, win) => win?.webContents.send('menu:action', 'command-palette'),
        },
        { type: 'separator' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'resetZoom' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(!app.isPackaged ? [{ type: 'separator' as const }, { role: 'toggleDevTools' as const }] : []),
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About FUTO Notes',
          click: (_item, win) => {
            dialog.showMessageBox(win!, {
              type: 'info',
              title: 'About FUTO Notes',
              message: `FUTO Notes v${app.getVersion()}`,
              detail: 'A simple, file-first markdown notes app.',
            });
          },
        },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}

// --- Window creation ---

function createWindow(): void {
  const state = loadWindowState();

  const win = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 400,
    minHeight: 300,
    autoHideMenuBar: true,
    icon: path.join(__dirname, '../icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // needed for preload to use Node APIs
    },
    show: false, // show when ready to prevent flash
  });

  windows.add(win);

  if (state.isMaximized) {
    win.maximize();
  }

  // Track non-maximized bounds for proper state saving
  win.on('resize', () => {
    if (!win.isMaximized()) {
      (win as any)._normalBounds = win.getBounds();
    }
  });
  win.on('move', () => {
    if (!win.isMaximized()) {
      (win as any)._normalBounds = win.getBounds();
    }
  });

  win.on('ready-to-show', () => {
    win.show();
  });

  win.on('close', () => {
    saveWindowState(win);
  });

  win.on('closed', () => {
    windows.delete(win);
  });

  if (isDev) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL!);
    win.webContents.openDevTools();
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

// --- App lifecycle ---

app.whenReady().then(async () => {
  await initNotesDir();

  setupIPC();
  Menu.setApplicationMenu(buildMenu());
  createWindow();
  startFileWatching();
  setupAutoUpdater();
});

app.on('window-all-closed', () => {
  stopFileWatching();
  app.quit();
});

app.on('activate', () => {
  if (windows.size === 0) {
    createWindow();
  }
});
