# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run Commands

```bash
npx expo start                    # Start Expo dev server
npx expo run:ios --device         # Build and run on iOS device
npx expo run:android              # Build and run on Android
npm run lint                      # Run ESLint
```

## Architecture

FUTO Notes is a React Native/Expo app (SDK 54) for offline-first markdown note-taking with local ML features via Cactus (semantic search embeddings and voice transcription).

### Tech Stack

- **Framework**: React Native 0.81.5 with Expo SDK 54
- **Routing**: Expo Router (file-based, Stack navigation)
- **State**: Zustand 5.0
- **Editor**: @expensify/react-native-live-markdown
- **ML**: Cactus React Native (qwen3-0.6-embed for embeddings, whisper-small for STT)
- **Audio**: @siteed/expo-audio-studio

### Key Design Decisions

- **File-based storage**: Notes stored as `.md` files in `notes/` folder. No database, no frontmatter.
- **Title = filename**: Title derived from first line, sanitized for filesystem (spaces preserved, special chars removed).
- **Local ML**: All AI runs on-device (embeddings, transcription). No cloud dependencies.
- **Hybrid search**: Combines keyword matching (40%) + semantic similarity (60%) with baseline normalization.

### File Structure

```
app/
├── _layout.tsx          # Root Stack layout, indexing progress in header
├── index.tsx            # Notes list with search
└── note/[id].tsx        # Note editor with voice input

lib/
├── notesStore.ts        # Zustand store (notes, search state, indexing state)
├── useSemanticSearch.ts # Search hook (indexing, embedding, hybrid scoring)
├── searchIndex.ts       # Index persistence (.search-index/index.json)
├── chunking.ts          # Text chunking (paragraphs → sentences, max 500 chars)
├── vectorMath.ts        # Cosine similarity, keyword scoring
└── useVoiceTranscription.ts # Whisper STT hook

components/
└── SearchBar.tsx        # Search input component
```

### Data Flow

1. **Startup**: Init embedding model → Load search index → Load notes → Sync index if needed
2. **Editing**: Text change → Auto-save to disk → Update store → Update search index
3. **Search**: Query → Debounce 300ms → Embed → Score chunks → Aggregate per note → Filter by threshold
4. **Voice**: Record audio → Transcribe with Whisper → Append to note

### Semantic Search Details

- **Chunking**: Notes split by paragraphs, large paragraphs split at sentence boundaries (max 500 chars)
- **Embedding**: Qwen3-0.6-embed model via Cactus
- **Scoring**: Raw cosine similarity normalized (baseline 0.50), threshold 0.35
- **Concurrency**: EmbedLock mutex serializes all embedding calls (Cactus limitation)
- **Memory**: Batched indexing (5 notes), pauses between notes, max 10 chunks per note

### Path Alias

`@/*` maps to project root (configured in `tsconfig.json`).
