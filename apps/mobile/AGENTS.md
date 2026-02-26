# AGENTS.md - FUTO Notes Mobile (Capacitor)

Capacitor shell. `capacitor.config.ts` points `webDir` to `../../dist` (root Vite build output).

## Key Details

- **IMPORTANT**: Always build the root project first (`npm run build` from root) before `cap sync`. The `npm run mobile:*` scripts handle this automatically.
- Native projects in `android/` and `ios/` are checked into git
- Notes stored as `.md` files in `futo-notes` subfolder of device Documents directory
- `ensureCapacitorNotesFolder()` in `src/lib/platform/capacitor.ts` creates this on first run and migrates `.md` files from the Documents root

## Verification (Required)

- For web UI behavior, run relevant Playwright tests from repo root.
- For Capacitor or native behavior (IME, status bar, filesystem, lifecycle), verify on emulator, simulator, or device before closing.
- Use existing scripts (`npm run mobile:run:android` or `npm run mobile:run:ios`) and inspect runtime behavior directly.
- For Android IME or input regressions, follow `docs/qa/p0-ime-checklist.md`.
- Use logs and inspection (`adb logcat | grep "futo\|JS\|error"`, app state and file checks) to confirm behavior.
- If verification fails, fix and rerun; do not mark complete without a passing verification loop.
