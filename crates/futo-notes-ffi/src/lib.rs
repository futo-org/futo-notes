//! `futo-notes-ffi` — the single UniFFI facade for the native iOS + Android
//! shells.
//!
//! Exposes one local-note object plus the sync client and deterministic rules:
//!   - `NoteStore` — durable note/folder workflows and the owned search index.
//!   - `SyncClient` — the E2EE sync client (relocated here from
//!     `futo-notes-sync`, which is now a plain library).
//!
//! Pure proc-macro scaffolding via `uniffi::setup_scaffolding!()`; async
//! methods are marshalled onto a tokio runtime. No build.rs / .udl required.

use std::path::PathBuf;
use std::sync::Arc;

use futo_notes_model as model;
use futo_notes_store as notes;
use futo_notes_sync as sync;
use futo_notes_sync::{SyncErrorKind, SyncProgress, SyncSession, SyncSessionListener};

/// No-op sync hooks. The native shell has no filesystem watcher to suppress
/// and no progress UI wired to the per-phase callback, so both hooks are
/// inert. (The Tauri desktop supplies real implementations.)
fn no_progress(_p: SyncProgress) {}
fn no_pre_write(_f: &str) {}

uniffi::setup_scaffolding!();

// ════════════════════════════════════════════════════════════════════════
//  Note domain
// ════════════════════════════════════════════════════════════════════════

/// One note's list-level metadata.
/// `tags` are canonical lowercase names WITHOUT the leading `#`.
#[derive(uniffi::Record)]
pub struct NoteMetadata {
    pub id: String,
    pub title: String,
    pub folder: String,
    pub modified_ms: i64,
    pub preview: String,
    /// Multi-line, display-oriented preview (see `make_rich_preview`).
    pub rich_preview: String,
    pub tags: Vec<String>,
}

impl From<notes::NoteMetadata> for NoteMetadata {
    fn from(m: notes::NoteMetadata) -> Self {
        NoteMetadata {
            id: m.id,
            title: m.title,
            folder: m.folder,
            modified_ms: m.modified_ms,
            preview: m.preview,
            rich_preview: m.rich_preview,
            tags: m.tags,
        }
    }
}

#[derive(uniffi::Record)]
pub struct NoteSnapshot {
    pub notes: Vec<NoteMetadata>,
    pub folders: Vec<String>,
}

impl From<notes::Snapshot> for NoteSnapshot {
    fn from(snapshot: notes::Snapshot) -> Self {
        Self {
            notes: snapshot.notes.into_iter().map(Into::into).collect(),
            folders: snapshot.folders,
        }
    }
}

#[derive(uniffi::Record)]
pub struct NoteRename {
    pub from: String,
    pub to: String,
}

#[derive(uniffi::Record)]
pub struct NoteMutation {
    pub upserted: Vec<NoteMetadata>,
    pub removed: Vec<String>,
    pub renamed: Vec<NoteRename>,
    pub warnings: Vec<String>,
}

impl From<notes::MutationResult> for NoteMutation {
    fn from(mutation: notes::MutationResult) -> Self {
        Self {
            upserted: mutation.upserted.into_iter().map(Into::into).collect(),
            removed: mutation.removed,
            renamed: mutation
                .renamed
                .into_iter()
                .map(|rename| NoteRename {
                    from: rename.from,
                    to: rename.to,
                })
                .collect(),
            warnings: mutation.warnings,
        }
    }
}

#[derive(uniffi::Record)]
pub struct NoteBootstrap {
    pub snapshot: NoteSnapshot,
    pub seeded: u32,
    pub migrated: u32,
    pub warnings: Vec<String>,
}

/// Folder + title split of a note id.
#[derive(uniffi::Record)]
pub struct NoteIdParts {
    pub folder: String,
    pub title: String,
}

#[derive(Debug, uniffi::Error, thiserror::Error)]
pub enum NoteError {
    #[error("{0}")]
    Io(String),
}

