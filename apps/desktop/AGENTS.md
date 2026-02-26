# AGENTS.md - FUTO Notes Desktop (Electron)

Electron shell. Main process in `electron/`, compiled to CommonJS via tsup (Electron requirement).

## Key Details

- `electron/api.ts` is the single source of truth for the IPC bridge (`ElectronAPI` interface)
- `electron/preload.ts` exposes the bridge as `window.electronAPI`
- Platform layer (`src/lib/platform/electron.ts`) consumes it via `@desktop/electron/api` path alias
- First-run default notes directory: `~/Documents/FUTO Notes`
- Packaging config: `electron-builder.yml` (maps `../../dist` into app bundle)

## Verification (Required)

- For shared web UI behavior, run relevant Playwright tests from repo root.
- For Electron-specific changes (`electron/`, preload, IPC bridge), verify in Electron runtime (`npm run desktop:dev`) and exercise affected flows.
- For packaging or build changes, run the relevant desktop build or package script and confirm it completes.
- If verification fails, fix and rerun before reporting completion.
