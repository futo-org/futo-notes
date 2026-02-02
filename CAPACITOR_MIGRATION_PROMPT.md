# FUTO Notes: React Native/Expo to Capacitor 8 Migration

## Mission
Migrate the existing React Native/Expo SDK 54 markdown notes app to **Capacitor 8** with a web-based frontend. The app must have identical functionality to the current app. Visual styling will be updated to match Obsidian later (not part of this migration).

## Current Architecture

### Tech Stack
- **Framework**: React Native 0.81.5 + Expo SDK 54
- **Router**: Expo Router (file-based routing)
- **State**: Zustand (global state management)
- **Storage**:
  - Notes stored as `.md` files in document directory (`notes/` folder)
  - No database - direct filesystem operations using `expo-file-system`
  - MMKV for app preferences (react-native-mmkv)
- **Search**: MiniSearch (in-memory full-text search index)
- **Lists**: FlashList v2 (high-performance list rendering)
- **Editor**: Forked `@expensify/react-native-live-markdown` (local fork at `./react-native-live-markdown`)

### Core Functionality
1. **Notes List Screen** (`app/index.tsx`)
   - Display all notes sorted by modification time (newest first)
   - Search notes in real-time (debounced, 300ms)
   - Click to open note
   - Delete button for each note
   - FAB button to create new note
   - Empty state with message

2. **Note Editor Screen** (`app/note/[id].tsx`)
   - Dynamic route: `/note/[id]` where id is the filename (without .md)
   - Editable title in navigation header
   - Live markdown rendering while typing (inline, not split-pane)
   - Auto-save on text/title change
   - List continuation (bullet points, numbered lists, task lists auto-continue on Enter)
   - Filename sanitization for filesystem compatibility
   - Handle rename (delete old file, create new)
   - Empty list item removal on Enter

3. **File System Pattern**
   - Title = filename (sanitized from editable title)
   - Notes stored in `<document_directory>/notes/`
   - Format: `{sanitized_title}.md`
   - Direct file I/O (no database, no abstraction layer)

4. **Search Implementation**
   - MiniSearch index built on app load
   - Indexes: id, title, content
   - Debounced search (300ms) with relevance scoring
   - Updates index on create/edit/delete/rename

## Markdown Support Requirements

**SOURCE OF TRUTH**: `tests/gfm-test-note.md`