/// Outcome of `NoteStore::write_if_unchanged` (the FFI mirror of
/// `model::FlushOutcome`).
#[derive(Debug, PartialEq, Eq, uniffi::Enum)]
pub enum FlushOutcome {
    /// The note still held the expected content; the flush was written.
    Wrote,
    /// The note no longer exists — nothing written (never resurrected).
    SkippedMissing,
    /// The note changed since the editor's last read — nothing written (the
    /// change, e.g. a live-sync adoption, is preserved).
    SkippedChanged,
}

impl From<notes::FlushOutcome> for FlushOutcome {
    fn from(o: notes::FlushOutcome) -> Self {
        match o {
            notes::FlushOutcome::Wrote => FlushOutcome::Wrote,
            notes::FlushOutcome::SkippedMissing => FlushOutcome::SkippedMissing,
            notes::FlushOutcome::SkippedChanged => FlushOutcome::SkippedChanged,
        }
    }
}

/// Outcome of `NoteStore::create_if_absent` (the FFI mirror of
/// `notes::CreateOutcome`).
#[derive(Debug, PartialEq, Eq, uniffi::Enum)]
pub enum CreateOutcome {
    /// No file existed; `content` was created at the id.
    Created,
    /// A file already exists at the id — nothing written (a concurrent writer,
    /// e.g. a live-sync pull, got there first).
    Existed,
}

impl From<notes::CreateOutcome> for CreateOutcome {
    fn from(o: notes::CreateOutcome) -> Self {
        match o {
            notes::CreateOutcome::Created => CreateOutcome::Created,
            notes::CreateOutcome::Existed => CreateOutcome::Existed,
        }
    }
}

#[derive(uniffi::Record)]
pub struct ConditionalWrite {
    pub outcome: FlushOutcome,
    pub mutation: Option<NoteMutation>,
}

/// The note vault, rooted at a directory on disk. All methods are synchronous
/// filesystem operations — the Swift/Kotlin shell owns reactive state and
/// debouncing on top.
#[derive(uniffi::Object)]
pub struct NoteStore {
    inner: notes::LocalNoteStore,
}

#[uniffi::export]
impl NoteStore {
    /// Build a store for the vault at `notes_root`. Does no I/O.
    #[uniffi::constructor]
    pub fn new(notes_root: String) -> Arc<Self> {
        Arc::new(Self {
            inner: notes::LocalNoteStore::new(PathBuf::from(notes_root)),
        })
    }

    /// Run one-way migrations + first-run seed, return the initial snapshot,
    /// and start the owned BM25 index in the background.
    pub fn bootstrap(&self, index_dir: String) -> Result<NoteBootstrap, NoteError> {
        let result = self
            .inner
            .bootstrap_with_search(PathBuf::from(index_dir), Arc::new(|_| {}))
            .map_err(NoteError::Io)?;
        Ok(NoteBootstrap {
            snapshot: result.snapshot.into(),
            seeded: result.seeded,
            migrated: result.migrated,
            warnings: result.warnings,
        })
    }

    pub fn scan(&self) -> NoteSnapshot {
        self.inner.snapshot().into()
    }

    /// Read a note's content (`""` if missing).
    pub fn read(&self, id: String) -> String {
        self.inner.read(&id)
    }

    /// Whether a note exists on disk.
    pub fn exists(&self, id: String) -> bool {
        self.inner.exists(&id)
    }

    /// Atomically write a note's content.
    pub fn write(&self, id: String, content: String) -> Result<NoteMutation, NoteError> {
        self.inner
            .write(&id, &content, None)
            .map(Into::into)
            .map_err(NoteError::Io)
    }

