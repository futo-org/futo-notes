# CLAUDE.md - FUTO Notes Mobile (Capacitor)

Capacitor shell for Android and iOS. The web app is built at the monorepo root (`dist/`), and Capacitor syncs it into the native projects.

## How It Works

- `capacitor.config.ts` points `webDir` to `../../dist` (the root Vite build output)
- `npx cap sync` copies `dist/` into `android/app/src/main/assets/public/` (and iOS equivalent)
- Native projects in `android/` and `ios/` are checked into git

## Build & Deploy

```bash
# From monorepo root (recommended):
npm run mobile:run:android         # Full cycle: build + sync + run
npm run mobile:run:ios
npm run mobile:open:android        # Open in Android Studio
npm run mobile:open:ios            # Open in Xcode

# Or from this directory:
npx cap sync android               # Sync web assets into Android project
npx cap run android --target "emulator-5554"
```

**IMPORTANT**: Always build the root project first (`npm run build` from root) before running `cap sync`. The orchestration scripts handle this automatically.

## Emulator

- Android emulator runs at `emulator-5554`
- Physical device serial: `4A121FDJH001XW`

## Storage

Notes are stored as `.md` files in the `futo-notes` subfolder of the device's Documents directory. On first run, `ensureCapacitorNotesFolder()` in `src/lib/platform/capacitor.ts` creates this subfolder and migrates any `.md` files from the Documents root.
