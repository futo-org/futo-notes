FUTO Notes is a simple, beautiful notes app that gets out of your way. It relies on markdown, but doesn't require knowledge of the syntax. FUTO Notes works entirely offline, but you have the option to sync to your other devices.

The goal is to build a tool that truly enhances your thinking and recall. By using advanced machine learning techniques, it is able to help you connect the dots, reference ideas from your past, and generate new ideas.

But at its foundation, it is a simple, rock-solid notes app.

To maximize interoperability, notes live in a folder as a series of .md files with no frontmatter. Sidecars are used to maintain information about these notes. Sync will be determined later, but will eventually be supported. In order to have robust offline support, Yjs/CRDT will be used for conflict resolution.

The title of the note is the name of the file minus `.md`. So `my grocery list.md` would be the file name and `my grocery list` would be the official title.

## Build & Run

### First-Time Setup

```bash
# Install dependencies
npm install
```

### Development Commands

```bash
# Development & Building
npm run dev                                 # Dev server (web preview only)
npm run build                               # Build for production
npm run lint                                # Run ESLint

# Tauri v2
npm run tauri:dev                           # Run Tauri app in dev mode
npm run tauri:build                         # Build web + Tauri bundle
npm run tauri:test:rust                     # Run Rust core tests

# Mobile targets (Tauri)
npm run tauri:android:dev
npm run tauri:ios:dev
```

### Development Workflow

```bash
# 1. Make changes to Svelte/TypeScript/CSS
# 2. Run in Tauri desktop shell
npm run tauri:dev

# 3. Build distributable
npm run tauri:build
```

### Architecture

**Framework**: Svelte 5 + Tauri v2
**Build Tool**: Vite
**Editor**: CodeMirror 6 with live markdown transformations
**Storage**: Native filesystem via Tauri command bridge (`invoke`)
**Search**: MiniSearch (in-memory full-text search)
**State**: Svelte 5 runes (`$state`, `$derived`, `$effect`)

For detailed architecture and development information, see [CLAUDE.md](./CLAUDE.md).
