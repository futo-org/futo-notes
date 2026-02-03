# CLAUDE.md - FUTO Notes Capacitor 8 Edition

## Commands

```bash
# Development & Building
npm install                                 # Install dependencies
npm run dev                                 # Dev server (web preview only)
npm run build                               # Build for production
npm run lint                                # Run ESLint

# Capacitor (Platform Management)
npx cap sync                                # Sync web build to native platforms
npx cap sync android                        # Sync to Android only
npx cap sync ios                            # Sync to iOS only

# Running on Devices
npx cap run android --target "4A121FDJH001XW"  # Android device (use serial number)
npx cap run android                         # Android (interactive device selection)
npx cap run ios                             # iOS device

# Platform IDEs
npx cap open android                        # Open Android Studio
npx cap open ios                            # Open Xcode
```

## Architecture Overview

**Framework**: Vanilla TypeScript + Capacitor 8
**Build Tool**: Vite
**Editor**: CodeMirror 6 with live markdown transformations
**Storage**: Capacitor Filesystem for `.md` files
**Metadata**: @capacitor-community/sqlite (metadata cache + search index)
**Search**: MiniSearch (in-memory full-text search)
**State**: Simple pub/sub pattern (no framework dependency)
**Router**: Hash-based custom router

**Key Features**:
- ✅ Live markdown transformations (syntax hides, text styles appear as you type)
- ✅ Full GitHub Flavored Markdown support
- ✅ List continuation on Enter (bullets, numbers, tasks)
- ✅ Fast full-text search
- ✅ Offline-first, local-only storage
- ✅ Cross-platform (iOS + Android + Web)

## Project Structure

```
src/
├── main.ts                          # App entry point, Capacitor + router init
├── types.ts                         # TypeScript interfaces
├── store.ts                         # Pub/sub state management
├── router.ts                        # Hash-based routing (/, /note/:id)
│
├── screens/
│   ├── NotesList.ts                 # Notes list + search + FAB
│   └── NoteEditor.ts                # Editor with auto-save
│
├── components/
│   └── MarkdownEditor.ts            # CodeMirror 6 wrapper
│
├── lib/
│   ├── db.ts                        # SQLite database layer
│   ├── fileSystem.ts                # Capacitor Filesystem wrapper
│   ├── listContinuation.ts          # CodeMirror Enter key handler
│   ├── liveMarkdownTransform.ts     # Live transformation ViewPlugin
│   └── utils.ts                     # Filename sanitization, HTML escaping
│
└── styles/
    ├── index.css                    # Main styles + safe areas
    └── markdown.css                 # Markdown element styling

public/
└── index.html                       # HTML entry point

dist/                                # Built output (generated)
android/                             # Android native project (generated)
ios/                                 # iOS native project (generated)
```

## Development Workflow

### Local Development

```bash
# 1. Make changes to TypeScript/CSS
# 2. Build
npm run build

# 3. Sync to platform
npx cap sync android

# 4. Run on device
npx cap run android --target "4A121FDJH001XW"
```

### Testing on Device

1. **Android**: Connect device or start emulator
2. **iOS**: Must use physical device (simulator not supported for Capacitor filesystem/SQLite)

### Hot Reload (Web Only)

```bash
npm run dev
# Opens http://localhost:5173
# Changes auto-reload in browser (native platforms require rebuild)
```

## Key Technologies

### CodeMirror 6
- **Packages**: `codemirror@6.0.2`, `@codemirror/lang-markdown@6.5.0`
- **Features**: Markdown syntax highlighting + live transformations
- **Live Transformations**: Custom ViewPlugin hides markdown syntax, applies CSS styling
- **Example**: `**bold**` → markers hide, text becomes bold as you type

### Capacitor 8 Plugins Used
- `@capacitor/filesystem` - Note file I/O
- `@capacitor-community/sqlite` - Metadata + search index persistence
- `@capacitor/haptics` - Tactile feedback
- `@capacitor/keyboard` - Keyboard behavior
- `@capacitor/status-bar` - Status bar styling

### State Management
- **Store**: Simple pub/sub (`src/store.ts`)
- **No Redux/Zustand**: Vanilla pattern keeps bundle size small
- **Pattern**: `store.setState()` triggers subscribers

### Markdown Features
**Source of Truth**: `tests/gfm-test-note.md`

Fully supported:
- Headings (h1-h6)
- Emphasis (italic, bold, bold-italic)
- Strikethrough
- Inline code + fenced code blocks
- Block quotes (nested)
- Lists (unordered, ordered, task)
- Links + images
- Tables (GFM)
- Horizontal rules
- Escaped characters

## Live Markdown Transformations

