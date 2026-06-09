//! `futo-notes-ffi` — the single UniFFI facade for the native iOS + Android
//! shells.
//!
//! Exposes two objects plus the deterministic rule functions:
//!   - `NoteStore` — note + folder CRUD and scanning (the iOS `NotesStore`
//!     business logic, now Rust-owned).
//!   - `SyncClient` — the E2EE sync client (relocated here from
//!     `futo-notes-sync`, which is now a plain library).
//!
//! Pure proc-macro scaffolding via `uniffi::setup_scaffolding!()`; async
//! methods are marshalled onto a tokio runtime. No build.rs / .udl required.

use std::path::PathBuf;
use std::sync::Arc;

use futo_notes_model as model;
use futo_notes_sync as sync;
use futo_notes_sync::{
    live::{LiveHandle, LiveFuture, SyncSessionListener},
    orchestrator::{SyncCounts, SyncErrorKind},
    session::SyncSession,
    state::ConnectedState,
};

/// No-op sync hooks. The native shell has no filesystem watcher to suppress
/// and no progress UI wired to the per-phase callback, so both hooks are
/// inert. (The Tauri desktop supplies real implementations.)
fn no_progress(_p: sync::orchestrator::SyncProgress) {}
fn no_pre_write(_f: &str) {}

uniffi::setup_scaffolding!();

// ════════════════════════════════════════════════════════════════════════
//  Note domain
// ════════════════════════════════════════════════════════════════════════

/// One note's list-level metadata (the FFI mirror of `model::NoteMetadata`).
/// `tags` are canonical lowercase names WITHOUT the leading `#`.
#[derive(uniffi::Record)]
pub struct NoteMetadata {
    pub id: String,
    pub title: String,
    pub folder: String,
    pub modified_ms: i64,
    pub preview: String,
    pub tags: Vec<String>,
}

impl From<model::NoteMetadata> for NoteMetadata {
    fn from(m: model::NoteMetadata) -> Self {
        NoteMetadata {
            id: m.id,
            title: m.title,
            folder: m.folder,
            modified_ms: m.modified_ms,
            preview: m.preview,
            tags: m.tags,
        }
    }
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

/// The note vault, rooted at a directory on disk. All methods are synchronous
/// filesystem operations — the Swift/Kotlin shell owns reactive state and
/// debouncing on top.
#[derive(uniffi::Object)]
pub struct NoteStore {
    root: PathBuf,
}

#[uniffi::export]
impl NoteStore {
    /// Build a store for the vault at `notes_root`. Does no I/O.
    #[uniffi::constructor]
    pub fn new(notes_root: String) -> Arc<Self> {
        Arc::new(Self {
            root: PathBuf::from(notes_root),
        })
    }

    /// Scan all notes, sorted by mtime descending.
    pub fn scan_notes(&self) -> Vec<NoteMetadata> {
        model::scan_notes(&self.root)
            .into_iter()
            .map(Into::into)
            .collect()
    }

    /// All folder paths (note ancestors + empty dirs), sorted.
    pub fn scan_folders(&self) -> Vec<String> {
        model::scan_folders(&self.root)
    }

    /// Read a note's content (`""` if missing).
    pub fn read(&self, id: String) -> String {
        model::read_note(&self.root, &id)
    }

    /// Whether a note exists on disk.
    pub fn exists(&self, id: String) -> bool {
        model::note_exists(&self.root, &id)
    }

    /// Atomically write a note's content.
    pub fn write(&self, id: String, content: String) -> Result<(), NoteError> {
        model::write_note(&self.root, &id, &content).map_err(NoteError::Io)
    }

    /// Create a note from a title (+ optional folder). Returns the final id.
    pub fn create_note(&self, title: String, folder: String) -> Result<String, NoteError> {
        model::create_note(&self.root, &folder, &title).map_err(NoteError::Io)
    }

    /// Delete a note (missing is not an error).
    pub fn delete(&self, id: String) -> Result<(), NoteError> {
        model::delete_note(&self.root, &id).map_err(NoteError::Io)
    }

    /// Rename/move a note. Returns the final (collision-resolved) id.
    pub fn rename(&self, old_id: String, new_id: String) -> Result<String, NoteError> {
        model::rename_note(&self.root, &old_id, &new_id).map_err(NoteError::Io)
    }

    /// Move a note into `folder` (`""` = root), keeping its leaf.
    pub fn move_note(&self, id: String, folder: String) -> Result<String, NoteError> {
        model::move_note(&self.root, &id, &folder).map_err(NoteError::Io)
    }

