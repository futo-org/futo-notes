# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run Commands

```bash
npx expo start          # Start Expo dev server
npx expo run:ios --device        # Build and run on iOS (expo run:ios)
npx expo run android    # Build and run on Android (expo run:android)
npm run lint       # Run ESLint
```

## Architecture

FUTO Notes is a React Native/Expo app (SDK 54) for offline-first markdown note-taking with planned ML features via Cactus.

### Key Design Decisions

- **File-based storage**: Notes are stored as `.md` files in the app's document directory (`notes/` folder). No database—just plain markdown files with no frontmatter.
- **Title = filename**: The note's title is derived from the first line of content, sanitized for filesystem use (spaces become underscores, special chars removed).
- **Zustand for state**: `lib/notesStore.ts` manages note previews in memory, synced from filesystem on screen focus.
- **Expo Router**: File-based routing in `app/` directory with Stack navigation.
- **Live Markdown**: Uses `@expensify/react-native-live-markdown` for rich text editing with markdown preview.

### File Structure

- `app/_layout.tsx` - Root Stack navigator
- `app/index.tsx` - Notes list screen (reads from filesystem, displays previews)
- `app/note/[id].tsx` - Note editor screen (auto-saves on text change)
- `lib/notesStore.ts` - Zustand store for note previews

### Data Flow

1. Notes list loads from filesystem on focus (`useFocusEffect`)
2. Editing a note auto-saves to filesystem and optimistically updates the store
3. Filename changes when title (first line) changes—old file is deleted, new one created

### Path Alias

`@/*` maps to the project root (configured in `tsconfig.json`).