    /// Conditional flush for a backgrounded editor: write `content` only if the
    /// note still holds `expected_prev`. One call replaces the shell's old
    /// `exists()`-then-`write()` sequence, collapsing its cross-FFI TOCTOU — a
    /// note deleted while backgrounded returns [`FlushOutcome::SkippedMissing`]
    /// (never resurrected), and content adopted by a live-sync pull since the
    /// editor's last read returns [`FlushOutcome::SkippedChanged`] (never
    /// clobbered). Check-then-atomic-write, NOT a true CAS — a narrow residual
    /// single-process syscall window remains and is accepted; see
    /// `model::write_note_if_unchanged` for the full rationale.
    pub fn write_if_unchanged(
        &self,
        id: String,
        expected_prev: String,
        content: String,
    ) -> Result<ConditionalWrite, NoteError> {
        self.inner
            .write_if_unchanged(&id, &expected_prev, &content)
            .map(|result| ConditionalWrite {
                outcome: result.outcome.into(),
                mutation: result.mutation.map(Into::into),
            })
            .map_err(NoteError::Io)
    }

    /// Atomically (re-)create a note with `content` ONLY IF no file exists at
    /// `id` yet (no-replace `hard_link` install). The editor's leave/background
    /// flush uses this to honor the peer-delete dirty-keep edit-wins semantic —
    /// recreate a just-`SkippedMissing` note — without the unconditional-write
    /// clobber risk: a live-sync pull writing the same id OUTSIDE this store's
    /// serialization cannot have its content overwritten. Returns
    /// [`CreateOutcome::Existed`] if the id reappeared in the window (caller
    /// parks a conflict copy instead). See `LocalNoteStore::create_if_absent`.
    pub fn create_if_absent(
        &self,
        id: String,
        content: String,
    ) -> Result<CreateOutcome, NoteError> {
        self.inner
            .create_if_absent(&id, &content)
            .map(CreateOutcome::from)
            .map_err(NoteError::Io)
    }

    pub fn create_note(
        &self,
        title: String,
        folder: String,
        content: String,
    ) -> Result<NoteMutation, NoteError> {
        self.inner
            .create(&folder, &title, &content)
            .map(Into::into)
            .map_err(NoteError::Io)
    }

    /// Delete a note (missing is not an error).
    pub fn delete(&self, id: String) -> Result<NoteMutation, NoteError> {
        self.inner
            .delete(&id)
            .map(Into::into)
            .map_err(NoteError::Io)
    }

    /// Rename/move a note. Returns the final (collision-resolved) id.
    pub fn rename(&self, old_id: String, new_id: String) -> Result<NoteMutation, NoteError> {
        self.inner
            .rename(&old_id, &new_id)
            .map(Into::into)
            .map_err(NoteError::Io)
    }

    /// Move a note into `folder` (`""` = root), keeping its leaf.
    pub fn move_note(&self, id: String, folder: String) -> Result<NoteMutation, NoteError> {
        self.inner
            .move_note(&id, &folder)
            .map(Into::into)
            .map_err(NoteError::Io)
    }

    /// Create a folder (+ intermediates). Returns the sanitized path (or `""`).
    pub fn create_folder(&self, path: String) -> Result<String, NoteError> {
        self.inner.create_folder(&path).map_err(NoteError::Io)
    }

    pub fn rename_folder(&self, from: String, to: String) -> Result<NoteMutation, NoteError> {
        self.inner
            .rename_folder(&from, &to)
            .map(Into::into)
            .map_err(NoteError::Io)
    }

    /// Delete a folder with move-up semantics (Tauri parity): every note
    /// under `folder/` moves to the parent with the deleted segment removed
    /// (deeper structure preserved, collisions `-2`-suffixed), wikilinks to
    /// each moved note are rewritten, then the note-empty folder tree is
    /// removed. If ANY move fails, nothing is deleted and an error is
    /// returned (already-moved notes stay moved). A missing folder is a
    /// no-op `Ok(0)`. Returns the moved-note count.
    pub fn delete_folder(&self, folder: String) -> Result<NoteMutation, NoteError> {
        self.inner
            .delete_folder(&folder)
            .map(Into::into)
            .map_err(NoteError::Io)
    }