    /// Create a folder (+ intermediates). Returns the sanitized path (or `""`).
    pub fn create_folder(&self, path: String) -> Result<String, NoteError> {
        model::create_folder(&self.root, &path).map_err(NoteError::Io)
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

/// Wikilink targets (`[[target]]` / `[[target|alias]]`).
#[uniffi::export]
pub fn extract_wikilinks(content: String) -> Vec<String> {
    model::extract_wikilinks(&content)
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

/// Per-`sync_now` tallies.
#[derive(uniffi::Record)]
pub struct SyncSummary {
    pub uploaded: u32,
    pub downloaded: u32,
    pub deleted: u32,
    pub conflicts: u32,
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
            SyncErrorKind::NotConnected => SyncError::NotConnected,
        }
    }
}

impl From<SyncCounts> for SyncSummary {
    fn from(c: SyncCounts) -> Self {
        SyncSummary {
            uploaded: c.uploaded,
            downloaded: c.downloaded,
            deleted: c.deleted,
            conflicts: c.conflicts,
        }
    }
}

impl From<sync::orchestrator::SyncSummary> for SyncSummary {
    /// Map the rich orchestrator summary down to the four count fields the
    /// native shell exposes; the id-list / rename fields are dropped (native
    /// doesn't surface them).
    fn from(s: sync::orchestrator::SyncSummary) -> Self {
        SyncSummary {
            uploaded: s.uploaded,
            downloaded: s.downloaded,
            deleted: s.deleted,
            conflicts: s.conflicts,
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
    /// A live pull completed; `summary` carries its counts.
    fn on_synced(&self, summary: SyncSummary);
    /// The live stream connected (or reconnected) cleanly.
    fn on_connected(&self);
    /// A non-fatal error; the loop is reconnecting with backoff.
    fn on_error(&self, message: String);
    /// The live loop stopped (cancelled / disconnected / fatal auth error).
    fn on_stopped(&self);
}

/// Bridges the shared [`SyncSessionListener`] (called by `live::watch`) onto
/// the UniFFI `SyncEventListener` the native shell implements. The session
/// machinery is now adapter-agnostic; this is the FFI-side projection.
struct FfiListener(Arc<dyn SyncEventListener>);

impl SyncSessionListener for FfiListener {
    fn on_synced(&self, counts: SyncCounts) {
        self.0.on_synced(counts.into());
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
        let (connected, result) =
            sync::orchestrator::connect(&self.notes_root, &self.server_url, &password).await?;
        let info = ConnectInfo {
            user_id: result.user_id,
            collection_id: result.collection_id,
            auth_mode: result.auth_mode.to_owned(),
        };
        self.session.set_connected(connected).await;
        Ok(info)
    }

    /// Run one full sync cycle: PUSH local changes first, then pull peer
    /// changes (push-first `run_sync`, identical to the desktop orchestrator).
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
        let _gate = self.session.lock_sync_gate().await;
        let snapshot = self.session.snapshot().await.ok_or(SyncError::NotConnected)?;

        let (summary, after) = sync::orchestrator::run_sync(
            &snapshot,
            &self.notes_root,
            &no_progress,
            &no_pre_write,
        )
        .await?;

        self.session.set_connected(after).await;
        Ok(summary.into())
    }

    /// Synchronous status snapshot. Never blocks on I/O.
    pub fn status(&self) -> SyncStatus {
        match self.session.status_blocking() {
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
        if !self.session.is_connected().await {
            return Err(SyncError::NotConnected);
        }

        let listener: Arc<dyn SyncEventListener> = Arc::from(listener);
        let session_listener: Arc<dyn SyncSessionListener> = Arc::new(FfiListener(listener));

        let inner = self.session.inner_arc();
        let sync_gate = self.session.sync_gate_arc();
        let notes_root = self.notes_root.clone();

        self.session.start_live_with(
            session_listener,
            |listener| LiveHandle {
                snapshot: {
                    let inner = Arc::clone(&inner);
                    Box::new(move || -> LiveFuture<Option<ConnectedState>> {
                        let inner = Arc::clone(&inner);
                        Box::pin(async move { inner.lock().await.clone() })
                    })
                },
                cycle: {
                    let inner = Arc::clone(&inner);
                    let sync_gate = Arc::clone(&sync_gate);
                    let notes_root = notes_root.clone();
                    Box::new(move || -> LiveFuture<Result<Option<SyncCounts>, String>> {
                        let inner = Arc::clone(&inner);
                        let sync_gate = Arc::clone(&sync_gate);
                        let notes_root = notes_root.clone();
                        Box::pin(async move {
                            // Both live triggers — an SSE event ("a peer changed
                            // something") and a debounced local edit — run this
                            // same full push-first cycle, NOT a bare pull/push.
                            // A bare pull here would let a peer's edit overwrite a
                            // locally-edited-but-unpushed note on disk with no
                            // conflict copy (F1). `run_sync` PUSHes our dirty
                            // edits first (clean 3-way merge or conflict copy on
                            // 409), then pulls from the pre-push cursor — so a
                            // local edit can never silently vanish. Gate first,
                            // then brief inner locks — same discipline as
                            // `sync_now`, so the cursor can't regress.
                            let _gate = sync_gate.lock().await;
                            let snap = match inner.lock().await.clone() {
                                Some(s) => s,
                                None => return Ok(None),
                            };
                            let (summary, after) = sync::orchestrator::run_sync(
                                &snap,
                                &notes_root,
                                &no_progress,
                                &no_pre_write,
                            )
                            .await
                            .map_err(|e| SyncError::from(e).to_string())?;
                            *inner.lock().await = Some(after);
                            Ok(Some((&summary).into()))
                        })
                    })
                },
                listener,
            },
            |handle, cancel_rx, note_rx| {
                tokio::spawn(async move {
                    sync::live::watch(handle, cancel_rx, note_rx).await;
                })
            },
        );
        Ok(())
    }

    /// Stop live sync if running. Safe to call when not running.
    pub fn stop_live(&self) {
        self.session.stop_live();
    }

    /// Disconnect: stop live sync, clear the in-memory session, and delete the
    /// persisted `.e2ee-state.json`.
    pub async fn disconnect(&self) -> Result<(), SyncError> {
        self.session.stop_live();
        self.session.clear().await;
        sync::state::delete_state_file(&self.notes_root).map_err(SyncError::Io)?;
        Ok(())
    }
}