**How it works**:
1. CodeMirror syntax tree identifies markdown elements
2. Custom ViewPlugin creates decorations to hide syntax markers
3. CSS classes style the content (`cm-md-bold`, `cm-md-h1`, etc.)
4. Cursor-aware: markers show when editing inside element

**Files**:
- `src/lib/liveMarkdownTransform.ts` - Plugin + widget classes
- `src/styles/markdown.css` - Styling

**Example Flow**:
```
User types: **bold**
            ↓
Parser identifies StrongEmphasis node
            ↓
Plugin hides ** markers via Decoration.replace()
            ↓
Plugin applies `.cm-md-strong` class
            ↓
CSS makes text bold
            ↓
User sees bold text without syntax
```

## Storage Architecture

### Filesystem (`src/lib/fileSystem.ts`)
- Notes stored as `.md` files in `Documents/notes/` directory
- Filename = sanitized title (e.g., "My Note" → `my-note.md`)
- Using `@capacitor/filesystem` API

### Database (`src/lib/db.ts`)
- **Metadata table**: id, title, preview, modificationTime
- **Search index table**: Persisted MiniSearch index (JSON)
- **For**: Fast listing, sorting, search without parsing files
- **Why**: File I/O is slow; metadata cache is fast

### Sync Logic
```
Edit note → Auto-save to file → Update metadata in DB → Update search index
```

## Known Issues & Quirks

### Android
- First app startup may take ~2-3 seconds (SQLite init)
- Large documents (10k+ lines) need to scroll smoothly (performance tested)

### iOS
- Requires physical device (simulator lacks native plugins)
- Build must use Xcode (can't use `cap run ios` on simulator)

### Safe Areas
- Use `env(safe-area-inset-*)` in CSS for notches/home indicators
- Already configured in `src/styles/index.css`

## Performance Notes

- **Decoration rebuild**: ~5ms for 10,000 line documents
- **Typing latency**: <5ms per character (no lag)
- **Search**: <50ms for 500 notes
- **Startup**: ~1-2 seconds (SQLite init + index load)

## Testing Checklist

See `tests/gfm-test-note.md` for full feature test.

Quick test:
1. Create new note
2. Type `**bold**` → space (should hide `**`, text bold)
3. Enter twice
4. Type `# Heading` → enter (should hide `#`, show as h1)
5. Enter twice
6. Type `- [ ] Task` → enter (should show checkbox)

All should work smoothly without lag.

## Debugging

### Browser Console (Web)
```bash
npm run dev
# Open http://localhost:5173
# DevTools: F12
```

### Android Logs
```bash
# Connect device, then:
adb logcat | grep "futo\|JS\|error"
```

### iOS Logs
```bash
# Open Xcode → Window → Devices and Simulators → Select device → View device logs
```

## Common Tasks

### Add a new markdown element
1. Identify node type in CodeMirror syntax tree
2. Add processing method to `LiveMarkdownPlugin` class
3. Add CSS class to `src/styles/markdown.css`
4. Test with `tests/gfm-test-note.md`

### Change app styling
- Global: `src/styles/index.css`
- Markdown: `src/styles/markdown.css`

### Modify storage behavior
- File operations: `src/lib/fileSystem.ts`
- Database schema: `src/lib/db.ts` (initDB function)

## Resources

- **CodeMirror 6 Docs**: https://codemirror.net/docs/
- **Capacitor Docs**: https://capacitorjs.com/docs
- **GFM Spec**: https://github.github.com/gfm/
- **Test Files**:
  - `tests/gfm-test-note.md` - Full GFM feature test
  - `tests/editor-theme-test.md` - Live transformation test

## Recent Changes (Capacitor 8 Migration)

- ✅ Migrated from React Native/Expo to Capacitor 8
- ✅ Built vanilla TypeScript + Vite instead of React
- ✅ Implemented live markdown transformations (CodeMirror ViewPlugin)
- ✅ SQLite for metadata + search (instead of MMKV + file scanning)
- ✅ Custom router instead of Expo Router
- ✅ Same core functionality, better performance, smaller bundle

## Testing with Playwright

**IMPORTANT**: Always set a timeout when running tests via Bash to avoid hanging:

```bash
# WRONG - can hang forever
npm run test

# CORRECT - always use timeout
npm run test 2>&1 | head -100  # Or use timeout parameter
```

When running `npm run test`, always:
1. Set `timeout` parameter in Bash tool (e.g., 120000 for 2 minutes)
2. Use `| head -N` to limit output
3. Run specific tests with `--grep "test name"` to reduce runtime

## Next Steps

- [ ] Dark mode support (CSS vars already prepared)
- [ ] Sync to cloud (if desired)
- [ ] iPad-specific layouts
- [ ] Export to PDF