    pub fn reset(&self) -> Result<(), NoteError> {
        self.inner.reset().map_err(NoteError::Io)
    }

    pub fn search(&self, query: String, limit: Option<u32>) -> Result<Vec<SearchHit>, NoteError> {
        self.inner
            .search(&query, limit.map(|value| value as usize))
            .map(|hits| hits.into_iter().map(Into::into).collect())
            .map_err(NoteError::Io)
    }

    pub fn keyword_ready(&self) -> bool {
        self.inner.search_status().keyword.ready
    }

    pub fn rescan(&self) {
        self.inner.rebuild_search();
    }
}

// ── Deterministic rule helpers (free functions) ─────────────────────────

/// Canonical title sanitization (strips forbidden chars, trims, fallback to
/// "Untitled"; does NOT truncate).
#[uniffi::export]
pub fn sanitize_title(title: String) -> String {
    model::sanitize_title(&title)
}

/// Compose a note id from a folder + title.
#[uniffi::export]
pub fn make_id(folder: String, title: String) -> String {
    model::make_id(&folder, &title)
}

/// Split a note id into `(folder, title)`.
#[uniffi::export]
pub fn split_id(id: String) -> NoteIdParts {
    let (folder, title) = model::split_id(&id);
    NoteIdParts { folder, title }
}

/// Canonical inline tags for content, WITHOUT the leading `#`.
#[uniffi::export]
pub fn extract_tags(content: String) -> Vec<String> {
    model::note_tags(&content)
}

/// ~100-char single-line preview.
#[uniffi::export]
pub fn make_preview(content: String) -> String {
    model::make_preview(&content)
}

/// A single title-validation issue (FFI mirror of the model's `FilenameIssue`).
/// `kind` is the stable snake_case identifier — "forbidden_chars", "leading_dots",
/// "trailing_dots", "too_long", or "empty" — matching the TS `FilenameIssueKind`
/// union; `message` is the user-facing string (byte-identical to desktop).
#[derive(uniffi::Record)]
pub struct TitleIssue {
    pub kind: String,
    pub message: String,
}

/// Validate a note title against the shared filename rules (single source:
/// futo-notes-model). Returns the issues found (empty when the title is legal),
/// so the native shells can render desktop's reject-illegal-title UX without
/// reimplementing the rules. Does NOT modify the title — use `sanitize_title`.
#[uniffi::export]
pub fn validate_title(title: String) -> Vec<TitleIssue> {
    model::validate_title(&title)
        .into_iter()
        .map(|i| TitleIssue {
            kind: i.kind.as_str().to_string(),
            message: i.message,
        })
        .collect()
}

/// Multi-line, display-oriented preview for native note lists. Drops tables,
/// strips heading/quote markers, turns task items into ☐/☑ and bullets into •,
/// and preserves line breaks — while leaving inline `**bold**`/`*italic*` for
/// the platform renderer.
#[uniffi::export]
pub fn make_rich_preview(content: String) -> String {
    model::make_rich_preview(&content)
}

/// Wikilink targets (`[[target]]` / `[[target|alias]]`).
#[uniffi::export]
pub fn extract_wikilinks(content: String) -> Vec<String> {
    model::extract_wikilinks(&content)
}

// ════════════════════════════════════════════════════════════════════════
//  Search (keyword/BM25)
// ════════════════════════════════════════════════════════════════════════

/// A ranked search hit. `source` is always `"bm25"` on main.
#[derive(uniffi::Record)]
pub struct SearchHit {
    pub note_id: String,
    pub score: f64,
    /// "bm25" (keyword-only build).
    pub source: String,
}

impl From<notes::SearchHit> for SearchHit {
    fn from(hit: notes::SearchHit) -> Self {
        Self {
            note_id: hit.note_id,
            score: hit.score as f64,
            source: hit.source,
        }
    }
}

