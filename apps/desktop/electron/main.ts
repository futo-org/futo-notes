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

interface SupersearchManifestChunk {
  chunk_id: number;
  uuid: string;
  chunk_text: string;
  start_offset: number;
  end_offset: number;
}

interface SupersearchManifest {
  dims: number;
  chunk_count: number;
  chunks: SupersearchManifestChunk[];
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
let supersearchVectors: Float32Array | null = null;
let supersearchManifest: SupersearchManifest | null = null;

function invalidateSupersearchCache(): void {
  supersearchVectors = null;
  supersearchManifest = null;
}

function getSupersearchBinPath(): string {
  return safePath(notesDir, '.supersearch-vectors.bin');
}

function getSupersearchManifestPath(): string {
  return safePath(notesDir, '.supersearch-manifest.json');
}

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

// --- Path safety ---

/** Resolve a user-provided path segment under notesDir and ensure it doesn't escape. */
function safePath(base: string, userPath: string): string {
  const resolved = path.resolve(base, userPath);
  if (!resolved.startsWith(base + path.sep) && resolved !== base) {
    throw new Error(`Path traversal blocked: ${userPath}`);
  }
  return resolved;
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
    return fs.readFile(safePath(notesDir, filename), 'utf-8');
  });

  ipcMain.handle('fs:writeFile', async (_event, filename: string, content: string, modifiedAtMs?: number) => {
    const fullPath = safePath(notesDir, filename);
    await fs.writeFile(fullPath, content, 'utf-8');
    if (typeof modifiedAtMs === 'number' && Number.isFinite(modifiedAtMs) && modifiedAtMs >= 0) {
      const ts = new Date(modifiedAtMs);
      await fs.utimes(fullPath, ts, ts);
    }
    const stat = await fs.stat(fullPath);
    return stat.mtimeMs;
  });

  ipcMain.handle('fs:deleteFile', async (_event, filename: string) => {
    await fs.unlink(safePath(notesDir, filename));
  });

  ipcMain.handle('fs:deleteAllContent', async () => {
    const entries = await fs.readdir(notesDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(notesDir, entry.name);
      await fs.rm(fullPath, { recursive: true, force: true });
    }
  });

  ipcMain.handle('fs:fileExists', async (_event, filename: string) => {
    try {
      await fs.access(safePath(notesDir, filename));
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
      return await fs.readFile(safePath(notesDir, relPath), 'utf-8');
    } catch {
      return null;
    }
  });

  ipcMain.handle('appdata:write', async (_event, relPath: string, content: string) => {
    const fullPath = safePath(notesDir, relPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');
  });

  ipcMain.handle('appdata:delete', async (_event, relPath: string) => {
    try {
      await fs.unlink(safePath(notesDir, relPath));
    } catch { /* not found — fine */ }
  });

  ipcMain.handle('appdata:list', async (_event, relDir: string) => {
    try {
      const entries = await fs.readdir(safePath(notesDir, relDir));
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
    await fs.copyFile(sourcePath, safePath(notesDir, filename));
    return filename;
  });

  ipcMain.handle('fs:getImageUrl', (_event, filename: string) => {
    return `file://${safePath(notesDir, filename)}`;
  });

  // --- Supersearch IPC ---

  const loadSupersearchArtifacts = async (): Promise<boolean> => {
    if (supersearchVectors && supersearchManifest) return true;
    try {
      const manifestPath = getSupersearchManifestPath();
      const binPath = getSupersearchBinPath();
      const [manifestRaw, binData] = await Promise.all([
        fs.readFile(manifestPath, 'utf-8'),
        fs.readFile(binPath),
      ]);

      supersearchManifest = JSON.parse(manifestRaw) as SupersearchManifest;
      if (binData.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
        throw new Error('Invalid supersearch binary artifact');
      }
      const alignedBuffer = binData.buffer.slice(
        binData.byteOffset,
        binData.byteOffset + binData.byteLength,
      );
      supersearchVectors = new Float32Array(alignedBuffer);
      return true;
    } catch {
      invalidateSupersearchCache();
      return false;
    }
  };

  const hasSupersearchArtifacts = async (): Promise<boolean> => {
    if (supersearchManifest && supersearchVectors) return true;

    try {
      const manifestPath = getSupersearchManifestPath();
      const binPath = getSupersearchBinPath();
      const [manifestRaw, binStat] = await Promise.all([
        fs.readFile(manifestPath, 'utf-8'),
        fs.stat(binPath),
      ]);
      const manifest = JSON.parse(manifestRaw) as SupersearchManifest;
      const chunkCount = Array.isArray(manifest.chunks) ? manifest.chunks.length : 0;
      const dims = Number.isFinite(manifest.dims) ? manifest.dims : 0;
      if (chunkCount <= 0 || dims <= 0) return false;
      const expectedSize = chunkCount * dims * Float32Array.BYTES_PER_ELEMENT;
      return binStat.size >= expectedSize;
    } catch {
      return false;
    }
  };

  ipcMain.handle('supersearch:download', async (_event, serverUrl: string, token: string) => {
    const manifestPath = getSupersearchManifestPath();
    const binPath = getSupersearchBinPath();

    const headers = { Authorization: `Bearer ${token}` };
    const [manifestRes, binRes] = await Promise.all([
      fetch(`${serverUrl}/search/index?format=manifest`, { headers }),
      fetch(`${serverUrl}/search/index?format=bin`, { headers }),
    ]);
    if (!manifestRes.ok || !binRes.ok) {
      throw new Error(`Download failed: manifest=${manifestRes.status}, bin=${binRes.status}`);
    }

    const [manifestText, binBuffer] = await Promise.all([
      manifestRes.text(),
      binRes.arrayBuffer(),
    ]);

    await Promise.all([
      fs.writeFile(manifestPath, manifestText, 'utf-8'),
      fs.writeFile(binPath, Buffer.from(binBuffer)),
    ]);

    invalidateSupersearchCache();
  });

  ipcMain.handle('supersearch:query', async (_event, queryVector: number[], topK: number) => {
    const hasArtifacts = await loadSupersearchArtifacts();
    if (!hasArtifacts || !supersearchManifest || !supersearchVectors) return [];

    const safeTopK = Number.isFinite(topK) ? Math.max(0, Math.floor(topK)) : 0;
    if (safeTopK === 0) return [];

    const { dims, chunks } = supersearchManifest;
    const chunkCount = chunks.length;
    if (chunkCount === 0) return [];

    const query = new Float32Array(queryVector);
    if (query.length !== dims) return [];
    if (supersearchVectors.length < chunkCount * dims) return [];

    // Dot product = cosine similarity when vectors are L2-normalized,
    // which the server embedding pipeline guarantees.
    const scores: { index: number; score: number }[] = [];
    for (let i = 0; i < chunkCount; i++) {
      const offset = i * dims;
      let dot = 0;
      for (let d = 0; d < dims; d++) {
        dot += query[d] * supersearchVectors[offset + d];
      }
      scores.push({ index: i, score: dot });
    }

    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, safeTopK).map(({ index, score }) => {
      const chunk = chunks[index];
      return {
        chunkId: chunk.chunk_id,
        uuid: chunk.uuid,
        chunkText: chunk.chunk_text,
        startOffset: chunk.start_offset,
        endOffset: chunk.end_offset,
        score,
      };
    });
  });

  ipcMain.handle('supersearch:hasArtifacts', async () => {
    return hasSupersearchArtifacts();
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

  autoUpdater.on('update-available', (info) => {
    console.log(`Update available: ${info.version}`);
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log(`Update downloaded: ${info.version}`);
    const win = BrowserWindow.getFocusedWindow() || [...windows][0];
    if (win) {
      dialog.showMessageBox(win, {
        type: 'info',
        title: 'Update Ready',
        message: `FUTO Notes ${info.version} has been downloaded.`,
        detail: 'It will be installed when you quit the app.',
        buttons: ['Restart Now', 'Later'],
        defaultId: 0,
      }).then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall();
      });
    }
  });

  autoUpdater.on('error', (err) => {
    console.log('Auto-update error:', err.message);
  });

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
              invalidateSupersearchCache();
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

  // Open external links in the default browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    // Allow loading the app itself (dev server or file://)
    if (isDev && url.startsWith(process.env.VITE_DEV_SERVER_URL!)) return;
    if (url.startsWith('file://')) return;
    event.preventDefault();
    shell.openExternal(url);
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
