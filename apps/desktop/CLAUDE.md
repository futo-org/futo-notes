# CLAUDE.md - FUTO Notes Desktop (Electron)

This package contains the Electron shell for the desktop app (Linux, macOS, Windows).

## How It Works

- The shared Svelte app is built at the monorepo root (`dist/`)
- Electron's main process (`electron/main.ts`) serves `dist/index.html` in production, or proxies to Vite dev server in dev mode
- `electron/preload.ts` exposes a `window.electronAPI` bridge for IPC (filesystem, dialogs, config)
- The platform abstraction layer (`src/lib/platform/electron.ts`) uses this API

## Architecture

```
electron/
├── main.ts          # Main process: window management, IPC handlers, file watching, menus
├── preload.ts       # Context bridge: exposes electronAPI to renderer
└── tsconfig.json    # TypeScript config for Electron files
```

**Key features in main.ts**:
- First-run directory picker (default: `~/Documents/FUTO Notes`)
- Config persistence in `userData/config.json`
- Window state persistence (size, position, maximized)
- Chokidar file watching → broadcasts changes to all windows
- Multi-window support
- Auto-updater (electron-updater)
- Native menus with keyboard shortcuts

## Dev Workflow

```bash
# From monorepo root:
npm run desktop:dev              # Concurrent Vite + tsup + Electron

# From this directory:
npm run dev                      # Same as above but relative paths
npm run build:electron           # Compile main.ts + preload.ts via tsup
```

## Packaging

```bash
npm run desktop:package:linux    # Build + package for Linux (AppImage, deb)
npm run desktop:build            # Build only (no package)
```

Packaging config is in `electron-builder.yml`. It maps `../../dist` into the app bundle.

## tsup Config

`tsup.electron.config.ts` compiles both `main.ts` and `preload.ts` to CommonJS (required by Electron) into `dist-electron/`.