// ════════════════════════════════════════════════════════════════════════
//  Sync (relocated from futo-notes-sync's UniFFI surface)
// ════════════════════════════════════════════════════════════════════════

/// Outcome of a successful `connect`.
#[derive(uniffi::Record)]
pub struct ConnectInfo {
    pub user_id: String,
    pub collection_id: String,
    pub auth_mode: String,
}

/// Per-cycle tallies, for both `sync_now` and live-loop `on_synced`.
#[derive(uniffi::Record)]
pub struct SyncSummary {
    pub uploaded: u32,
    pub downloaded: u32,
    pub deleted: u32,
    pub conflicts: u32,
    /// Count of note files this cycle wrote to the LOCAL notes tree — peer
    /// downloads AND push-side clean merges / conflict copies / restores.
    /// A push-side merge (`MergedClean`) bumps `uploaded` only, NOT
    /// `downloaded`/`deleted`, so a shell that reloads its open editor on
    /// `downloaded`/`deleted` alone silently drops the merged-in peer edit
    /// (F2). Gate the reload on this instead/additionally: it is the
    /// core-computed "the disk changed" decision — shells render it, they
    /// don't re-derive it from the semantic counts.
    pub local_writes_applied: u32,
    /// Per-item operations that failed WITHOUT aborting the cycle (upload /
    /// delete / checkpoint errors — a channel distinct from `conflicts`).
    /// Non-empty means the cycle "completed" but not cleanly; the shells
    /// must not report success.
    pub failures: Vec<SyncFailure>,
    /// User-facing one-liner describing `failures`, computed once in
    /// `futo-notes-sync` so every shell shows identical wording. `None` for
    /// a clean cycle.
    pub failure_message: Option<String>,
}

/// One per-item sync failure. `kind` is `"upload" | "delete" | "checkpoint"
/// | "download" | "decrypt" | "rejected"`; `status_code` is the server HTTP
/// status when the failure came from a response (`None` for transport/local
/// errors). `"rejected"` is a permanent unsupported-name skip (not retried).
#[derive(uniffi::Record)]
pub struct SyncFailure {
    pub filename: String,
    pub kind: String,
    pub status_code: Option<u16>,
}

/// Snapshot of the client's connection state.
#[derive(uniffi::Record)]
pub struct SyncStatus {
    pub connected: bool,
    pub server_url: Option<String>,
    pub user_id: Option<String>,
    pub collection_id: Option<String>,
    pub max_version: u64,
    pub object_count: u32,
}

#[derive(Debug, uniffi::Error, thiserror::Error)]
pub enum SyncError {
    #[error("HTTP error: {0}")]
    Http(String),
    #[error("crypto error: {0}")]
    Crypto(String),
    #[error("I/O error: {0}")]
    Io(String),
    #[error("auth error: {0}")]
    Auth(String),
    /// The vault this client was pinned to no longer exists on the server
    /// (404) — e.g. a duplicate collapsed by the single-vault migration. The
    /// shell heals by re-connecting: `connect()` re-picks the surviving
    /// canonical vault and the reset→reconcile→push re-uploads local notes. The
    /// message is prefixed `collection-gone:`. Surfaced from `sync_now` and
    /// (as an `on_error` string) from the live loop.
    #[error("{0}")]
    CollectionGone(String),
    #[error("not connected")]
    NotConnected,
}

impl From<SyncErrorKind> for SyncError {
    fn from(k: SyncErrorKind) -> Self {
        match k {
            SyncErrorKind::Http(s) => SyncError::Http(s),
            SyncErrorKind::Crypto(s) => SyncError::Crypto(s),
            SyncErrorKind::Io(s) => SyncError::Io(s),
            SyncErrorKind::Auth(s) => SyncError::Auth(s),
            // Native DOES produce this: `sync_now`/the live loop reach the pull
            // path (`run_pull`/`reconcile_empty_map`), which maps a 404 on the
            // pinned collection to CollectionGone. Surface it distinctly so the
            // shell can re-point to the surviving vault instead of showing a
            // dead-end error.
            SyncErrorKind::CollectionGone(s) => SyncError::CollectionGone(s),
            SyncErrorKind::NotConnected => SyncError::NotConnected,
        }
    }
}