The editor must correctly render all GitHub Flavored Markdown features in this test file:
- ATX Headings (# through ######)
- Paragraphs and line breaks (soft breaks, hard breaks with trailing spaces or backslash)
- Thematic breaks (---, ***, ___)
- Emphasis: *italic*, **bold**, ***bold-italic***
- Strikethrough: ~~text~~
- Code spans: `inline code`
- Fenced code blocks with language identifiers
- Block quotes (including nested)
- Unordered lists (-, *, +)
- Ordered lists (1., 2., etc.)
- Nested and mixed lists
- Task lists: - [ ] and - [x]
- Links: [text](url)
- Images: ![alt](url)
- Tables with alignment
- Backslash escapes
- All edge cases in gfm-test-note.md

**Test procedure**: Create a note, paste the entire contents of `tests/gfm-test-note.md`, verify all features render correctly.

## Target Architecture

### CRITICAL DECISION: Framework vs Vanilla

**You must research and decide in plan mode:**

**Option A: Vanilla TypeScript (Obsidian Approach)**
- No React, Vue, or framework
- Pure TypeScript + DOM manipulation
- CodeMirror 6 for editor (already decided)
- Custom components for list, search, etc.
- **Pros**: Lighter, faster, fewer deps, more control, simpler build
- **Cons**: More manual work, no component ecosystem
- **Example**: Obsidian is built this way and it's fast/reliable

**Option B: Lightweight Framework (React/Preact/Solid)**
- Minimal framework for reactivity and components
- Still use CodeMirror 6
- Zustand or signals for state
- **Pros**: Familiar patterns, easier component composition
- **Cons**: Added complexity, larger bundle, framework overhead

**Decision Criteria**:
1. Performance (mobile devices, typing latency)
2. Bundle size (smaller = faster load)
3. Development speed (for this one-time migration)
4. Maintainability (you'll maintain this)
5. Does the app complexity justify a framework?

### Capacitor 8 Stack (Framework-Agnostic)
- **Build Tool**: Vite (fast, works with or without framework)
- **Editor**: CodeMirror 6 (decided - excellent markdown support)
- **Storage**:
  - Capacitor Filesystem API for note files
  - Capacitor Preferences for app settings
- **Platforms**: iOS + Android (primary), Web (works automatically)

### Required Capacitor Plugins
- **@capacitor/filesystem** - Core file operations
- **@capacitor/preferences** - Key-value storage (replaces MMKV)
- **@capacitor/haptics** - Tactile feedback
- **@capacitor/keyboard** - Keyboard behavior control
- **@capacitor/status-bar** - Status bar theming
- **@capacitor/splash-screen** - Launch screen

### UI Requirements

**IMPORTANT**: Do NOT spend time matching the current app's styling. Use simple, functional styles. Visual design will be updated to match Obsidian later.

**List View**:
- Simple list of notes (title + preview text + date)
- Search bar at top
- Delete button on each note (no swipe gesture needed)
- FAB for new note
- Empty state message

**Editor View**:
- Editable title field at top
- CodeMirror 6 editor filling the rest
- Basic styling (readable, functional)

**List Rendering**: Choose based on framework decision:
- **If vanilla**: Test simple scrolling with 500 notes first, only add virtualization if needed
- **If framework**: Test simple rendering first, use React Virtuoso / TanStack Virtual only if needed

## Migration Strategy - PARALLEL AGENT WORKFLOW

You have a large token budget. **USE MULTIPLE AGENTS IN PARALLEL** to maximize efficiency.

### Phase 0: Critical Research & Decision (SEQUENTIAL)
**Single agent - must complete before other phases:**

1. **Agent Alpha - Architecture Decision**
   - Research Capacitor 8 + vanilla TypeScript approach (study Obsidian architecture if possible)
   - Research Capacitor 8 + React/Preact/Solid approach
   - Prototype both: simple list with 100 items + CodeMirror 6 editor
   - Measure bundle size, performance, typing latency for both
   - **Deliverable**: Clear recommendation with justification + proof-of-concept code
   - **Decision point**: Get user approval before proceeding

### Phase 1: Project Setup & Research (PARALLEL - after Phase 0)
**Launch 3 agents simultaneously:**

1. **Agent A - Capacitor 8 Setup**
   - Initialize new Capacitor 8 project with Vite + TypeScript (+ chosen framework if applicable)
   - Configure iOS and Android targets (match bundle IDs: `com.futo.notes`)
   - Set up build scripts and dev workflow
   - Configure all Capacitor plugins (filesystem, preferences, haptics, keyboard, status-bar, splash-screen)
   - Test basic filesystem operations on both iOS and Android platforms
   - Test preferences storage
   - Document platform-specific quirks
   - **Deliverable**: Working Capacitor 8 project that builds for both platforms

2. **Agent B - CodeMirror 6 Setup & GFM Support**
   - Set up CodeMirror 6 with full GFM support
   - Configure all markdown features from `tests/gfm-test-note.md`:
     - Headings, emphasis, code, quotes, lists, tables, etc.
   - Implement list continuation extension:
     - Detect bullet lists (`- `, `* `, `+ `)
     - Detect numbered lists (`1. `, `2. `, etc.)
     - Detect task lists (`- [ ]`, `- [x]`)
     - Auto-continue on Enter press
     - Remove empty list item on Enter
   - Test with full contents of `tests/gfm-test-note.md`
   - Verify all features render correctly
   - Test on mobile (touch selection, keyboard interaction)
   - Optimize for performance (large documents)
   - **Deliverable**: Working CodeMirror 6 editor that passes GFM test

3. **Agent C - Migration Audit & API Mapping**
   - Read through all current source files in `/app`, `/lib`, `/components`
   - Document all Expo/React Native specific code that needs replacement
   - Map Expo APIs to Capacitor 8 equivalents:
     - `expo-file-system` → `@capacitor/filesystem`
     - `react-native-mmkv` → `@capacitor/preferences`
     - `expo-haptics` → `@capacitor/haptics`
     - `expo-router` → Router solution (file-based or manual)
   - Identify which code can be reused as-is (MiniSearch, Zustand if using React)
   - **Deliverable**: Complete migration map + compatibility layer API design

### Phase 2: Core Infrastructure (PARALLEL)
**Launch 3 agents:**

1. **Agent D - File System Layer**
   - Implement `lib/fileSystem.ts` using Capacitor Filesystem API
   - Create wrapper classes that match Expo's API if helpful:
     ```typescript
     // Goal: keep this API working
     const file = new File(notesDir, 'example.md');
     const content = await file.text();
     await file.write(newContent);
     file.delete();
     ```
   - Handle platform differences (iOS vs Android paths, URI formats)
   - Implement directory listing, file existence checks, create/read/update/delete
   - Write unit tests for all file operations
   - Test on both iOS and Android devices
   - **Deliverable**: Drop-in replacement for `lib/fileSystem.ts`

2. **Agent E - Router & Navigation**
   - Implement routing solution:
     - **If vanilla**: Manual router (hash-based or history API)
     - **If framework**: Framework's router
   - Set up two routes: `/` (notes list) and `/note/:id` (note editor)
   - Implement navigation primitives:
     - Header with back button
     - Editable title input in header
     - Basic styling (functional, not pretty)
   - Handle URL encoding for note IDs
   - Test deep linking and back navigation
   - **Deliverable**: Working navigation between list and editor

3. **Agent F - State & Search**
   - Port state management:
     - **If vanilla**: Simple observable pattern or signals
     - **If React**: Keep Zustand
     - **If Solid**: Solid signals
   - Port `lib/notesLoader.ts` (file loading + MiniSearch index building)
   - Port `lib/useSearch.ts` (search hook or function)
   - Ensure MiniSearch works in browser environment (it should)
   - Test search performance with 100+ notes
   - Test index updates on CRUD operations
   - **Deliverable**: Working state management + search functionality

### Phase 3: UI Components (PARALLEL)
**Launch 2 agents:**

1. **Agent G - Notes List Screen**
   - Implement notes list view (equivalent to `app/index.tsx`)
   - Display notes sorted by modification time
   - Show title, preview text (first 100 chars), date
   - Implement search bar with debouncing (300ms)
   - Simple scrolling (test with 500 notes, add virtualization only if slow)
   - Delete button on each note
   - FAB button for new note
   - Empty state message
   - Basic functional styling (clean, readable)
   - **Deliverable**: Fully functional notes list screen

2. **Agent H - Note Editor Screen**
   - Implement note editor view (equivalent to `app/note/[id].tsx`)
   - Integrate CodeMirror 6 editor from Agent B
   - Editable title field at top (text input)
   - Auto-save logic:
     - Debounce or throttle saves
     - Update file on every change
     - Handle rename (delete old file, create new)
   - Handle `/note/new` route (create new note with "Untitled")
   - Handle keyboard appearance (keyboard plugin)
   - Implement filename sanitization (port from current app)
   - Basic functional styling
   - **Deliverable**: Fully functional note editor screen

### Phase 4: Integration & Testing (PARALLEL)
**Launch 2 agents:**

1. **Agent I - Features Integration & Edge Cases**
   - Integrate all components (list, editor, router, filesystem)
   - Test full user flows:
     - Create note → edit → rename → delete
     - Search → open note → edit → back
     - Create 100 notes → search → delete multiple
   - Handle edge cases:
     - Special characters in filenames
     - Very long notes (10,000+ chars)
     - Empty notes
     - Rapid editing (auto-save collision)
     - Unicode (emoji, CJK, RTL)
   - Test with full `tests/gfm-test-note.md` content
   - Implement haptic feedback on key interactions (create, delete)
   - Test keyboard behavior
   - **Deliverable**: Fully integrated app with all edge cases handled

2. **Agent J - Platform Testing & Optimization**
   - Build for iOS (Xcode)
   - Build for Android (Android Studio)
   - Test on physical iOS device (iOS 18+)
   - Test on physical Android device
   - Profile performance:
     - App startup time
     - List scrolling FPS
     - Editor typing latency
     - Search response time
     - File operations timing
   - Optimize bottlenecks
   - Test with 500+ notes
   - **Deliverable**: Optimized app running smoothly on both platforms

### Phase 5: Final Verification (SEQUENTIAL)
**Single agent:**

1. **Agent Omega - Feature Parity Verification**
   - Go through every feature in current app
   - Verify it works in new app
   - Create feature comparison checklist
   - Test all markdown features from `tests/gfm-test-note.md`
   - Run full test checklist (see below)
   - Document any differences
   - Create release notes
   - **Deliverable**: Verified app ready for production

## Critical Technical Challenges

### 1. Filesystem API Differences
**Challenge**: Expo's `File` and `Directory` classes vs Capacitor's Filesystem API

**Current API (Expo)**:
```typescript
const notesDir = new Directory(Paths.document, 'notes');
if (!notesDir.exists) notesDir.create();
const file = new File(notesDir, 'example.md');
const content = await file.text();
await file.write(newContent);
file.delete();
```

**Capacitor API**:
```typescript
import { Filesystem, Directory } from '@capacitor/filesystem';
await Filesystem.readFile({
  path: 'notes/example.md',
  directory: Directory.Documents
});
await Filesystem.writeFile({
  path: 'notes/example.md',
  data: newContent,
  directory: Directory.Documents
});
```

**Solution**: Create compatibility layer in `lib/fileSystem.ts` that wraps Capacitor API with Expo-like classes (or just update all call sites).

### 2. CodeMirror 6 GFM Support
**Challenge**: Support all GFM features from `tests/gfm-test-note.md`

**Solution**:
- Use `@codemirror/lang-markdown` package
- Configure GFM extensions (tables, strikethrough, task lists)
- Test exhaustively with `tests/gfm-test-note.md`
- Verify all syntax highlights correctly
- Verify all features render in live preview

### 3. CodeMirror 6 List Continuation
**Challenge**: Implement list continuation exactly like current app

**Current behavior**:
- User types `- Item 1` and presses Enter
- App automatically inserts `- ` on new line
- If user presses Enter on empty list item `- `, it removes the marker

**Solution**:
- Use CodeMirror 6 key bindings (Enter key handler)
- Parse current line for list patterns
- Insert appropriate prefix or remove empty marker
- Handle cursor positioning

**Patterns to support**:
```markdown
- Bullet item         → -
* Bullet item         → *
+ Bullet item         → +
1. Numbered item      → 2.
2) Numbered item      → 3)
- [ ] Task item       → - [ ]
- [x] Done task       → - [ ]
```

### 4. Mobile Keyboard Handling
**Challenge**: Editor shouldn't be covered by keyboard

**Capacitor**:
- Use `@capacitor/keyboard` plugin
- Listen to `keyboardWillShow` / `keyboardWillHide` events
- Adjust viewport or scroll position
- Use CSS `visualViewport` API if needed

### 5. Auto-Save Without Race Conditions
**Challenge**: Save on every keystroke without conflicts

**Solution**:
- Debounce saves (300-500ms)
- Keep "dirty" flag
- Use queue for file writes
- Handle rapid title changes (rename operations)

## Testing Checklist

### Functional Tests
- [ ] Create a note (title: "Test Note")
- [ ] Edit note content (typing should feel instant)
- [ ] Edit note title in header (should rename file)
- [ ] Delete note (button click)
- [ ] Search for note (debounced, results appear quickly)
- [ ] Create note with special chars in title: `Test / Note * 2024`
- [ ] Create note with only emoji title: `🚀✨🎉`
- [ ] Create 100 notes, verify list performance
- [ ] Search through 100 notes (should be fast)
- [ ] Test list continuation:
  - [ ] Bullet list (`- `, `* `, `+ `)
  - [ ] Numbered list (`1. `, `2. `)
  - [ ] Task list (`- [ ]`, `- [x]`)
  - [ ] Empty list item removal
- [ ] Kill app and restart (verify all notes persist)
- [ ] Edit note, kill app mid-edit, restart (verify auto-save)

### GFM Support Tests
- [ ] Create new note
- [ ] Paste entire contents of `tests/gfm-test-note.md`
- [ ] Verify all features render correctly:
  - [ ] All heading levels (# through ######)
  - [ ] Italic, bold, bold-italic
  - [ ] Strikethrough
  - [ ] Inline code
  - [ ] Code blocks with syntax highlighting
  - [ ] Block quotes (including nested)
  - [ ] Unordered lists (-, *, +)
  - [ ] Ordered lists
  - [ ] Task lists
  - [ ] Links
  - [ ] Images (if applicable)
  - [ ] Tables with alignment
  - [ ] Thematic breaks (horizontal rules)
  - [ ] Backslash escapes

### Platform Tests (iOS)
- [ ] Build and run on iOS device (iOS 18+)
- [ ] Test keyboard appearance/dismissal
- [ ] Test haptic feedback
- [ ] Test file operations (create, read, update, delete)

### Platform Tests (Android)
- [ ] Build and run on Android device
- [ ] Test keyboard appearance/dismissal
- [ ] Test haptic feedback
- [ ] Test file operations

### Performance Tests
- [ ] App startup < 1s (to list screen)
- [ ] List scrolling smooth with 500+ notes
- [ ] Editor typing latency < 16ms (no lag)
- [ ] Search response < 50ms
- [ ] File operations < 100ms

### Edge Cases
- [ ] Very long note (10,000+ characters) - should load and edit smoothly
- [ ] Note with only whitespace - should handle gracefully
- [ ] Note title with only special chars: `***///!!!` - should sanitize
- [ ] Empty note - should save as empty file
- [ ] Rapid title editing - no save conflicts
- [ ] Search with special chars
- [ ] Unicode in title/content: `日本語`, `العربية`, `🚀`
- [ ] Create two notes with similar titles - should handle collision
- [ ] Delete note while search is active - should update results
- [ ] Offline mode - all operations should work (no network needed)

## Success Criteria

The migration is complete when:
1. ✅ All core features work (create, read, update, delete, search)
2. ✅ All GFM features from `tests/gfm-test-note.md` render correctly
3. ✅ List continuation works for all list types
4. ✅ Performance meets requirements (measured)
5. ✅ Builds and runs on iOS 18+ and Android devices
6. ✅ All functional tests pass
7. ✅ All platform tests pass
8. ✅ All edge cases handled
9. ✅ No Expo/React Native dependencies remain
10. ✅ Code is clean and maintainable

## Commands Reference

```bash
# Development
npm install                         # Install dependencies
npm run dev                         # Start Vite dev server (web preview)

# Capacitor
npx cap sync                        # Sync web build to native platforms
npx cap open ios                    # Open Xcode
npx cap open android                # Open Android Studio

# Building
npm run build                       # Build web assets for production
npm run build && npx cap sync       # Build and sync to native

# Running on Devices
npx cap run ios --target="<device>" # Build and run on iOS device
npx cap run android                 # Build and run on Android device

# Debugging
npx cap run ios --livereload        # iOS with live reload
npx cap run android --livereload    # Android with live reload
```

## Files to Migrate (Priority Order)

### Critical Path (Must work first)
1. `lib/fileSystem.ts` - Filesystem abstraction (Capacitor wrapper)
2. `lib/notesStore.ts` - State management (adapt or reuse)
3. `lib/notesLoader.ts` - File loading and MiniSearch indexing
4. `lib/useSearch.ts` - Search functionality

### Core Screens (Must work second)
5. `app/index.tsx` → `screens/NotesList` - Notes list screen
6. `app/note/[id].tsx` → `screens/NoteEditor` - Note editor screen

### Supporting Code
7. `lib/haptics.ts` - Haptics wrapper (Capacitor plugin)
8. `tests/gfm-test-note.md` - GFM test file (copy to new project for testing)

## Agent Coordination Strategy

### How to Launch Agents in Parallel
Use Task tool with multiple calls in single message:

```
I need you to launch 3 agents in parallel:
1. Agent A: Set up Capacitor 8 project
2. Agent B: Set up CodeMirror 6 with GFM support
3. Agent C: Audit existing codebase
```

### Agent Handoff Pattern
When an agent completes:
1. Read their output/artifacts
2. Verify deliverables
3. Identify next dependencies
4. Launch next agent(s) with context

Example:
```
Agent D completed filesystem layer.
Now launch Agent G (notes list) and Agent H (note editor) in parallel.
```

## Key Principles

### 1. Preserve Simplicity
- No database, no sync, no server
- Plain markdown files in filesystem
- Local-first, offline-first, privacy-first

### 2. Functionality Over Form
- Don't worry about visual design (will be updated later)
- Focus on core features working correctly
- Simple, clean, functional UI is sufficient

### 3. GFM Support is Critical
- `tests/gfm-test-note.md` is the source of truth
- Every feature in that file must work
- Test exhaustively

### 4. Performance Matters
- Typing must feel instant
- List scrolling must be smooth
- Search must be fast
- Mobile performance is critical

### 5. Mobile-First
- Test on real devices, not just browser
- Touch interactions must work well
- Keyboard handling must be solid

## Questions to Answer in Plan Mode (Phase 0)

**Agent Alpha must research and answer:**

1. **Framework Decision**:
   - Vanilla TypeScript or React/Preact/Solid?
   - Trade-offs for this specific app?
   - Bundle size comparison?
   - Performance comparison?

2. **Build Tool**:
   - Vite configuration for Capacitor 8?
   - TypeScript setup?

3. **State Management**:
   - If vanilla: What pattern?
   - If framework: Zustand or framework primitives?

4. **Styling**:
   - Plain CSS or CSS Modules?
   - Keep it simple (design will change later)

5. **List Rendering**:
   - Simple scrolling sufficient for 500 notes?
   - Virtual scrolling needed?

**Deliverable from Phase 0**:
- Clear architectural decision with justification
- Proof-of-concept code
- Bundle size and performance measurements
- **User approval before proceeding**

## Final Notes

Success means:
- All features from current app work in new app
- All GFM features from `tests/gfm-test-note.md` render correctly
- Built on Capacitor 8 instead of Expo
- Same or better performance
- Clean, maintainable code

Visual design is NOT a concern for this migration. Keep it simple and functional.

When you enter plan mode, start with Phase 0 (Agent Alpha). Get the architecture decision right, then execute the rest in parallel.

Good luck! 🚀
