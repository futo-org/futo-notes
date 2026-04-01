# Stonefruit V2 — Architecture Masterplan

Stonefruit is an offline-first markdown notes app with optional self-hosted sync. V1 works, but accidental complexity has accumulated: core logic is duplicated across TypeScript and Rust, client state is scattered across dotfiles, and layers like SSE, client-side embedding artifacts, and hidden UUID-based identity add machinery that doesn't serve the product promise.

V2 is a cleanup. Same product, same user-facing contracts, fewer moving parts. The goal is to make the architecture match the product: the `.md` file is the note, the filename is the identity, and everything else is derived.

## Design Principles

**Carried forward from v1:**

- **File over app.** `.md` files are the durable format. If Stonefruit disappears, the user's notes are still plain text in a folder.
- **The filename is the title.** No indirection, no hidden IDs, no transformations. `"grocery list.md"` means the title is `"grocery list"`.
- **Offline-first.** Every core feature works without a connection. Sync is additive.
- **Self-hosted.** One binary, one notes directory. No cloud accounts, no third-party dependencies at runtime.
- **Push concerns down, not out.** Auth, validation, sync — infrastructure, not call-site responsibility.

**New in v2:**

- **One domain core.** A shared Rust crate (`stonefruit-core`) consumed by both server and Tauri client. Sync logic, file operations, hashing, filename rules — defined once.
- **Basics first.** Editing, rename, delete, sync must be boringly reliable before investing in secondary features.
- **Derived capabilities are expendable.** Search, graph, automations are views over the data, not core state. They can be rebuilt from `.md` files at any time.
- **The .md file is the only canonical note data.** Not a database row, not a UUID mapping, not a binary blob. The file on disk is the note. Everything else — hashes, indexes, sync metadata — is derived from it and can be rebuilt by rescanning.
- **Filename is sync identity.** The sync protocol operates on filenames and content hashes, not hidden UUIDs. What the user sees is what the system tracks.

## Source of Truth Model

This should be unambiguous:

| Concern | Authority | Format |
|---|---|---|
| Note content | `.md` files on disk (client and server) | Plain UTF-8 markdown |
| Sync identity | Filename/path | No hidden IDs |
| Client app state | Minimal JSON file in app data dir | Server URL, auth token, device ID, file hashes |
| Server metadata | SQLite | Auth, sessions, tombstones, sync_meta, search index |
| Search/graph data | Server-side derived caches | Rebuildable from `.md` files |

The notes directory is sufficient to recover the vault's content. No database is required to know what a note is.

## What Changes

| System | v1 | v2 |
|---|---|---|
| Server runtime | Node.js (Hono) | Rust (Axum) |
| Server database | better-sqlite3 | rusqlite + sqlite-vec |
| Embedding inference | node-llama-cpp | Ollama (external, HTTP API via `reqwest`) |
| Sync identity | Hidden UUIDs (client maps filename → UUID) | Filename/path directly |
| Client state | 6+ JSON dotfiles in notes dir + UUID mappings | One small JSON file in app data dir |
| Sync notifications | SSE with ticket auth | Polling `/sync/check` |
| Conflict resolution | Server-wins, no merge attempt | Conflict copy (three-way merge added later) |
| Rename handling | UUID continuity | Heuristic: exact hash match within sync window |
| Search | Client-side artifact download + hybrid | Server-side hybrid; keyword-only offline |
| Graph data | Client downloads vectors, runs UMAP/K-Means | Server computes layout, client renders |
| Frontend shell | `NotesShell.svelte` (2100 lines) | Decomposed into ~8 focused components |
| Platform abstraction | `PlatformFS` (11 optional methods) | `FileSystem` + `NativeCapabilities` (2 interfaces) |
| Backend code sharing | Duplicated TS/Rust logic | Shared `stonefruit-core` Rust crate |
| Docker image | ~1-1.5 GB (Node + native deps) | ~50-100 MB (Rust binary; no bundled model) |