impl From<sync::SyncSummary> for SyncSummary {
    /// Map the rich engine summary down to the count + failure fields
    /// the native shell exposes; the id-list / rename fields are dropped
    /// (native doesn't surface them).
    fn from(s: sync::SyncSummary) -> Self {
        SyncSummary {
            uploaded: s.uploaded,
            downloaded: s.downloaded,
            deleted: s.deleted,
            conflicts: s.conflicts,
            local_writes_applied: s.local_writes_applied,
            failure_message: s.failure_message(),
            failures: s
                .failures
                .into_iter()
                .map(|f| SyncFailure {
                    filename: f.filename,
                    kind: f.kind.as_str().to_owned(),
                    status_code: f.status_code,
                })
                .collect(),
        }
    }
}

/// Foreign (Kotlin/Swift) listener for live-sync events. UniFFI generates an
/// interface the native shell implements.
///
/// IMPORTANT: these methods fire on a tokio worker thread, NOT the UI thread.
/// Implementations must be cheap and must marshal to the main thread before
/// touching UI state. Calling back into `SyncClient::status()` is safe — it
/// uses `try_lock` and degrades to a disconnected snapshot on contention
/// rather than blocking or panicking a runtime worker.
#[uniffi::export(callback_interface)]
pub trait SyncEventListener: Send + Sync {
    /// A live pull completed; `summary` carries the full per-cycle result,
    /// including per-item failures and the shared `failure_message`.
    fn on_synced(&self, summary: SyncSummary);
    /// The live stream connected (or reconnected) cleanly.
    fn on_connected(&self);
    /// A non-fatal error; the loop is reconnecting with backoff.
    fn on_error(&self, message: String);
    /// The live loop stopped (cancelled / disconnected / fatal auth error).
    fn on_stopped(&self);
}

/// Bridges the shared [`SyncSessionListener`] onto
/// the UniFFI `SyncEventListener` the native shell implements. The session
/// machinery is now adapter-agnostic; this is the FFI-side projection.
struct FfiListener(Arc<dyn SyncEventListener>);

impl SyncSessionListener for FfiListener {
    fn on_synced(&self, summary: sync::SyncSummary) {
        self.0.on_synced(summary.into());
    }
    fn on_connected(&self) {
        self.0.on_connected();
    }
    fn on_error(&self, message: String) {
        self.0.on_error(message);
    }
    fn on_stopped(&self) {
        self.0.on_stopped();
    }
}

/// The UniFFI-exported sync client. One instance per vault; holds the notes
/// root, the server URL, and the shared [`SyncSession`] (the optional
/// connected session, the sync-gate, and the live-task handle).
#[derive(uniffi::Object)]
pub struct SyncClient {
    notes_root: PathBuf,
    server_url: String,
    session: SyncSession,
}

#[uniffi::export(async_runtime = "tokio")]
impl SyncClient {
    /// Build a client for the vault at `notes_root`, syncing against
    /// `server_url` (e.g. `http://127.0.0.1:3100`). Does no I/O.
    #[uniffi::constructor]
    pub fn new(notes_root: String, server_url: String) -> Arc<Self> {
        Arc::new(Self {
            notes_root: PathBuf::from(notes_root),
            server_url,
            session: SyncSession::new(),
        })
    }

