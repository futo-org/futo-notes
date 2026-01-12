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
- **Editor**: @expensify/react-native-live-markdown (native markdown rendering)

### Forked Dependencies

We forked `@expensify/react-native-live-markdown` so we can patch the editor without waiting on upstream releases.

- Repo: `SomewhatJustin/react-native-live-markdown`, branch `futo`
- Local checkout: `react-native-live-markdown/` at the repo root (tracked in git)
- App dependency: `package.json` points to `github:SomewhatJustin/react-native-live-markdown#futo`
- Peer requirements: keep `react-native-worklets` at `^0.6.1` or newer so installs succeed

#### Working on the Fork

1. `cd react-native-live-markdown`
2. `npm install` (installs the fork's dev deps)
3. Make code changes (package uses Bob + TypeScript; JS/TS sources live in `src/`)
4. `npm run test`, `npm run lint`, and `npm run prepare` (prepare runs `patch-package` + `bob build`)
5. `git status`, `git commit`, and `git push origin futo`
6. Back in the main app folder, run `npm install` to pull the new commit via the git dependency

Because the app depends on the `futo` branch, any pushed commit automatically becomes the installed version the next time `npm install` runs (no npm publish needed). Keep the fork directory up to date (e.g., `git pull --rebase origin futo`) if multiple people are editing it.

### Key Design Decisions

- **File-based storage**: Notes stored as `.md` files in `notes/` folder. No database, no frontmatter.
- **Title = filename**: Title derived from first line, sanitized for filesystem (spaces preserved, special chars removed).
- **Cached search index**: MiniSearch index persisted to MMKV with incremental updates on startup.
- **Native markdown**: Uses MarkdownTextInput for native rendering (no WebView).

### File Structure

```
app/
├── _layout.tsx          # Root Stack layout with font loading
├── index.tsx            # Notes list with search (FlashList)
└── note/[id].tsx        # Note editor with MarkdownTextInput

lib/
├── notesStore.ts        # Zustand store (notes, search state)
├── notesLoader.ts       # Load notes with cached MiniSearch index
├── storage.ts           # MMKV storage singleton
├── useSearch.ts         # Search hook using MiniSearch
└── theme.ts             # Design system (colors, fonts, spacing)

components/
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

## Editor (react-native-live-markdown)

The app uses `@expensify/react-native-live-markdown` for the editor, which provides:

- **Native rendering**: Markdown is rendered natively (not in a WebView)
- **Live preview**: See formatted markdown as you type
- **MarkdownTextInput**: Drop-in replacement for TextInput with markdown support

### Usage

```tsx
import {
  MarkdownTextInput,
  parseMarkdown,
} from "@expensify/react-native-live-markdown";

<MarkdownTextInput
  value={text}
  onChangeText={setText}
  parser={parseMarkdown}
  multiline
/>
```

### Supported Markdown

- Bold (`**text**`)
- Italic (`*text*`)
- Strikethrough (`~~text~~`)
- Inline code (`` `code` ``)
- Code blocks (triple backticks)
- Links (`[text](url)`)
- Headings (`# H1`, `## H2`, etc.)
- Lists (ordered and unordered)
- Blockquotes (`> quote`)

### Native Dependencies

The editor requires these peer dependencies:
- `react-native-reanimated` - for animations
- `react-native-worklets` - for worklet runtime
- `expensify-common` - shared utilities

Metro config (`metro.config.js`) handles resolving the submodule's peer dependencies from the main app's node_modules.
