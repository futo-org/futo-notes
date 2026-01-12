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

## FlashList v2

**Do NOT use** (removed in v2): `estimatedItemSize`, `estimatedListSize`, `inverted`, `onBlankArea`

**Use instead**: `maintainVisibleContentPosition` (default on), `masonry` for grids, `onStartReached` for loading older content.