**What stays unchanged:** Hash-based whole-note sync. Plain `.md` files as the durable format. "Filename is the title" contract. Svelte 5 + CodeMirror 6 frontend. Tauri v2 for desktop/mobile. force-graph for visualization. Ollama as the external LLM service. The Ratatui CLI. MiniSearch for offline keyword search. Post-sync invariant checks.

## What's Eliminated

- **SSE notification layer** — `sseClient.ts`, ticket endpoint, server-side connection tracking, heartbeat timers, reconnect logic. Replaced by polling.
- **Client-side embedding artifacts** — `.supersearch-state.json`, `.supersearch-manifest.json`, `.supersearch-vectors.bin`, `artifactManager.ts`, `queryEmbedder.ts`, `capabilities.ts`. Search moves server-side.
- **Capability negotiation** — `/search/capabilities` endpoint and client-side feature detection.
- **Hidden UUID identity** — `uuidById` mapping, UUID generation on note creation, UUID-based sync protocol. Replaced by filename identity.
- **Client-side sync state complexity** — `syncState.ts`, `syncCoordinator.ts`, `writeSuppression.ts`, `watcherBatch.ts`, `persistedJson.ts`. Replaced by a single app-state file.
- **Notes-directory dotfiles** — `.sync-state-v1.json`, `.preferences.json`, `.supersearch-state.json`, `.engagement.json`. App state moves to app data directory.

What we **keep and improve**:

- **Post-sync invariant checks** — content-hash parity, orphaned files, duplicate filenames, tombstone exclusion. These catch real bugs at the integration boundary.
- **Conflict copies** — when both sides change the same note, create a conflict copy. Safe, debuggable, no silent bad merges.
- **Filesystem watcher** — same role, cleaner implementation via shared crate, with rename heuristic.

---

## Sync Engine

V2 simplifies the sync engine by aligning it with the product model: filenames are identity, files are content, everything else is derived.

### Protocol

The sync protocol centers filenames and content hashes, not UUIDs.

```
POST /sync

Request:
  device_id: string
  inventory: [{ filename, hash }]           -- client's current files
  changed: [{ filename, content, hash }]    -- files modified since last sync
  new: [{ filename, content, hash }]        -- files created since last sync
  deleted: [string]                         -- filenames removed since last sync

Response:
  update: [{ filename, content, hash }]     -- files to write locally
  delete: [string]                          -- files to remove locally
  conflicts: [{ filename, content }]        -- conflict copies to write
  version: number                           -- monotonic server clock
```

**Sync identity is a flat filename** — no nested folders. Subfolder support is a future consideration; until then, all notes live in a single directory.

**Quick-check** retained: `POST /sync/check` with client's last-seen version. If the server version matches and the client has no local changes, skip the full sync.

### How the client knows what changed

The client stores a `fileHashes` map in its app-state file: `{ "grocery list.md": "abc123...", "meeting notes.md": "def456..." }`. This records the hash of each file at last successful sync.

On sync:
- **Changed:** file exists, hash differs from `fileHashes[filename]`
- **New:** file exists, not in `fileHashes`
- **Deleted:** in `fileHashes`, file no longer exists on disk

After sync, `fileHashes` is updated to reflect the new state. This is the only sync metadata the client persists.

### How the server resolves changes

The server stores its own canonical files on disk and tracks per-device state in SQLite (`device_snapshots` table: `device_id, filename, last_synced_hash`). For each note in a sync request:

| Client state | Server state | Resolution |
|---|---|---|
| Changed | Unchanged since last device sync | Accept client version |
| Unchanged | Changed since last device sync | Send server version to client |
| Changed | Changed since last device sync | **Conflict** — keep server version, create conflict copy for client |
| New (not in server) | — | Accept as new note |
| — | New (not in client) | Send to client |
| Deleted | Unchanged | Accept deletion, tombstone |
| Deleted | Changed | **Conflict** — keep server version, send to client |
| Unchanged | Deleted (tombstoned) | Send deletion to client |

### Rename heuristic

