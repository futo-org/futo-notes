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
- **Markdown**: GitHub Flavored Markdown (GFM) support via `@lezer/markdown`

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
├── useSearch.ts         # Search hook using MiniSearch
├── codemirror-bundle.js # CodeMirror imports for WebView
└── editor-setup.js      # CodeMirror editor config & markdown plugin

components/
├── CodeMirrorEditor.tsx # WebView-based markdown editor
└── SearchBar.tsx        # Search input component

tests/
├── gfm-test-note.md            # GFM test file
├── gfm-test-note.snapshot.json # Rendering snapshot
├── markdown-render-test.js     # Test harness
└── README.md                   # Test documentation
```

### Data Flow

1. **Startup**: Load cached index from MMKV → Diff against filesystem → Incremental update if needed
2. **Editing**: Text change → Auto-save to disk → Update index in MMKV → Update store
3. **Search**: Query → MiniSearch (fuzzy, prefix matching) → Return results

### Path Alias

`@/*` maps to project root (configured in `tsconfig.json`).

### Conventions

Use `interface` for object shapes.

### FlashList v2

This project uses **FlashList v2** (`@shopify/flash-list`), which has significant API changes from v1:

**Removed props (do NOT use):**
- `estimatedItemSize` - v2 handles sizing automatically
- `estimatedListSize`, `estimatedFirstItemOffset`
- `inverted` - use `maintainVisibleContentPosition` + reversed data instead
- `onBlankArea`, `disableHorizontalListHeightMeasurement`, `disableAutoLayout`

**Key v2 features:**
- `maintainVisibleContentPosition` is enabled by default
- `masonry` prop for grid layouts with varying heights
- `onStartReached` callback for loading older content

**Still supported:**
- `extraData` - use when renderItem depends on data outside the `data` prop (e.g., external state). Treat immutably.
- `overrideItemLayout` - still works for span, but size estimates are ignored

**Note:** FlashList v2 requires React Native's new architecture.

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

## Markdown Rendering & Testing

### CodeMirror Setup

The app uses CodeMirror 6 with a custom markdown rendering pipeline.

**Important**: When testing the editor on Android, use a physical device—the emulator has rendering quirks (scroll hijacking, visual flashing) that don't occur on real hardware.

**Key Files:**
- `lib/codemirror-bundle.js` - Bundles CodeMirror and dependencies for WebView
- `lib/editor-setup.js` - Custom markdown decorations plugin
- `components/CodeMirrorEditor.tsx` - WebView editor component (rendered in note screen)
- `scripts/bundle-codemirror.js` - Bundles everything into `lib/codemirror-bundle-string.ts`

**Markdown Features:**
- **GFM Support**: Enabled via `@lezer/markdown` GFM extension
- **Decorations Plugin**: Custom `hideMarkdownPlugin` that:
  - Hides markdown syntax (e.g., `**`, `*`, `#`, `[]()`) when cursor is not on that line
  - Applies CSS classes for styling (`.cm-md-h1`, `.cm-md-strong`, `.cm-md-emphasis`, etc.)
  - Replaces list markers with bullets (`•`)
  - Renders task checkboxes (`☐`, `☑`)
  - Replaces horizontal rules with styled divs

**Supported GFM Features:**
- ATX headings (`#` through `######`)
- Setext headings (`===` and `---`)
- Bold, italic, strikethrough
- Inline code and code blocks (fenced and indented)
- Links (inline, reference, autolinks)
- Images
- Tables (with delimiter hiding)
- Blockquotes (nested supported)
- Lists (ordered, unordered, task lists)
- Horizontal rules
- HTML (passed through)

### Markdown Test Harness

**Purpose**: Verify markdown rendering without manual inspection. Essential for making changes to the CodeMirror configuration.

**Files:**
- `tests/gfm-test-note.md` - Comprehensive GFM test file (all features)
- `tests/gfm-test-note.html` - Expected HTML from Obsidian (reference)
- `tests/gfm-test-note.snapshot.json` - Current rendering snapshot
- `tests/markdown-render-test.js` - Test harness using Puppeteer
- `tests/README.md` - Full documentation

**Commands:**
```bash
npm run test:markdown          # Generate/update snapshot
npm run test:markdown:verify   # Verify rendering matches snapshot
```

**How It Works:**
1. Launches headless browser with Puppeteer
2. Loads actual CodeMirror setup (same as app)
3. Renders test markdown file
4. Extracts DOM structure with CSS classes
5. Saves/compares snapshot

**Workflow for Markdown Changes:**
1. Make changes to `lib/editor-setup.js` or `components/CodeMirrorEditor.tsx`
2. Rebuild: `npm run bundle:codemirror` (only needed for editor-setup.js changes)
3. Verify: `npm run test:markdown:verify`
4. If intentional change: `npm run test:markdown` to update snapshot
5. Commit both code and updated snapshot

**Important Notes:**
- Test captures which CSS classes are applied (not visual appearance)
- Snapshot must be updated after intentional rendering changes
- Test ensures no regressions when modifying editor setup
- The `.html` file is for reference (Obsidian output) but test compares against snapshot
