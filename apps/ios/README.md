# FUTO Notes — Native iOS Spike

A **spike** that rebuilds FUTO Notes as a *fully native* iOS app (SwiftUI),
keeping **only the markdown editor** as the existing web editor, embedded in a
`WKWebView`. Everything else — the note list, folder browsing, navigation,
search, create/rename/delete, theming, and all file I/O — is native Swift.

This app does **not** use Tauri. It is a separate, standalone Xcode target.

```
┌─────────────────────────────────────────┐
│  SwiftUI (100% native)                    │
│   • NoteListView   — list, search, CRUD   │
│   • NoteEditorView — native title + tags  │
│   • NotesStore     — FileManager .md I/O  │
│        │                                  │
│        │  EditorWebView (UIViewRepresent.)│
│        ▼                                  │
│   ┌───────────────────────────────────┐  │
│   │  WKWebView                         │  │
│   │   editor.html (single file)        │  │
│   │   = real MarkdownEditor.svelte     │  │
│   │     (CodeMirror 6 + live markdown) │  │
│   └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

## Run it

```bash
xcrun simctl boot 'iPhone 17 Pro' && open -a Simulator   # if nothing is booted
apps/ios/run.sh
```

`run.sh` builds the editor web bundle, generates the Xcode project with
`xcodegen`, builds the app, and installs + launches it on the booted simulator.

Requirements: Xcode, `xcodegen` (`brew install xcodegen`), `pnpm`.

## How the two halves talk (`futoBridge` contract)

The web page exposes a global, callable from Swift via `evaluateJavaScript`:

| JS API                              | Purpose                                    |
| ----------------------------------- | ------------------------------------------ |
| `window.FutoEditor.setContent(md)`  | Load markdown (suppresses the change echo) |
| `window.FutoEditor.getContent()`    | Read current markdown                      |
| `window.FutoEditor.focus()`         | Focus the editor                           |
| `window.FutoEditor.setTheme(t)`     | `'light'` / `'dark'`                        |

The web page posts to the native handler named **`futoBridge`**:

| Message                              | Native reaction                           |
| ------------------------------------ | ----------------------------------------- |
| `{ type: 'ready' }`                  | push current content + theme into editor  |
| `{ type: 'change', content }`        | debounced (0.4 s) autosave to the `.md`   |
| `{ type: 'focus', focused }`         | (unused)                                   |

## Pieces

**Native app** — `apps/ios/`
- `Sources/FutoNotesApp.swift` — `@main`, injects `NotesStore`.
- `Sources/NotesStore.swift` — `FileManager`-backed store. Notes live as
  `.md` files under `Documents/futo-notes/`. Ports the FUTO data rules: the
  **filename leaf is the title verbatim**, the id is the path without `.md`,
  forbidden filename chars are stripped, ids are de-duped (`Foo` → `Foo-2`),
  `#tag`s extracted by regex. Seeds 3 sample notes on first launch.
- `Sources/NoteListView.swift` — `NavigationStack`, `.searchable`, swipe-delete,
  `+` to create.
- `Sources/NoteEditorView.swift` — native large title (commit = rename), live
  tag chips, the embedded editor, debounced autosave.
- `Sources/EditorWebView.swift` — `UIViewRepresentable` over `WKWebView`;
  implements the bridge above; loads `editor.html` via `loadFileURL` (a file://
  origin so the inline ES module executes).
- `Sources/Theme.swift` — brand palette (orange `#F26B1F`).
- `project.yml` — xcodegen target; bundle id `com.futo.notes.native`.

**Editor web bundle** — built from the existing app:
- `editor.html` (repo root) — a second Vite entry.
- `src/editor-embed/main.ts` — mounts the real `src/components/MarkdownEditor.svelte`
  and wires `window.FutoEditor` + `futoBridge`.
- `vite.editor.config.ts` — builds with `vite-plugin-singlefile` into one
  self-contained `apps/ios/Resources/editor.html` (~2.5 MB, all
  JS/CSS/fonts inlined, no network needed).

## Verified working

- Native list → tap note → editor renders live markdown (headings, bold/italic,
  code, lists, **interactive checkboxes**, tables, tags).
- Typing in the editor autosaves to the on-disk `.md` (confirmed on disk).
- Title edit renames the file; folders (`Specs/…`) map to real subdirectories.
- Light/dark theme switches **both** native chrome and the embedded editor.

## Sync & auth — Rust core via UniFFI

All sync/auth/E2EE logic lives in Rust (`crates/futo-notes-sync`), exposed to
Swift with **UniFFI**. The SwiftUI app is a thin client: `SyncManager.swift`
drives a generated `SyncClient` object; `SyncView.swift` is the UI (cloud icon →
sheet). Crypto is reused from `crates/futo-notes-core::e2ee` (PBKDF2-HMAC-SHA256
100k, AES-256-GCM, per-collection wrapped vault key) — byte-compatible with the
TS client and the server.

```
SwiftUI (SyncView/SyncManager)
   → SyncClient (generated Swift, UniFFI)
       → futo-notes-sync (Rust: reqwest+rustls, async over tokio)
           connect → login → collection → unwrap vault key
           sync_now → pull (download+decrypt+write .md) + push (encrypt+upload)
       → futo-notes server  (../futo-notes-server, /api, Bearer token)
```

Build the Rust side (device + simulator libs, bindings, xcframework):

```bash
apps/ios/build-rust-ios.sh   # run.sh calls this automatically
```

`SyncClient` API: `connect(password) async -> ConnectInfo`,
`syncNow() async -> SyncSummary`, `status() -> SyncStatus`, `disconnect() async`.

**Verified:** against `futo-notes-server` (AUTH_MODE=dev, :3005) on the
simulator — connect mints a vault, push uploaded 5 encrypted notes (confirmed as
5 ciphertext objects on the server), and a fresh client pulled + decrypted them
back to disk. Note: the simulator reaches the Mac's `localhost`; a physical
device needs the Mac's LAN IP instead.

## Corners cut (it's a spike)

- Sync ports the core path (connect/login/vault-key/pull/push/object-map/409
  3-way-merge). Omitted (marked `// TODO(spike)` in `orchestrator.rs`):
  hash-based rename pairing, conflict-copy files, push checkpoints,
  concurrent-move dedup, SSE live events, and parallel blob transfer.
- No search index / vectors / graph, no image import.
- Folder browsing is flat-with-label, not a drill-in tree.
- iOS keyboard autocorrect/caps apply to typing (editor `contentAttributes`
  could be tuned).
- The editor bundle ships the whole app's editor stack (slash menu, wikilink
  autocomplete, etc.) running in browser-fallback mode — fine here.
- The data-model port covers the *reachable* rules (filename = title verbatim,
  forbidden-char stripping, id de-dup, tag extraction with lowercase dedup).
  It does **not** port the full `pathSafety.ts` defensive validation
  (`ensureSafeNoteId`, `MAX_FOLDER_DEPTH`, `.`/`..`/empty-component rejection)
  or code-fence exclusion in tag extraction. These aren't reachable through the
  spike's UI — titles are sanitized (no `/`) and folders are only ever inherited
  from already-safe ids — so traversal can't be injected. A production port
  should add `ensureSafeNoteId` at every id boundary. `sanitizeTitle` also
  clamps to 200 chars (filesystem safety) where the reference defers length to a
  separate validator.