    /// Connect: probe auth mode, log in, pick/create the collection, fetch or
    /// mint the vault key, unwrap it with `password`, and load the persisted
    /// object map. Replaces any existing session.
    pub async fn connect(&self, password: String) -> Result<ConnectInfo, SyncError> {
        let result = self
            .session
            .connect(&self.notes_root, &self.server_url, &password)
            .await?;
        let info = ConnectInfo {
            user_id: result.user_id,
            collection_id: result.collection_id,
            auth_mode: result.auth_mode.to_owned(),
        };
        Ok(info)
    }

    /// Run one full sync cycle: PUSH local changes first, then pull peer
    /// changes (the same push-first cycle used by desktop).
    ///
    /// Push-first is the data-safety invariant: a dirty local edit is PUT
    /// before any pull writes to disk, so a peer edit can never silently
    /// clobber a locally-edited-but-unpushed note. On a 409 the push side runs
    /// the 3-way merge / conflict-copy machinery; the subsequent pull starts
    /// from the pre-push cursor so the just-pushed edit is never re-downloaded.
    /// (The old pull-then-push order let `run_pull`'s atomic write overwrite an
    /// unpushed local edit with no conflict copy — F1.)
    ///
    /// Holds the sync-gate for the whole cycle (serializing against the live
    /// loop) but locks the session only briefly — to clone it up front and
    /// commit the result at the end — so a concurrent `status()` never blocks
    /// behind network I/O.
    pub async fn sync_now(&self) -> Result<SyncSummary, SyncError> {
        let summary = self
            .session
            .sync(&self.notes_root, &no_progress, &no_pre_write)
            .await?;
        Ok(summary.into())
    }

    /// Synchronous status snapshot. Never blocks on I/O.
    pub fn status(&self) -> SyncStatus {
        match self.session.status() {
            None => SyncStatus {
                connected: false,
                server_url: None,
                user_id: None,
                collection_id: None,
                max_version: 0,
                object_count: 0,
            },
            Some(c) => SyncStatus {
                connected: true,
                server_url: Some(c.base_url),
                user_id: Some(c.user_id),
                collection_id: Some(c.collection_id),
                max_version: c.max_version,
                object_count: c.object_map.len() as u32,
            },
        }
    }

    /// Signal that a local note changed. Drives the write-once auto-push
    /// branch: the live loop debounces and pushes the edit to peers (no-op
    /// when no live task is running / disconnected). The native `NoteStore`
    /// write path should call this on every write/create/delete/rename.
    pub fn note_changed(&self) {
        self.session.note_changed();
    }

    /// Start SSE-driven live sync. Spawns a background task that opens the
    /// server's event stream and pulls on every `ready`/`change` (plus a 45s
    /// safety poll), pushes debounced local edits (see `note_changed`), and
    /// reconnects with backoff. Idempotent: replaces any existing live task.
    /// Requires `connect` to have run first.
    pub async fn start_live(
        self: Arc<Self>,
        listener: Box<dyn SyncEventListener>,
    ) -> Result<(), SyncError> {
        let listener: Arc<dyn SyncEventListener> = Arc::from(listener);
        let session_listener: Arc<dyn SyncSessionListener> = Arc::new(FfiListener(listener));
        self.session
            .start_live(
                self.notes_root.clone(),
                session_listener,
                Arc::new(no_pre_write),
            )
            .await?;
        Ok(())
    }

    /// Stop live sync if running. Safe to call when not running.
    pub fn stop_live(&self) {
        self.session.stop_live();
    }

    /// Disconnect: stop live sync, clear the in-memory session, and demote the
    /// persisted `.e2ee-state.json` to `.e2ee-ancestry.json` — the live
    /// cursor/object map is dropped (so a reconnect can never propagate
    /// while-disconnected deletions), but the last-synced filename →
    /// {objectId, hash} pairs survive so the reconnect's empty-map reconcile
    /// can fast-forward drifted-but-unedited notes instead of parking a
    /// `(conflict <oid8>)` copy of each one.
    pub async fn disconnect(&self) -> Result<(), SyncError> {
        self.session.disconnect(&self.notes_root).await?;
        Ok(())
    }
}
