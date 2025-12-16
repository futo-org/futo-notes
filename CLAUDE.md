# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run Commands

```bash
npx expo start                          # Start Expo dev server
npx expo run:ios --device               # Build and run on iOS device
npx expo run:android                    # Build and run on Android (debug)
npx expo run:android --variant release  # Build and run release build
npm run lint                            # Run ESLint
```

### When to Use Release Build

Use `npx expo run:android --variant release` when:

- Testing performance (release builds are optimized, debug builds are slower)
- Verifying production behavior (ProGuard/R8 minification, no debug logging)
- Testing signed APK behavior before distribution
- Debugging issues that only occur in release mode

### When to Use Prebuild

Use `npx expo prebuild` when:

- Adding native modules that require configuration (not auto-linked)
- Customizing native Android/iOS code (MainActivity, AppDelegate, etc.)
- Modifying native build settings (gradle.properties, Info.plist)
- Debugging native build issues
- **Note**: This generates `android/` and `ios/` directories.

## Architecture

FUTO Notes is a React Native/Expo app (SDK 54) for offline-first markdown note-taking.

### Tech Stack

- **Framework**: React Native 0.81.5 with Expo SDK 54
- **Routing**: Expo Router (file-based, Stack navigation)
- **State**: Zustand 5.0
- **Storage**: MMKV (react-native-mmkv) for caching search index and previews
- **Search**: MiniSearch for full-text search with fuzzy matching
- **Editor**: CodeMirror 6 in a WebView (with clipboard bridge via expo-clipboard)

### Key Design Decisions

- **File-based storage**: Notes stored as `.md` files in `notes/` folder. No database, no frontmatter.
- **Title = filename**: Title derived from first line, sanitized for filesystem (spaces preserved, special chars removed).
- **Cached search index**: MiniSearch index persisted to MMKV with incremental updates on startup.

### File Structure

```
app/
├── _layout.tsx          # Root Stack layout
├── index.tsx            # Notes list with search
└── note/[id].tsx        # Note editor

lib/
├── notesStore.ts        # Zustand store (notes, search state)
├── notesLoader.ts       # Load notes with cached MiniSearch index
├── storage.ts           # MMKV storage singleton
└── useSearch.ts         # Search hook using MiniSearch

components/
├── CodeMirrorEditor.tsx # WebView-based CodeMirror 6 editor
└── SearchBar.tsx        # Search input component
```

### Data Flow

1. **Startup**: Load cached index from MMKV → Diff against filesystem → Incremental update if needed
2. **Editing**: Text change → Auto-save to disk → Update index in MMKV → Update store
3. **Search**: Query → MiniSearch (fuzzy, prefix matching) → Return results

### Path Alias

`@/*` maps to project root (configured in `tsconfig.json`).

### Conventions

Use `interface` for object shapes.

## Load Testing with Fake Notes (Android)

To import large numbers of test notes into the Android emulator:

```bash
# 1. Push notes to /data/local/tmp (world-readable, bypasses scoped storage)
adb push /path/to/fake-notes/. /data/local/tmp/fake-notes/

# 2. Long-press the + FAB in the app to trigger import
#    (uses importTestNotes() in app/index.tsx)
```

**Why `/data/local/tmp`?**
- Android scoped storage blocks apps from reading `/sdcard/Download` contents
- `/data/local/tmp` is world-readable, no permissions needed
- App can list and read files from this location

**Note**: The `importTestNotes()` function in `app/index.tsx` is debug code that should be removed before release.
