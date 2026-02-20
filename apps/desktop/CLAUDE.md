# CLAUDE.md - FUTO Notes Desktop (Electron)

Electron shell for the desktop app (Linux, macOS, Windows).

## How It Works

- The shared Svelte app is built at the monorepo root (`dist/`)
- Electron's main process (`electron/main.ts`) serves `dist/index.html` in production, or proxies to Vite dev server in dev mode
- `electron/api.ts` defines the `ElectronAPI` interface (single source of truth for the IPC bridge)
- `electron/preload.ts` implements the bridge and exposes it as `window.electronAPI`
- The platform abstraction layer (`src/lib/platform/electron.ts`) consumes the API via `@desktop/electron/api`
- First-run default notes directory: `~/Documents/FUTO Notes`

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

`tsup.config.ts` compiles both `main.ts` and `preload.ts` to CommonJS (required by Electron) into `dist-electron/`.