Filenames are identity, so a filesystem rename looks like delete + create. The rename heuristic collapses this:

**Client-side (watcher):**
1. On file unlink, hold in `pending_deletes` briefly (500ms)
2. If a new file appears within the window with an exact content hash match, treat as rename
3. If no match, finalize as deletion

**Server-side (sync reconciliation):**
1. If a single sync request contains delete `old.md` and create `new.md` with matching content hash, collapse to rename
2. Server updates its filename records; other devices receive the rename on next sync

**Scope:** Exact hash match only. This catches:
- Finder/Explorer rename
- Shell `mv`
- Obsidian rename
- Any external editor rename

It does NOT catch rename + edit in the same operation (content changed, hash doesn't match). That's treated as delete + create — the conservative correct behavior.

### Conflict resolution

Phase 1: **conflict copies only.** If both client and server changed the same file, the server keeps its version and creates a conflict copy (`"note (conflict 2026-03-28).md"`) containing the client's version. Both versions are sent to the client. The user resolves manually.

This is simple, safe, and debuggable. No silent bad merges.

**Phase 1.5 (future):** Three-way merge using the last-synced content as common ancestor. Attempted before creating a conflict copy. If the merge succeeds cleanly (edits in different sections), accept the merged result. If the merge has overlapping edits, fall back to conflict copy. This is an enhancement after the base is proven, not a Phase 1 requirement.

### Metadata conflict rules

| Scenario | Resolution | Rationale |
|---|---|---|
| Rename vs. rename (different names) | Server rename wins | Deterministic; user can re-rename |
| Rename vs. edit (on other device) | Both applied: new name + new content | Independent operations |
| Delete vs. edit | Server keeps edited version, notifies deleting client | Prevents silent data loss |
| Delete vs. delete | No-op | Both agree |

### Invariant checks (retained)

Post-sync invariants run on the server after every sync:

- **Content-hash parity:** every note's metadata hash matches the SHA-256 of the `.md` file on disk
- **No orphaned files:** every `.md` in the notes directory has metadata
- **No duplicate filenames:** uniqueness enforced
- **Tombstone exclusion:** no filename in both active notes and tombstones

Violations are logged with full context. The sync response still returns to the client.

### Recovery

If the client loses its app-state file:

1. Rescan the notes directory, compute hashes for all files
2. Set `lastServerVersion: 0` and clear `fileHashes`
3. Sync with full inventory
4. Server compares against its state:
   - Same filename + same hash → already converged, no action
   - Client-only file → upload to server
   - Server-only file → download to client
   - Same filename + different hash → normal conflict path
5. Rebuild `fileHashes` from sync result

No recovery folder. No database reconstruction. No dependence on hidden state surviving.

### Sync flow

```
        Device A                    Server                    Device B
           |                          |                          |
           |  edit grocery.md         |         edit todo.md     |
           |  create meeting.md      |                          |
           |                          |                          |
           |-- POST /sync ----------->|                          |
           |   changed: [grocery.md]  |  accept grocery.md      |
           |   new: [meeting.md]     |  accept meeting.md      |
           |                          |                          |
           |<-- update: [todo.md] ----|  (B's earlier edit)     |
           |   version: 13            |                          |
           |                          |                          |
           |                          |<-------- POST /sync -----|
           |                          |  inventory: [todo.md]    |
           |                          |                          |
           |                          |-- update: [grocery.md, --|
           |                          |   meeting.md]            |
           |                          |   version: 13            |
           |                          |                          |
           |  all three files on      |                          |  all three files on
           |  both devices            |                          |  both devices
```

### Future: collaboration

Real-time collaboration is not a v2 goal. If it becomes a priority, it would be a separate project — likely a CRDT layer (Yjs) for live editing sessions, with the hash-based protocol continuing for background multi-device sync. The two systems coexist. This is a separate decision with its own complexity budget.

---

## Server Architecture

V2 replaces the Hono/Node.js server with a single Rust binary built on Axum.

### Why move

| Problem in v1 | v2 solution |
|---|---|
| Native deps (node-llama-cpp, argon2, better-sqlite3, sharp) make builds fragile and images large | Single static Rust binary |
| Sync logic duplicated between TypeScript and Rust | Shared `stonefruit-core` crate |
| better-sqlite3 is synchronous; blocks the event loop | Tokio runtime; heavy work on `spawn_blocking` |

### Stack

- **Framework:** Axum 0.8+ (Tokio team, Tower middleware ecosystem)
- **Database:** rusqlite + sqlite-vec (vector search)
- **Auth:** `argon2` crate
- **Embeddings + LLM:** Ollama (external, called via `reqwest`)
- **Middleware:** Tower layers for compression, tracing, CORS, rate limiting

### Routes

| Method | Path | Purpose | Phase |
|---|---|---|---|
| POST | `/setup` | First-time password setup | 1 |
| POST | `/login` | Authenticate, return bearer token | 1 |
| POST | `/sync` | Filename-based note sync | 1 |
| POST | `/sync/check` | Quick-check (clock comparison) | 1 |
| PUT | `/blob/{filename}` | Image upload | 1 |
| GET | `/blob/{filename}` | Image download | 1 |
| GET | `/health` | Health check | 1 |
| GET | `/search?q=...` | Hybrid search (keyword + vector) | 2 |
| GET | `/graph/layout` | Pre-computed UMAP + K-Means layout | 2 |


### Server SQLite — metadata only

SQLite is supporting infrastructure, not the canonical note store. The notes directory is sufficient to recover the vault's content.

**SQLite owns:**

```sql
-- Auth
CREATE TABLE auth (
  id            INTEGER PRIMARY KEY CHECK(id = 1),
  password_hash TEXT,
  created_at    TEXT
);

CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,
  device_info TEXT,
  created_at  TEXT
);

-- Sync tracking
CREATE TABLE note_meta (
  filename     TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  modified_at  INTEGER NOT NULL,
  is_blob      INTEGER DEFAULT 0
);

CREATE TABLE tombstones (
  filename   TEXT PRIMARY KEY,
  deleted_at INTEGER
);

CREATE TABLE device_snapshots (
  device_id TEXT,
  filename  TEXT,
  hash      TEXT NOT NULL,
  PRIMARY KEY (device_id, filename)
);

CREATE TABLE sync_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Search (Phase 2, derived, rebuildable)
CREATE TABLE note_chunks (
  chunk_id   INTEGER PRIMARY KEY,
  filename   TEXT NOT NULL,
  chunk_text TEXT NOT NULL,
  embedding  FLOAT32[1024]
);

-- Ancestor content (Phase 1.5, supports three-way merge)
-- Caches note content by hash so the server can retrieve the common ancestor
-- when two devices edit the same note. Pruned after each sync: only retains
-- hashes still referenced by device_snapshots.
CREATE TABLE content_store (
  hash    TEXT PRIMARY KEY,
  content TEXT NOT NULL
);

-- Tags — user-applied labels for filtering and organization. Not yet exposed via API.
CREATE TABLE note_tags (
  filename TEXT,
  tag      TEXT,
  source   TEXT DEFAULT 'user',
  PRIMARY KEY (filename, tag)
);
```

**SQLite does NOT own:** note content. If the database is lost, rebuild it by scanning the notes directory.

### Embedding pipeline (Phase 2)

Background indexer on a Tokio task:

1. **Dirty tracking** — `note_meta.content_hash` compared against last-indexed hash
2. **Chunking** — paragraph-level, ~512 tokens
3. **Embedding** — `reqwest` → Ollama `/api/embed` (same external service used for LLM tasks)
4. **Storage** — `note_chunks` + sqlite-vec index

GPU is Ollama's concern — the server binary has no GPU dependencies.

### Plugins (deferred)

Plugin work is deferred from v2 entirely. When it's picked up, the runtime will be Rust-native (not a TS sidecar). Plugins write directly to notes — no proposal/review trust model.

### Docker

| | v1 | v2 |
|---|---|---|
| Base image | `node:22-slim` | `scratch` or distroless |
| Binary | node_modules + app JS | ~50 MB static Rust binary |
| Model | 396 MB GGUF bundled | None (Ollama is external) |
| Build deps | Python, make, g++ | None in final image |
| **Total** | **~1-1.5 GB** | **~50-100 MB** |

---

## Shared Crate

`stonefruit-core` eliminates the v1 duplication where hash computation, file I/O, filename sanitization, and sync logic exist independently in TypeScript and Rust.

### Workspace layout

```
crates/
├── stonefruit-core/              <-- shared library
│   ├── src/
│   │   ├── lib.rs
│   │   ├── files.rs              <-- atomic writes, path safety, filename sanitization
│   │   ├── sync.rs               <-- hash comparison, conflict rules, rename heuristic
│   │   ├── invariants.rs         <-- post-sync validation
│   │   ├── hash.rs               <-- SHA-256 content hashing
│   │   ├── search.rs             <-- keyword indexing, vector query, RRF fusion
│   │   └── graph.rs              <-- UMAP + K-Means layout
│   └── Cargo.toml
├── stonefruit-server/            <-- Axum binary
│   ├── src/
│   │   ├── main.rs
│   │   ├── routes/
│   │   └── indexer.rs
│   └── Cargo.toml
apps/
├── tauri/src-tauri/              <-- Tauri desktop/mobile shell
│   ├── src/
│   │   ├── lib.rs
│   │   └── core.rs               <-- thin #[tauri::command] wrappers over stonefruit-core
│   └── Cargo.toml
├── cli/                          <-- Server management CLI (Ratatui)
│   └── Cargo.toml
```

### Module responsibilities

**`files.rs`** — Atomic writes (temp + rename). Filename sanitization. Path traversal prevention. The "filename is the title" rule enforced here.

**`sync.rs`** — Hash comparison logic. Conflict detection. Rename heuristic (exact hash collapse). Metadata conflict resolution rules. This is the logic currently split between `engine.ts` (server) and `core.rs` (client).

**`invariants.rs`** — Post-sync validation. Content-hash parity, orphaned files, duplicate filenames, tombstone exclusion.

**`hash.rs`** — SHA-256 content hashing.

**`search.rs`** — Keyword indexing. Vector query helpers. RRF fusion.

**`graph.rs`** — UMAP + K-Means. Consolidated from `graph_positions.rs` and `graph_clusters.rs`.

---

## Client Architecture

V2 decomposes the monolithic frontend, moves app state out of the notes directory, and eliminates client-side embedding infrastructure. The client has no database.

### Component architecture

```
App.svelte
├── Router.svelte                    (~80 lines)
│   Route params, provides AppContext
├── Sidebar/
│   ├── NoteList.svelte              (~200 lines)
│   │   Note list, sort, filter, selection
│   └── SearchPanel.svelte           (~150 lines)
│       Search input, results, Cmd+K
├── Editor/
│   ├── NoteEditor.svelte            (~300 lines)
│   │   CodeMirror 6 (same as v1)
│   ├── TitleEditor.svelte           (~80 lines)
│   │   Inline rename, filename validation
│   └── ImagePaste.svelte            (~60 lines)
│       Clipboard paste -> image save
├── Sync/
│   └── SyncStatus.svelte            (~100 lines)
│       Status bar, error display
├── Graph/
│   └── GraphView.svelte             (~200 lines, lazy-loaded)
│       force-graph rendering from server layout
├── Settings/
│   └── SettingsPanel.svelte         (~200 lines)
│       Preferences, server config
└── services/
    ├── syncService.ts               (~150 lines)
    │   Hash-based sync + polling
    └── noteStore.ts                 (~100 lines)
        Local .md read/write via platform
```

Shared state via `AppContext` (Svelte 5 context with runes):

```typescript
export function createAppContext() {
  let activeNoteId = $state<string | null>(null);
  let notes = $state<NotePreview[]>([]);
  let syncActive = $state(false);
  let preferences = $state<Preferences>(defaults);
  return { activeNoteId, notes, syncActive, preferences };
}
```

### Client state — no database

One small JSON file in the app data directory (`~/.local/share/com.futo.notes/app-state.json`):

```json
{
  "serverUrl": "https://notes.example.com",
  "authToken": "bearer-token-here",
  "deviceId": "device-abc-123",
  "lastServerVersion": 42,
  "fileHashes": {
    "grocery list.md": "sha256-abc...",
    "meeting notes.md": "sha256-def..."
  },
  "preferences": {
    "theme": "dark",
    "sortOrder": "modified"
  }
}
```

That's it. No SQLite. No opaque sync metadata. `fileHashes` is the only sync state — it records what each file's hash was at last successful sync, so the client can compute what changed locally.

If this file is lost: rescan files, compute hashes, sync with the server, reconcile. No identity crisis, no database reconstruction.

### Editor

CodeMirror 6 with the same direct state management as v1. No new editor bindings. The existing `liveMarkdownTransform.ts`, scroll compensation, and cursor motion code carry forward unchanged.

### Platform layer

Two interfaces instead of one with 11 optional methods:

```typescript
interface FileSystem {
  list(dir: string): Promise<FileEntry[]>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  delete(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

interface NativeCapabilities {
  imageFromClipboard?(): Promise<Uint8Array | null>;
  openExternal?(url: string): Promise<void>;
}
```

### Offline behavior

| Operation | Offline | Connected |
|---|---|---|
| Create / edit / delete notes | Local `.md` files | Same + sync |
| Keyword search | MiniSearch (local) | MiniSearch (local) |
| Hybrid search | Keyword-only | `GET /search?q=...` (server-side) |
| Graph | Cached layout in app-state | `GET /graph/layout` (fresh) |
| Sync | Edits accumulate locally | Poll → sync → reconcile |

Keyword search is always local. Hybrid search (keyword + vector) is server-side only — an explicit design split. The client does not run inference or manage vector artifacts.

---

## Phasing Strategy

Each phase has a clear "done" definition. Nothing from a later phase leaks into an earlier one.

**No v1 → v2 migration.** Early alpha — users re-sync from scratch.

### Phase 1 — Foundation

The boring core. Split into sub-phases so each is a single plan session. Sub-phases within the same group can run in parallel (e.g. via agent teams); groups must complete sequentially.

#### Phase 1a — Shared Crate + Client UI Decomposition

These two workstreams have zero dependencies on each other and can run fully in parallel.

**Shared crate (`stonefruit-core`):**
- Cargo workspace setup (`crates/stonefruit-core/`, `crates/stonefruit-server/`, `apps/tauri/src-tauri/`)
- `hash.rs` — SHA-256 content hashing
- `files.rs` — atomic writes, path safety, filename sanitization
- `sync.rs` — hash comparison, conflict detection, rename heuristic (exact hash collapse), metadata conflict rules. Public types: `SyncRequest`, `SyncResponse`, `SyncInventoryItem`, `ConflictResolution`
- `invariants.rs` — post-sync validation (content-hash parity, orphaned files, duplicate filenames, tombstone exclusion)
- Unit tests for all modules

**Client UI decomposition (Svelte):**
- Decompose `NotesShell.svelte` (~2100 lines) into focused components:
  - `Router.svelte` (~80 lines) — route params, provides `AppContext`
  - `NoteList.svelte` (~200 lines) — note list, sort, filter, selection
  - `SearchPanel.svelte` (~150 lines) — search input, results, Cmd+K
  - `NoteEditor.svelte` (~300 lines) — CodeMirror 6 (same bindings as v1)
  - `TitleEditor.svelte` (~80 lines) — inline rename, filename validation
  - `ImagePaste.svelte` (~60 lines) — clipboard paste → image save
  - `SyncStatus.svelte` (~100 lines) — status bar, error display
  - `SettingsPanel.svelte` (~200 lines) — preferences, server config
- `AppContext` via Svelte 5 context with runes (`activeNoteId`, `notes`, `syncActive`, `preferences`)
- Carry forward CodeMirror 6 editor bindings unchanged (`liveMarkdownTransform.ts`, scroll compensation, cursor motion)

**Done when:** `stonefruit-core` compiles with passing unit tests and exports a stable public API. The Svelte app builds and runs with the decomposed components, behaving identically to v1 in offline-only mode.

#### Phase 1b — Rust Server + Client Sync Service

Depends on Phase 1a (consumes `stonefruit-core` types and requires decomposed client components to exist).

**Server (Axum):**
- `crates/stonefruit-server/` binary consuming `stonefruit-core`
- Auth: `/setup`, `/login` (argon2 password hashing, bearer tokens)
- Sync: `/sync`, `/sync/check` — filename-based, hash comparison, conflict copies
- Blobs: `PUT /blob/{filename}`, `GET /blob/{filename}` — image upload/download
- Health: `GET /health`
- SQLite schema: `auth`, `sessions`, `note_meta`, `tombstones`, `device_snapshots`, `sync_meta`
- Invariant checks after every sync (via `stonefruit-core::invariants`)
- Rename heuristic: exact hash collapse on delete+create within a single sync request
- `device_snapshots` table for per-device sync tracking

**Client sync service:**
- `app-state.json` in app data dir (`~/.local/share/com.futo.notes/`) — replaces 6+ dotfiles in notes dir
- `syncService.ts` (~150 lines): poll `/sync/check` → full `/sync` when needed → write `.md` files
- `noteStore.ts` (~100 lines): local `.md` read/write via `FileSystem` interface
- Platform layer: `FileSystem` + `NativeCapabilities` (2 interfaces, replacing `PlatformFS` with 11 optional methods)
- Filesystem watcher with rename heuristic (500ms pending-delete window, exact hash match)

**CLI:**
- Carry forward v1 unchanged.

**Done when:** A single client can authenticate with the Axum server, sync notes (create, edit, rename, delete), upload/download images, and recover from a lost `app-state.json` by rescanning.

#### Phase 1c — Integration + Test Suite

Depends on Phase 1b (requires working server and client sync service).

**Integration wiring:**
- End-to-end sync flow: two Tauri clients ↔ Axum server
- Conflict copy generation verified across two clients
- Rename propagation across devices
- Lost app-state recovery: delete `app-state.json` → rescan → sync → no data loss

**Test suite:**
- Golden-vault fixtures (`fixtures/golden-vaults/`):
  - `new-note-roundtrip`, `concurrent-edit-conflict`, `rename-propagation`
  - `rename-heuristic`, `rename-vs-rename`, `delete-propagation`
  - `delete-vs-edit`, `external-edit`, `blob-roundtrip`
  - `empty-vault-bootstrap`, `lost-app-state-recovery`, `large-inventory`
- Property-based sync convergence tests (`proptest`): convergence, preservation, commutativity, idempotency, invariant stability
- E2E: real Axum server in-process + two simulated clients with their own vault directories

**Explicitly NOT here:** search, graph, plugins, automations, collaboration, three-way merge.

**Done when:** Two clients can create, edit, rename, and delete notes offline, reconnect and converge, and survive lost client app-state by rescanning and reconciling — verified by the golden-vault test suite.

### Phase 1.5 — Three-Way Merge (optional hardening)

Add three-way text merge for concurrent edits, using last-synced content as common ancestor. Attempted before creating conflict copy. Falls back to conflict copy if merge has overlapping edits.

**Done when:** Two devices editing different sections of the same note merge cleanly without user intervention. Overlapping edits still produce conflict copies.

### Phase 2 — Search & Graph

**Server:**
- Embedding pipeline: Ollama + background indexer + sqlite-vec
- `GET /search?q=...` — hybrid (BM25 + vector, RRF fusion)
- `GET /graph/layout` — UMAP + K-Means

**Client:**
- Search UI: keyword-only offline, hybrid when connected
- Graph view: force-graph from server layout, cached in app-state

**Hardening:**
- Large vault edge cases (10k+ notes)
- Rate limiting on `/login`

**Done when:** User can search by meaning, view the graph, and sync handles 10k notes.

### Phase 3 — Automations & Plugins (deferred)

Deferred from v2. When pursued, the plugin runtime will be Rust-native:
- Rust plugin runtime (not a TS sidecar)
- Scheduler, Ollama integration
- Built-in plugins rewritten in Rust
- Plugins write directly via sync protocol

### Future: Collaboration

Not a v2 goal. Evaluated separately if it becomes a priority. Would layer a CRDT (Yjs) on top for live editing, with hash-based sync continuing for background multi-device sync.

---

## Testing Strategy

Integration tests are a day-one investment, not a Phase 2 afterthought.

### Golden-vault fixtures (highest priority)

`fixtures/golden-vaults/` — deterministic scenarios. Each fixture: input state, operations, expected output.

| Fixture | What it tests |
|---|---|
| `new-note-roundtrip` | Create on A → sync → appears on B |
| `concurrent-edit-conflict` | A and B edit same note → conflict copy created |
| `rename-propagation` | Rename on A → sync → B sees new filename |
| `rename-heuristic` | Delete old.md + create new.md with same hash → collapsed to rename |
| `rename-vs-rename` | A renames to X, B renames to Y → server wins |
| `delete-propagation` | Delete on A → sync → B removes note |
| `delete-vs-edit` | A deletes, B edits → server keeps edit |
| `external-edit` | Modify on disk → watcher → sync propagates |
| `blob-roundtrip` | Embed image on A → sync → B receives it |
| `empty-vault-bootstrap` | Fresh client syncs from server with existing notes |
| `lost-app-state-recovery` | Delete app-state.json → rescan → sync → no data loss |
| `large-inventory` | 1000+ files sync correctly |

Golden vaults are the sync engine's **specification**.

### Model-based sync tests

Property-based testing (`proptest`) generating random scenarios:

- **Convergence** — after all clients sync, every client has identical files
- **Preservation** — no data lost through any operation sequence
- **Commutativity** — sync order doesn't affect final state
- **Idempotency** — re-syncing when converged is a no-op
- **Invariant stability** — post-sync checks pass after every sequence

### E2E client + server integration

Real Axum server in-process. Multiple clients with their own vault directories:

- A creates 5 notes → syncs → B syncs → B has all 5
- A and B both edit same note → both sync → conflict copy exists on both
- A renames via `mv` → sync → B sees new filename
- A uploads image → syncs → B has it
- Server restarts mid-sync → client retries → no data loss
- Client loses app-state → rescans → syncs → converges

Real HTTP, real filesystem. No mocks except Tauri shell.

### Regression tests

Every bug fix includes a test reproducing the bug before the fix.

Focus areas:
- **Path safety:** `proptest` fuzzing of filenames through sanitize → filesystem → round-trip
- **Rename heuristic:** property tests on delete+create sequences
- **"Filename is the title" contract:** create → sync → rename → sync → verify on all clients

### Phase coverage

| Test layer | Phase 1 | Phase 2 |
|---|---|---|
| Golden-vault fixtures | Core sync, rename, conflict, recovery | + search assertions |
| Model-based sync | Convergence, preservation, invariants | + large vault stress |
| E2E client + server | Two-client sync, blobs, conflicts | + search, graph |
| Unit tests (Rust) | hash, files, sync, invariants, rename | + embedding, search |
| Playwright E2E | Basic editing | + search UI, graph |
| Regression | From day one | Cumulative |

### What we don't invest in early

- **Visual regression tests** — low value until UI stabilizes
- **Performance benchmarks** — premature until architecture settles
- **Mobile-specific tests** — defer to device QA
- **Load testing** — revisit if cloud hosting materializes
