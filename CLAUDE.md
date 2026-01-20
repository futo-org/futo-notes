# CLAUDE.md

## Commands

```bash
npx expo start                          # Dev server
npx expo run:android                    # Android debug
npx expo run:android --variant release  # Android release (for perf testing)
npx expo run:ios --device               # iOS device
npm run lint                            # ESLint
```

## Architecture

React Native/Expo SDK 54 app for offline-first markdown notes. Uses Expo Router, Zustand, MMKV, MiniSearch, and a forked `@expensify/react-native-live-markdown`.

**Development**: Uses dev build (not Expo Go). Test on physical Android device with 3-button navigation.

**Storage**: Notes are `.md` files in `notes/` folder. Title = first line (sanitized for filesystem). No database.

**Path alias**: `@/*` → project root.

**Convention**: Use `interface` for object shapes.

## Forked Editor

`react-native-live-markdown/` is a local fork (`file:./react-native-live-markdown` in package.json).

**To modify**: Edit `src/` → run `npm run prepare` → Metro picks up changes.

**After `npm install` in fork**: Delete duplicate peer deps:
```bash
rm -rf react-native-live-markdown/node_modules/{react-native-reanimated,react-native-worklets,react,react-native}
```

## iOS Device Logs

```bash
idevicesyslog | grep "search term"
```

Install via `brew install libimobiledevice` if needed.

## FlashList v2

**Do NOT use** (removed in v2): `estimatedItemSize`, `estimatedListSize`, `inverted`, `onBlankArea`

**Use instead**: `maintainVisibleContentPosition` (default on), `masonry` for grids, `onStartReached` for loading older content.

## Visual Editor Development Workflow

Reference screenshots: `tests/reference-screenshots/` (from Obsidian)

### MVP Scope (tests/mvp-test-note.md)
Currently testing with reduced GFM feature set. The following are **disabled** (commented out in parser):
- Thematic breaks / horizontal rules (`---`, `***`, `___`)
- Autolinks (`<https://...>`, `<user@example.com>`)
- Extended autolinks (bare URLs like `www.example.com`, `https://...`, `user@example.com`)
- Tables (GFM)

Full GFM test file: `tests/gfm-test-note.md` (for later)

### MCP Commands Available
- `ios_simulator_screenshot` - Capture current simulator screen
- `xcodebuild_build` - Incremental iOS build
- `xcodebuild_run` - Launch on simulator

### Known Patterns (update as discovered)
- iOS TextKit 2: [patterns here]
- Android: [patterns here]
