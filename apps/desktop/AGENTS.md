# AGENTS.md - FUTO Notes Desktop (Electron)

Electron shell. Main process in `electron/`, compiled to CommonJS via tsup (Electron requirement).

## Key Details

- `electron/api.ts` is the single source of truth for the IPC bridge (`ElectronAPI` interface)
- `electron/preload.ts` exposes the bridge as `window.electronAPI`
- Platform layer (`src/lib/platform/electron.ts`) consumes it via `@desktop/electron/api` path alias
- First-run default notes directory: `~/Documents/FUTO Notes`
- Packaging config: `electron-builder.yml` (maps `../../dist` into app bundle)
