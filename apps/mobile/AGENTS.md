# AGENTS.md - FUTO Notes Mobile (Capacitor)

Capacitor shell. `capacitor.config.ts` points `webDir` to `../../dist` (root Vite build output).

## Key Details

- **IMPORTANT**: Always build the root project first (`npm run build` from root) before `cap sync`. The `npm run mobile:*` scripts handle this automatically.
- Native projects in `android/` and `ios/` are checked into git
- Notes stored as `.md` files in `futo-notes` subfolder of device Documents directory
- `ensureCapacitorNotesFolder()` in `src/lib/platform/capacitor.ts` creates this on first run and migrates `.md` files from the Documents root
