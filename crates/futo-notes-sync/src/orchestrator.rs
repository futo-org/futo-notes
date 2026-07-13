//! Tauri-free E2EE sync orchestrator.
//!
//! This is the FULL orchestrator relocated verbatim from the desktop's
//! the desktop adapter in `apps/tauri/src-tauri/src/sync/` so the crate is the single source of
//! truth for BOTH the Tauri desktop app and the native iOS/Android shells
//! (via `futo-notes-ffi`).
//!
//! The orchestration LOGIC is byte-identical to the desktop. Exactly three
//! Tauri touchpoints were adapted:
//!
//!   1. **Progress** — the `ProgressEmitter` no longer holds an `AppHandle`;
//!      its sink is a generic `Box<dyn Fn(SyncProgress) + Send + Sync>`. The
//!      50ms-coalesce throttle is unchanged. `run_pull` / `run_push` /
//!      `reconcile_empty_map` / `run_sync` take a `progress: &ProgFn`.
//!   2. **Apply** — `apply_delta` replaces the Tauri watcher-suppression map
//!      (`&Arc<Mutex<HashMap<String,i64>>>` + `suppress_filename`) with a
//!      `pre_write: &PreWriteFn` hook called at exactly the same points.
//!   3. **State** — instead of mutating a Tauri `SyncState` cell via
//!      `with_map_mut` + `state.persist`, each function takes a
//!      `&ConnectedState`, clones it, mutates the clone, calls
//!      `state::persist`, and RETURNS the new `ConnectedState`.
//!
//! `connect` is the pre-existing Tauri-free connect and is left untouched.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Instant;

use futo_notes_core::e2ee::{
    self, collision_conflict_filename, collision_key, conflict_filename, KeyMaterial, MergeResult,
    KEY_BYTES,
};
use futo_notes_core::files::{
    classify_incoming_sync_path, file_mtime_ms, now_ms, read_blob_as_base64, set_file_mtime_ms,
    write_atomic_text, write_base64_as_blob, IncomingSyncPath,
};
use futo_notes_core::hash::hash_sha256;
use futo_notes_core::image::{is_image_filename, is_syncable_filename};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use crate::client::{
    parse_iso_ms, AuthMode, BatchBlobStatus, ConflictResponse, DeleteResult, E2eeClient,
    E2eeHttpError, ObjectWriteResponse, PutResult, ServerObject,
};
use crate::state::{self, ConnectedState, E2eeObjectMapEntry};

const PULL_CONCURRENCY: usize = 8;
const PUSH_CONCURRENCY: usize = 8;
const PROGRESS_COALESCE_MS: i64 = 50;

// ── Batch pull tuning ──
// Blobs are bin-packed (smallest first, using the size_bytes already in the
// objects listing) into batch requests of ≤TARGET_CHUNK_BYTES/≤MAX_BATCH_KEYS,
// fetched DOWNLOAD_CONCURRENCY at a time. 4 × 8 MiB bounds peak buffered
// response memory at ~32 MiB (mobile-safe) while keeping the pipe full; blobs
// at or over the chunk target gain nothing from batching and go through the
// per-blob path, sized-timeout'd individually.
const TARGET_CHUNK_BYTES: u64 = 8 * 1024 * 1024;
/// Client-side keys-per-batch cap. Deliberately half the server's
/// MAX_BATCH_KEYS (200) so the two limits can never disagree in practice.
const MAX_BATCH_KEYS: usize = 100;
const DOWNLOAD_CONCURRENCY: usize = 4;
/// Whole-chunk retries (a chunk failure hits up to 100 objects, so unlike
/// the per-blob path it earns a retry ladder) before degrading that chunk
/// to per-blob GETs — which isolates a poison blob instead of sinking its
/// neighbors, and is exactly the pre-batch code path.
const BATCH_RETRY_BACKOFF: [std::time::Duration; 2] = [
    std::time::Duration::from_millis(500),
    std::time::Duration::from_secs(2),
];

// ── Hook types (Rule 1 + Rule 2 adaptations) ─────────────────────────────

/// Progress event surfaced to the caller (replaces the Tauri
/// `sync:progress` event payload).
pub struct SyncProgress {
    pub phase: &'static str,
    pub current: usize,
    pub total: usize,
}

/// Progress sink — the Tauri app forwards to `app.emit("sync:progress", …)`;
/// native shells pass a no-op.
pub type ProgFn = dyn Fn(SyncProgress) + Send + Sync;

/// Pre-write hook — called with each filename immediately before it is
/// written/deleted/conflict-copied on disk. The Tauri app uses it to suppress
/// its filesystem watcher; native shells pass a no-op.
pub type PreWriteFn = dyn Fn(&str) + Send + Sync;

// ── Progress emitter ────────────────────────────────────────────────────

/// Emit progress events with a 50ms throttle so a 2000-file vault doesn't
/// slam the sink. Final `current == total` emit always fires so the UI sees
/// a clean completion frame.
struct ProgressEmitter<'a> {
    emit: &'a ProgFn,
    phase: &'static str,
    total: usize,
    current: AtomicUsize,
    last_emit_ms: AtomicI64,
}

impl<'a> ProgressEmitter<'a> {
    fn new(emit: &'a ProgFn, phase: &'static str, total: usize) -> Self {
        let me = Self {
            emit,
            phase,
            total,
            current: AtomicUsize::new(0),
            last_emit_ms: AtomicI64::new(0),
        };
        me.emit_force(0);
        me
    }

    fn bump(&self) {
        let n = self.current.fetch_add(1, Ordering::Relaxed) + 1;
        let now = now_ms();
        let last = self.last_emit_ms.load(Ordering::Relaxed);
        if n == self.total || now - last > PROGRESS_COALESCE_MS {
            self.last_emit_ms.store(now, Ordering::Relaxed);
            self.emit_force(n);
        }
    }

    fn emit_force(&self, current: usize) {
        (self.emit)(SyncProgress {
            phase: self.phase,
            current,
            total: self.total,
        });
    }
}

// ── Auth-mode helper (used by connect) ───────────────────────────────────

/// Auth-mode string for the connect summary.
pub fn auth_mode_str(mode: AuthMode) -> &'static str {
    match mode {
        AuthMode::Password => "password",
        AuthMode::Dev => "dev",
    }
}

// ── Local file scan (Tauri-free port of fs_list_notes_with_meta_impl) ────

#[derive(Debug, Clone)]
pub struct NoteFileMeta {
    /// Relative path from the notes root, forward-slashed (e.g. `Specs/foo.md`).
    pub name: String,
    pub mtime_ms: i64,
    pub size_bytes: u64,
}

/// One-shot recursive readdir+stat for `.md` notes AND embedded image blobs
/// (`is_image_filename`). Skips hidden dirs/files (`.git`, `.obsidian`,
/// `.e2ee-state.json`, etc.) so sync state and VCS metadata never enter the
/// object map. Images ride the same object map as notes — their content is
/// base64-encoded into the note frame at read/encrypt time (see
/// `read_local_note`) — so a pasted image syncs alongside the `![](…)` that
/// references it instead of dangling on the device that created it.
pub fn list_notes_with_meta(base: &Path) -> Vec<NoteFileMeta> {
    let mut out = Vec::new();
    if base.exists() {
        walk(base, base, &mut out);
    }
    out.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms));
    out
}

fn walk(base: &Path, dir: &Path, out: &mut Vec<NoteFileMeta>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        // Skip hidden files and directories.
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if file_type.is_dir() {
            walk(base, &path, out);
        } else if file_type.is_file() && (name.ends_with(".md") || is_image_filename(&name)) {
            let rel = match path.strip_prefix(base) {
                Ok(r) => r.to_string_lossy().replace('\\', "/"),
                Err(_) => continue,
            };
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            out.push(NoteFileMeta {
                name: rel,
                mtime_ms: file_mtime_ms(&meta),
                size_bytes: meta.len(),
            });
        }
    }
}

// ── Apply to disk (Rule 2: pre_write hook in place of the watcher map) ───

#[derive(Debug, Clone)]
pub struct V2IncomingUpdate {
    pub filename: String,
    pub content: String,
    pub hash: String,
    pub modified_at: i64,
}

#[derive(Debug, Clone)]
pub struct V2IncomingConflict {
    pub filename: String,
    pub content: String,
}

pub struct V2SyncApplyInput {
    pub update: Vec<V2IncomingUpdate>,
    pub delete: Vec<String>,
    pub conflicts: Vec<V2IncomingConflict>,
    pub timestamps: HashMap<String, i64>,
}

#[derive(Debug)]
pub struct V2SyncApplyOutput {
    pub updated_filenames: Vec<String>,
    pub deleted_filenames: Vec<String>,
    pub conflict_filenames: Vec<String>,
    pub elapsed_ms: u64,
}

/// Validate that `rel` is a safe relative path under the notes root: no
/// absolute roots, no `..` traversal, no empty components, and a syncable
/// extension — either a `.md` note or a recognized image blob
/// (`is_image_filename`). Returns the validated joined path.
fn safe_relative_sync_path(base: &Path, rel: &str) -> Result<PathBuf, String> {
    if rel.is_empty() {
        return Err("empty path".into());
    }
    let normalized = rel.replace('\\', "/");
    if normalized.starts_with('/') || normalized.ends_with('/') {
        return Err("invalid relative path".into());
    }
    let mut path = base.to_path_buf();
    for component in normalized.split('/') {
        if component.is_empty() || component == "." || component == ".." {
            return Err("invalid path component".into());
        }
        path.push(component);
    }
    if !(normalized.ends_with(".md") || is_image_filename(&normalized)) {
        return Err("path must be a .md note or an image".into());
    }
    Ok(path)
}

/// Apply a batch of sync writes/deletes/conflict-copies to disk.
///
/// Relocated from the former desktop adapter's delta-apply implementation with Rule 2 applied:
/// the Tauri watcher-suppression map + local `suppress_filename` closure are
/// replaced by the `pre_write` hook, called at exactly the same points. Every
/// other behavior — delete-then-write-then-conflict ordering, atomic write,
/// mtime stamping, prune-empty-parent-dirs, timestamp correction — is
/// identical.
fn apply_delta(
    notes_root: &Path,
    pre_write: &PreWriteFn,
    input: V2SyncApplyInput,
) -> Result<V2SyncApplyOutput, String> {
    let started = Instant::now();

    let mut updated_filenames = Vec::new();
    let mut deleted_filenames = Vec::new();
    let mut conflict_filenames = Vec::new();

    // Delete files
    for filename in &input.delete {
        pre_write(filename);
        let path = match safe_relative_sync_path(notes_root, filename) {
            Ok(p) => p,
            Err(_) => continue,
        };
        let _ = std::fs::remove_file(&path);
        // Best-effort: prune now-empty parent folders so the sidebar
        // doesn't keep ghost folders after a peer-driven note delete.
        prune_empty_parent_dirs(notes_root, &path);
        deleted_filenames.push(filename.clone());
    }

    // Write updates
    for update in &input.update {
        pre_write(&update.filename);
        // Defense in depth: run_pull already rejects unsafe incoming names
        // (ensure_safe_incoming_sync_path) before they reach here, so a path
        // that still fails resolution is skipped rather than aborting the whole
        // apply — one bad name must never cost the rest of the batch.
        let path = match safe_relative_sync_path(notes_root, &update.filename) {
            Ok(p) => p,
            Err(_) => continue,
        };
        // Both writers call fs::create_dir_all on the parent. Image content
        // arrives base64-encoded in the note frame; decode it back to bytes.
        if is_image_filename(&update.filename) {
            write_base64_as_blob(&path, &update.content)?;
        } else {
            write_atomic_text(&path, &update.content)?;
        }

        // 0 means "no timestamp from server" — keep the filesystem's own mtime
        if update.modified_at > 0 {
            let _ = set_file_mtime_ms(&path, update.modified_at);
        }

        updated_filenames.push(update.filename.clone());
    }

    // Write conflict copies
    for conflict in &input.conflicts {
        pre_write(&conflict.filename);
        let path = match safe_relative_sync_path(notes_root, &conflict.filename) {
            Ok(p) => p,
            Err(_) => continue,
        };
        if is_image_filename(&conflict.filename) {
            write_base64_as_blob(&path, &conflict.content)?;
        } else {
            write_atomic_text(&path, &conflict.content)?;
        }
        conflict_filenames.push(conflict.filename.clone());
    }

    // Correct local file mtimes from server-authoritative timestamps.
    // This fixes files that were already up-to-date (same hash) but had wrong mtimes.
    for (filename, server_mtime) in &input.timestamps {
        if *server_mtime > 0 {
            let path = match safe_relative_sync_path(notes_root, filename) {
                Ok(p) => p,
                Err(_) => continue,
            };
            if let Ok(meta) = std::fs::metadata(&path) {
                if file_mtime_ms(&meta) != *server_mtime {
                    pre_write(filename);
                    let _ = set_file_mtime_ms(&path, *server_mtime);
                }
            }
        }
    }

    Ok(V2SyncApplyOutput {
        updated_filenames,
        deleted_filenames,
        conflict_filenames,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// Walk up from `path` removing empty directories until we hit `base` or
/// a non-empty directory. Skips removal of `base` itself.
fn prune_empty_parent_dirs(base: &Path, path: &Path) {
    let mut cursor = match path.parent() {
        Some(p) => p.to_path_buf(),
        None => return,
    };
    loop {
        if cursor == base {
            return;
        }
        if !cursor.starts_with(base) {
            return;
        }
        match std::fs::read_dir(&cursor) {
            Ok(mut iter) => {
                if iter.next().is_some() {
                    return;
                }
            }
            Err(_) => return,
        }
        if std::fs::remove_dir(&cursor).is_err() {
            return;
        }
        let parent = match cursor.parent() {
            Some(p) => p.to_path_buf(),
            None => return,
        };
        cursor = parent;
    }
}

// ── Connect / resume ─────────────────────────────────────────────────────

/// Outcome of a successful connect.
#[derive(Debug, Clone)]
pub struct ConnectResult {
    pub user_id: String,
    pub collection_id: String,
    /// Bearer token — carried for parity with the Tauri client (which
    /// persists it for `e2ee_resume`); the spike keeps the session in memory.
    #[allow(dead_code)]
    pub token: String,
    pub auth_mode: &'static str,
}

/// Probe auth mode, log in, pick/create the collection, fetch-or-mint the
/// key material, unwrap the vault key, and load the persisted object map.
pub async fn connect(
    notes_root: &Path,
    server_url: &str,
    password: &str,
) -> Result<(ConnectedState, ConnectResult), SyncErrorKind> {
    let mut http = E2eeClient::new(server_url).map_err(SyncErrorKind::http)?;
    let mode = http.probe_auth_mode().await;

    let login = match mode {
        AuthMode::Dev => http
            .login_dev("local@futo-notes.local", "FUTO Notes")
            .await
            .map_err(SyncErrorKind::auth)?,
        AuthMode::Password => http
            .login_password(password)
            .await
            .map_err(SyncErrorKind::auth)?,
    };
    http.set_token(&login.token);

    // Single-vault protocol: take the first collection or create one.
    let collection_id = {
        let existing = http.list_collections().await.map_err(SyncErrorKind::http)?;
        match existing.into_iter().next() {
            Some(id) => id,
            None => http.create_collection().await.map_err(SyncErrorKind::http)?,
        }
    };

    // Fetch existing key material or mint a fresh one. The wrapping key is
    // derived from `password` against the server-stored salt.
    let key_material = http
        .get_key_material(&collection_id)
        .await
        .map_err(SyncErrorKind::http)?;

    let vault_key = match key_material {
        Some(material) => {
            unwrap_blocking(password.to_owned(), material).await.map_err(SyncErrorKind::crypto)?
        }
        None => {
            // Refuse to mint a fresh vault key into a collection that already
            // holds objects: those would have been encrypted under a now-missing
            // key, and a new key would strand them (mixed-key corruption). A
            // freshly-created vault is empty, so the normal first-connect path
            // passes; a non-empty collection with no key is an inconsistent
            // server state we fail hard on.
            let existing = http
                .list_objects(&collection_id, 0)
                .await
                .map_err(SyncErrorKind::http)?;
            if !existing.is_empty() {
                return Err(SyncErrorKind::Crypto(
                    "collection has objects but no key material; refusing to mint a new vault key"
                        .to_owned(),
                ));
            }
            let (_local_vk, fresh) =
                wrap_blocking(password.to_owned()).await.map_err(SyncErrorKind::crypto)?;
            // PUT is first-write-wins and returns the AUTHORITATIVE material. If
            // a racing client established the vault key first, we adopt theirs
            // instead of our locally-minted one — so both devices share one key.
            let authoritative = http
                .put_key_material(&collection_id, &fresh)
                .await
                .map_err(SyncErrorKind::http)?;
            unwrap_blocking(password.to_owned(), authoritative)
                .await
                .map_err(SyncErrorKind::crypto)?
        }
    };

    let loaded = state::load_for_collection(notes_root, &collection_id);
    let connected = ConnectedState {
        base_url: server_url.to_owned(),
        token: login.token.clone(),
        user_id: login.user_id.clone(),
        collection_id: collection_id.clone(),
        vault_key,
        object_map: loaded.object_map,
        max_version: loaded.max_version,
        pull_cursor: loaded.pull_cursor,
        oversize_skip: HashMap::new(),
    };

    // Persist right away so a crash mid-sync recovers the loaded map.
    state::persist(
        notes_root,
        &connected.object_map,
        connected.max_version,
        connected.pull_cursor,
        &connected.collection_id,
    )
    .map_err(SyncErrorKind::Io)?;

    Ok((
        connected,
        ConnectResult {
            user_id: login.user_id,
            collection_id,
            token: login.token,
            auth_mode: auth_mode_str(mode),
        },
    ))
}

/// Resume a session from a previously-issued bearer token (no full login).
/// Reuses the token, fetches the server-stored key material (erroring if it's
/// absent), unwraps the vault key with `password`, loads the persisted object
/// map, and builds a `ConnectedState`. The desktop's `e2ee_resume` command
/// uses this so `window.__testSync.syncE2ee(password)` can re-derive the key
/// from an explicit password without re-logging-in. A 401 surfaces as
/// `SyncErrorKind::Auth`.
pub async fn resume(
    notes_root: &Path,
    server_url: &str,
    token: &str,
    user_id: &str,
    collection_id: &str,
    password: &str,
) -> Result<ConnectedState, SyncErrorKind> {
    let mut http = E2eeClient::new(server_url).map_err(SyncErrorKind::http)?;
    http.set_token(token);

    // A persisted collection that the server no longer recognizes (404) — or
    // that exists but has no key material — means the stored vault is gone (e.g.
    // a duplicate collapsed by the single-vault migration). Surface it as
    // `CollectionGone` so the desktop re-points to the canonical vault instead
    // of failing the sync outright.
    let material = match http.get_key_material(collection_id).await {
        Ok(Some(m)) => m,
        // Collection exists but has no key material — an inconsistent server
        // state, NOT a collapsed vault. Fail hard rather than treat it as
        // collection-gone (which would re-connect and risk minting a new key
        // into a collection that may still hold objects).
        Ok(None) => {
            return Err(SyncErrorKind::Crypto(
                "vault key material missing on server".to_owned(),
            ))
        }
        // A 404 means the persisted collection is gone (e.g. a duplicate
        // collapsed by the single-vault migration) — heal by re-connecting.
        Err(e) if e.is_not_found() => {
            return Err(SyncErrorKind::CollectionGone(format!("collection-gone: {e}")))
        }
        Err(e) => return Err(SyncErrorKind::http(e)),
    };

    let vault_key = unwrap_blocking(password.to_owned(), material)
        .await
        .map_err(SyncErrorKind::crypto)?;

    let loaded = state::load_for_collection(notes_root, collection_id);
    Ok(ConnectedState {
        base_url: server_url.to_owned(),
        token: token.to_owned(),
        user_id: user_id.to_owned(),
        collection_id: collection_id.to_owned(),
        vault_key,
        object_map: loaded.object_map,
        max_version: loaded.max_version,
        pull_cursor: loaded.pull_cursor,
        oversize_skip: HashMap::new(),
    })
}

/// PBKDF2 (100k iterations) is ~50–300ms; run it off the async executor.
async fn unwrap_blocking(
    password: String,
    material: KeyMaterial,
) -> Result<[u8; KEY_BYTES], e2ee::E2eeError> {
    tokio::task::spawn_blocking(move || e2ee::unwrap_vault_key(&password, &material))
        .await
        .expect("unwrap_vault_key task panicked")
}

async fn wrap_blocking(
    password: String,
) -> Result<([u8; KEY_BYTES], KeyMaterial), e2ee::E2eeError> {
    tokio::task::spawn_blocking(move || e2ee::wrap_vault_key(&password))
        .await
        .expect("wrap_vault_key task panicked")
}

pub(crate) fn build_client(snapshot: &ConnectedState) -> Result<E2eeClient, SyncErrorKind> {
    let mut c = E2eeClient::new(&snapshot.base_url).map_err(SyncErrorKind::http)?;
    c.set_token(&snapshot.token);
    Ok(c)
}

// ── Sync summary (relocated rich SyncSummary; replaces SyncCounts) ────────

/// Result of a single sync phase (pull, push, or the combined cycle).
///
/// Mirrors the Tauri `SyncSummary`. The `deleted_hashes` / `created_hashes` /
/// `hash_to_filenames` fields are internal-only bookkeeping used by
/// `derive_renames` + `resolve_concurrent_move_duplicates` after both phases
/// finish; they're not part of the public summary the caller reads.
#[derive(Debug, Default, Clone)]
pub struct SyncSummary {
    pub uploaded: u32,
    pub downloaded: u32,
    pub deleted: u32,
    pub conflicts: u32,
    pub updated_ids: Vec<String>,
    pub deleted_ids: Vec<String>,
    pub peer_updated_ids: Vec<String>,
    pub peer_deleted_ids: Vec<String>,
    pub renamed: Vec<RenamePair>,
    /// Count of note files this cycle wrote to the LOCAL notes tree
    /// (downloads, push-side clean merges `MergedClean`, conflict copies,
    /// edit-wins restores, reconcile adoptions). Distinct from `uploaded`
    /// (local→server) and from `downloaded`/`deleted` (which miss push-side
    /// merges): a `MergedClean` bumps `uploaded` only, so a shell gating an
    /// editor reload on `downloaded`/`deleted` treats it as a no-op and lets
    /// its next autosave clobber the merged-in peer edit (F2). This is a
    /// core-computed reload signal — shells render it, they never re-derive
    /// "did the disk change" from the semantic counts.
    pub local_writes_applied: u32,
    /// Per-item sync operations that failed but did NOT abort the cycle
    /// (upload/delete/checkpoint errors). Distinct from `conflicts`, which
    /// carries expected/handled outcomes (413 oversize, dirty-merge conflict
    /// copies). Empty in a healthy cycle; a non-empty vec drives the UI failure
    /// indicator + toast. Count = `failures.len()`.
    pub failures: Vec<SyncFailure>,

    pub(crate) deleted_hashes: HashMap<String, String>,
    pub(crate) created_hashes: HashMap<String, String>,
    /// hash → all (filename, change_seq) pairs this phase wrote with that
    /// hash. Used by `resolve_concurrent_move_duplicates` to spot two
    /// clients moving the same content to two different paths in the same
    /// cycle. Internal-only.
    pub(crate) hash_to_filenames: HashMap<String, Vec<HashFilenameEntry>>,
}

/// The sync operation that failed, for the per-failure detail surfaced to
/// the user.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureKind {
    /// A push (create/update) — read/encrypt or POST/PUT failure.
    Upload,
    /// A push-side delete (or its 409-restore) failure.
    Delete,
    /// An object-map checkpoint persist failure.
    Checkpoint,
    /// A pull-side blob fetch failure (transport, 5xx, or blob missing on
    /// the server). Generally transient; the cursor cap guarantees the
    /// object is retried next cycle instead of silently skipped (issue #11).
    Download,
    /// A pulled blob that fetched fine but failed AES-GCM decrypt/unpack —
    /// wrong key material or corruption, permanent for these bytes. Kept
    /// distinct from `Download` so the UI can say so instead of blaming the
    /// network.
    Decrypt,
    /// An incoming name a peer pushed that this client refuses to materialize
    /// (traversal, forbidden chars, over-length). Unlike `Download`, this is
    /// PERMANENT for that exact name — the cursor is not capped, so it is not
    /// retried; the honest wording must not promise a retry.
    Rejected,
}

impl FailureKind {
    /// Canonical wire string, shared by the Tauri wire summary and the FFI
    /// record so the two adapters can't drift.
    pub fn as_str(&self) -> &'static str {
        match self {
            FailureKind::Upload => "upload",
            FailureKind::Delete => "delete",
            FailureKind::Checkpoint => "checkpoint",
            FailureKind::Download => "download",
            FailureKind::Decrypt => "decrypt",
            FailureKind::Rejected => "rejected",
        }
    }
}

/// One per-item sync failure that did not abort the cycle. `filename` is
/// empty when the failure has no single associated file (task panic,
/// checkpoint persist). `status_code` is the HTTP status when the failure
/// came from a server response, `None` for transport/local errors.
#[derive(Debug, Clone)]
pub struct SyncFailure {
    pub filename: String,
    pub kind: FailureKind,
    pub status_code: Option<u16>,
}

impl SyncSummary {
    /// One-line user-facing description of the per-item failures, or `None`
    /// for a clean cycle. Computed here — once — so the desktop and both
    /// native shells surface identical wording (docs/spec/sync.md).
    ///
    /// Upload/delete failures are server-bound ("couldn't reach the server",
    /// with the most frequent HTTP status appended when one exists — ties
    /// keep the first-seen code). Download failures get a pull-side clause
    /// (the data exists, this device just couldn't fetch it yet — retried
    /// next cycle). Decrypt failures get their own clause: they indicate key
    /// material or corruption, and blaming the network would misdirect the
    /// user. Checkpoint failures are local persist errors, same reasoning.
    pub fn failure_message(&self) -> Option<String> {
        let server: Vec<&SyncFailure> = self
            .failures
            .iter()
            .filter(|f| {
                f.kind == FailureKind::Upload || f.kind == FailureKind::Delete
            })
            .collect();
        let downloads = self
            .failures
            .iter()
            .filter(|f| f.kind == FailureKind::Download)
            .count();
        let decrypts = self
            .failures
            .iter()
            .filter(|f| f.kind == FailureKind::Decrypt)
            .count();
        let rejected = self
            .failures
            .iter()
            .filter(|f| f.kind == FailureKind::Rejected)
            .count();
        let checkpoint_failed = self
            .failures
            .iter()
            .any(|f| f.kind == FailureKind::Checkpoint);

        let mut parts: Vec<String> = Vec::new();
        if !server.is_empty() {
            let n = server.len();
            let noun = if n == 1 { "change" } else { "changes" };
            let mut msg = format!("{n} {noun} couldn't reach the server");
            let codes: Vec<u16> = server.iter().filter_map(|f| f.status_code).collect();
            if let Some(&first) = codes.first() {
                let mut top = first;
                let mut top_count = 0usize;
                for &c in &codes {
                    let count = codes.iter().filter(|&&x| x == c).count();
                    if count > top_count {
                        top = c;
                        top_count = count;
                    }
                }
                msg.push_str(&format!(" (HTTP {top})"));
            }
            parts.push(msg);
        }
        if downloads > 0 {
            let noun = if downloads == 1 { "note" } else { "notes" };
            parts.push(format!(
                "{downloads} {noun} couldn't be downloaded (will retry)"
            ));
        }
        if decrypts > 0 {
            let noun = if decrypts == 1 { "note" } else { "notes" };
            parts.push(format!("{decrypts} {noun} couldn't be decrypted"));
        }
        if rejected > 0 {
            // Permanent: an unsupported name on a peer's object. NOT retried
            // (the cursor is not capped), so the wording must not promise one.
            let clause = if rejected == 1 {
                "1 note had an unsupported name and was skipped".to_owned()
            } else {
                format!("{rejected} notes had unsupported names and were skipped")
            };
            parts.push(clause);
        }
        if checkpoint_failed {
            parts.push("sync state couldn't be saved locally".to_owned());
        }
        if parts.is_empty() {
            None
        } else {
            Some(parts.join("; "))
        }
    }
}

#[derive(Debug, Clone)]
pub struct HashFilenameEntry {
    pub filename: String,
    pub change_seq: u64,
    /// Server object this filename maps to. The concurrent-move dedup keys on
    /// this so it only collapses copies of the SAME object surfacing under two
    /// names — never two distinct notes that merely share content + basename
    /// (F9).
    pub object_id: String,
}

#[derive(Debug, Clone)]
pub struct RenamePair {
    pub from_id: String,
    pub to_id: String,
}

fn filename_to_id(filename: &str) -> String {
    filename.strip_suffix(".md").unwrap_or(filename).to_owned()
}

fn filename_basename(filename: &str) -> &str {
    match filename.rfind('/') {
        Some(i) => &filename[i + 1..],
        None => filename,
    }
}

fn add_hash_filename(
    map: &mut HashMap<String, Vec<HashFilenameEntry>>,
    hash: String,
    filename: String,
    change_seq: u64,
    object_id: String,
) {
    map.entry(hash)
        .or_default()
        .push(HashFilenameEntry { filename, change_seq, object_id });
}

/// Detect 1-to-1 local renames before push. For each basename where the
/// map has exactly one entry whose filename isn't on disk AND there's
/// exactly one on-disk file with that basename not yet in the map, pair
/// them. The result lets push reuse the original `object_id` via a PUT
/// at the new filename instead of running a DELETE + POST — which would
/// tombstone the object and break concurrent peer edits.
///
/// Returns a `new_filename → old_filename` map. The caller is expected
/// to rewrite a working copy of the object_map (move the entry from old
/// to new) and remember the pairing for `resolve_update_conflict`.
/// Mirrors `pairLocalMovedObjects` from the deleted TS implementation.
pub fn pair_local_moved_objects(
    local_files: &[NoteFileMeta],
    object_map: &HashMap<String, E2eeObjectMapEntry>,
) -> HashMap<String, String> {
    let local_names: HashSet<&str> = local_files.iter().map(|f| f.name.as_str()).collect();

    let mut missing_by_basename: HashMap<&str, Vec<&str>> = HashMap::new();
    for filename in object_map.keys() {
        if local_names.contains(filename.as_str()) {
            continue;
        }
        let base = filename_basename(filename);
        missing_by_basename.entry(base).or_default().push(filename);
    }

    let mut unmapped_by_basename: HashMap<&str, Vec<&str>> = HashMap::new();
    for f in local_files {
        if object_map.contains_key(&f.name) {
            continue;
        }
        let base = filename_basename(&f.name);
        unmapped_by_basename.entry(base).or_default().push(&f.name);
    }

    let mut pairings: HashMap<String, String> = HashMap::new();
    for (base, missing) in &missing_by_basename {
        let Some(unmapped) = unmapped_by_basename.get(base) else {
            continue;
        };
        if missing.len() != 1 || unmapped.len() != 1 {
            continue;
        }
        let from = missing[0];
        let to = unmapped[0];
        if from == to {
            continue;
        }
        pairings.insert(to.to_owned(), from.to_owned());
    }
    pairings
}

fn build_filename_by_object_id(
    map: &HashMap<String, E2eeObjectMapEntry>,
) -> HashMap<String, String> {
    let mut out = HashMap::with_capacity(map.len());
    for (filename, entry) in map {
        out.insert(entry.object_id.clone(), filename.clone());
    }
    out
}

/// First-pass classification of a `list_objects` response: which objects
/// need a blob download, which can be tombstoned immediately, and what
/// `max_version` cursor to advance to. Pure data — no I/O — so the heavy
/// async work below stays trivially correct.
struct FirstPass {
    to_download: Vec<ServerObject>,
    immediate_deletes: Vec<String>,
    new_max_version: u64,
}

fn first_pass(
    objects: Vec<ServerObject>,
    object_map: &HashMap<String, E2eeObjectMapEntry>,
    filename_by_object_id: &HashMap<String, String>,
    current_max_version: u64,
) -> FirstPass {
    let mut to_download = Vec::new();
    let mut immediate_deletes = Vec::new();
    let mut new_max_version = current_max_version;

    for obj in objects {
        if obj.change_seq > new_max_version {
            new_max_version = obj.change_seq;
        }
        if obj.deleted {
            if let Some(name) = filename_by_object_id.get(&obj.id) {
                immediate_deletes.push(name.clone());
            }
            continue;
        }
        let blob_key = match obj.blob_key.as_deref() {
            Some(k) => k,
            None => continue,
        };
        // Skip if we already have it at this version (e.g. our own push
        // landing on the next pull). Idempotent and keeps the watcher quiet.
        if let Some(name) = filename_by_object_id.get(&obj.id) {
            if let Some(existing) = object_map.get(name) {
                if existing.version >= obj.version && existing.blob_key == blob_key {
                    continue;
                }
            }
        }
        to_download.push(obj);
    }

    FirstPass {
        to_download,
        immediate_deletes,
        new_max_version,
    }
}

/// One successful blob download. Collected from each pool worker.
#[derive(Debug)]
struct DownloadedNote {
    object_id: String,
    version: u64,
    change_seq: u64,
    blob_key: String,
    filename: String,
    content: String,
    hash: String,
    modified_at_ms: i64,
}

/// Why one object's blob failed to land. `Download` (transport/5xx/missing)
/// is generally transient; `Decrypt` is permanent for these bytes. The kind
/// feeds `SyncFailure` and the change_seq-based cursor cap (issue #11).
#[derive(Debug)]
struct DownloadError {
    kind: FailureKind,
    status_code: Option<u16>,
    message: String,
}

impl DownloadError {
    fn download(message: String, status_code: Option<u16>) -> Self {
        Self { kind: FailureKind::Download, status_code, message }
    }

    fn from_http(e: E2eeHttpError) -> Self {
        let status = match &e {
            E2eeHttpError::Http { status, .. } => Some(*status),
            _ => None,
        };
        Self::download(format!("{e}"), status)
    }

    fn decrypt(message: String) -> Self {
        Self { kind: FailureKind::Decrypt, status_code: None, message }
    }
}

/// Decrypt + unpack fetched ciphertext into a [`DownloadedNote`]. CPU work,
/// kept inline — fast enough that spawn_blocking overhead would dominate for
/// typical 5KB notes. Shared by the batch and per-blob paths.
fn decrypt_downloaded(
    vault_key: &[u8; KEY_BYTES],
    obj: &ServerObject,
    blob_key: &str,
    ciphertext: &[u8],
) -> Result<DownloadedNote, DownloadError> {
    let plaintext = e2ee::aes_gcm_decrypt(vault_key, ciphertext)
        .map_err(|e| DownloadError::decrypt(e2ee_err_to_string(e)))?;
    let note = e2ee::unpack_note(&plaintext)
        .map_err(|e| DownloadError::decrypt(e2ee_err_to_string(e)))?;
    let hash = hash_sha256(&note.content);
    let modified_at_ms = parse_iso_ms(&obj.updated_at).unwrap_or_else(now_ms);
    Ok(DownloadedNote {
        object_id: obj.id.clone(),
        version: obj.version,
        change_seq: obj.change_seq,
        blob_key: blob_key.to_owned(),
        filename: note.path,
        content: note.content,
        hash,
        modified_at_ms,
    })
}

async fn download_and_decrypt(
    http: Arc<E2eeClient>,
    vault_key: Arc<[u8; KEY_BYTES]>,
    obj: ServerObject,
) -> Result<DownloadedNote, DownloadError> {
    let blob_key = obj
        .blob_key
        .clone()
        .ok_or_else(|| DownloadError::download("server object has no blob_key".into(), None))?;
    let ciphertext = http
        .get_blob_sized(&blob_key, obj.size_bytes.unwrap_or(0))
        .await
        .map_err(DownloadError::from_http)?;
    decrypt_downloaded(&vault_key, &obj, &blob_key, &ciphertext)
}

// ── Batched download stage (shared by run_pull and reconcile_empty_map) ──

/// One failed object out of a download stage: enough to surface a
/// [`SyncFailure`] AND cap the persisted cursor below its `change_seq` so
/// the next pull re-lists and retries it (issue #11).
struct FailedDownload {
    change_seq: u64,
    failure: SyncFailure,
}

/// One unit of download work after bin-packing.
enum DownloadJob {
    /// ≥2 objects fetched in a single `POST /api/blobs/batch` request.
    Batch(Vec<ServerObject>),
    /// One object fetched via the classic per-blob GET: oversized (its own
    /// optimal "chunk" already), unknown-size, blob_key-less (defensive), or
    /// a leftover singleton — batching a single key buys nothing, and this
    /// keeps a 1-file sync byte-for-byte identical to the pre-batch client.
    Single(ServerObject),
}

/// Greedy bin-packing, smallest first. Sorting ascending by size puts all
/// the ~5KB notes in the first chunks — on an image-heavy first sync the
/// full text of the vault lands before the first photo, which is most of
/// the *perceived* speedup. Sizes come from the objects listing; a stale or
/// absent size can't break anything (the server's byte cap answers
/// status=omitted and the object degrades to the per-blob path).
fn plan_download_jobs(mut objs: Vec<ServerObject>) -> Vec<DownloadJob> {
    objs.sort_by_key(|o| o.size_bytes.unwrap_or(u64::MAX));
    let mut jobs: Vec<DownloadJob> = Vec::new();
    let mut cur: Vec<ServerObject> = Vec::new();
    let mut cur_bytes: u64 = 0;

    fn flush(cur: &mut Vec<ServerObject>, cur_bytes: &mut u64, jobs: &mut Vec<DownloadJob>) {
        *cur_bytes = 0;
        match cur.len() {
            0 => {}
            1 => jobs.push(DownloadJob::Single(cur.pop().expect("len checked"))),
            _ => jobs.push(DownloadJob::Batch(std::mem::take(cur))),
        }
    }

    for obj in objs {
        match (obj.blob_key.is_some(), obj.size_bytes) {
            (true, Some(s)) if s < TARGET_CHUNK_BYTES => {
                if cur_bytes + s > TARGET_CHUNK_BYTES || cur.len() >= MAX_BATCH_KEYS {
                    flush(&mut cur, &mut cur_bytes, &mut jobs);
                }
                cur_bytes += s;
                cur.push(obj);
            }
            _ => jobs.push(DownloadJob::Single(obj)),
        }
    }
    flush(&mut cur, &mut cur_bytes, &mut jobs);
    jobs
}

/// Issue #11: the cursor a pull may persist, given its failures. Never past
/// the lowest failed `change_seq`, so the next `list_objects(since)` re-lists
/// the failed object (and everything after it — cheap and idempotent: the
/// object_map skip in `first_pass` no-ops the already-landed ones).
fn cap_cursor(new_max: u64, failed: &[FailedDownload]) -> u64 {
    match failed.iter().map(|f| f.change_seq).min() {
        Some(lowest) => new_max.min(lowest.saturating_sub(1)),
        None => new_max,
    }
}

/// Outcome of one batch request's worth of objects.
struct BatchJobResult {
    downloaded: Vec<DownloadedNote>,
    /// Objects to degrade to the per-blob path: endpoint absent (old
    /// server), retry ladder exhausted, or per-entry status=omitted.
    retry_as_singles: Vec<ServerObject>,
    /// Per-entry terminal outcomes: decrypt failures and missing blobs.
    failed: Vec<(ServerObject, DownloadError)>,
}

/// Whether a failed batch request is worth the whole-chunk retry ladder.
/// Transport errors, malformed bodies, and 5xx/408/429 are plausibly
/// transient; any other 4xx (401, 403, 400…) will fail identically on
/// retry, so the chunk degrades to per-blob GETs immediately instead of
/// burning the backoff first. (404 is handled before this: endpoint absent
/// → per-blob fallback.)
fn batch_retryable(e: &E2eeHttpError) -> bool {
    match e {
        E2eeHttpError::Http { status, .. } => *status >= 500 || *status == 408 || *status == 429,
        _ => true,
    }
}

async fn run_batch_job(
    http: Arc<E2eeClient>,
    vault_key: Arc<[u8; KEY_BYTES]>,
    objs: Vec<ServerObject>,
    batch_unsupported: Arc<AtomicBool>,
) -> BatchJobResult {
    let mut result = BatchJobResult {
        downloaded: Vec::with_capacity(objs.len()),
        retry_as_singles: Vec::new(),
        failed: Vec::new(),
    };
    // A sibling job already learned the server has no batch endpoint —
    // don't burn a round trip rediscovering it.
    if batch_unsupported.load(Ordering::Relaxed) {
        result.retry_as_singles = objs;
        return result;
    }

    let keys: Vec<String> = objs
        .iter()
        .filter_map(|o| o.blob_key.clone())
        .collect();
    debug_assert_eq!(keys.len(), objs.len(), "planner only batches keyed objects");
    let expected_bytes: u64 = objs.iter().filter_map(|o| o.size_bytes).sum();

    let mut attempt = 0usize;
    let entries = loop {
        match http.get_blobs_batch(&keys, expected_bytes).await {
            Ok(entries) => break entries,
            Err(E2eeHttpError::Http { status: 404, .. }) => {
                // Old server without the endpoint. Pull-wide flag (fresh per
                // download_all call): every remaining batch in THIS pull
                // degrades to the per-blob path; the next pull re-probes once.
                batch_unsupported.store(true, Ordering::Relaxed);
                result.retry_as_singles = objs;
                return result;
            }
            Err(e) if attempt < BATCH_RETRY_BACKOFF.len() && batch_retryable(&e) => {
                eprintln!("[e2ee] batch download attempt {} failed: {e}", attempt + 1);
                tokio::time::sleep(BATCH_RETRY_BACKOFF[attempt]).await;
                attempt += 1;
            }
            Err(e) => {
                // Ladder exhausted or non-retryable (e.g. 401) — degrade to
                // per-blob GETs, which isolate a poison blob instead of
                // sinking the whole chunk, and produce the per-object
                // failure attribution.
                eprintln!("[e2ee] batch download failed: {e}");
                result.retry_as_singles = objs;
                return result;
            }
        }
    };

    // Rejoin entries to objects by key (uuid blob keys are unique). Any
    // object the response didn't cover — protocol violation — degrades to
    // the per-blob path rather than being dropped.
    let mut by_key: HashMap<&str, &ServerObject> = HashMap::with_capacity(objs.len());
    for obj in &objs {
        if let Some(k) = obj.blob_key.as_deref() {
            if let Some(prev) = by_key.insert(k, obj) {
                // Two objects sharing a blob_key (shouldn't happen — server
                // keys are uuids) would make the rejoin drop one silently
                // (last-wins + covered check), advancing the cursor past the
                // dropped object. Degrade the loser to the per-blob path
                // instead: it fetches the shared blob under its own object.
                eprintln!("[e2ee] duplicate blob_key {k} across objects; degrading one to per-blob");
                result.retry_as_singles.push(prev.clone());
            }
        }
    }
    let mut covered: HashSet<String> = HashSet::with_capacity(entries.len());
    for entry in entries {
        let Some(&obj) = by_key.get(entry.key.as_str()) else {
            eprintln!("[e2ee] batch response contained unrequested key {}", entry.key);
            continue;
        };
        if !covered.insert(entry.key.clone()) {
            // Duplicate frame for a key (only possible when the request
            // itself carried duplicates): the first frame already decided
            // this key's outcome — processing it again would double-download
            // the winner.
            continue;
        }
        match entry.status {
            BatchBlobStatus::Ok => {
                match decrypt_downloaded(&vault_key, obj, &entry.key, &entry.bytes) {
                    Ok(note) => result.downloaded.push(note),
                    Err(e) => result.failed.push((obj.clone(), e)),
                }
            }
            BatchBlobStatus::Missing => result.failed.push((
                obj.clone(),
                DownloadError::download("blob missing on server".into(), Some(404)),
            )),
            BatchBlobStatus::Omitted => result.retry_as_singles.push(obj.clone()),
        }
    }
    for obj in &objs {
        let key = obj.blob_key.as_deref().unwrap_or_default();
        if !covered.contains(key) {
            result.retry_as_singles.push(obj.clone());
        }
    }
    result
}

/// The shared download stage: fetch + decrypt every object in `to_download`,
/// batching small blobs and degrading gracefully (old server, chunk failure,
/// omitted tail) to the per-blob path. Returns the notes that landed plus
/// per-object failures for the summary + cursor cap. Never errors as a
/// whole: a total network outage simply returns everything as failed.
async fn download_all(
    http: Arc<E2eeClient>,
    vault_key: Arc<[u8; KEY_BYTES]>,
    to_download: Vec<ServerObject>,
    filename_by_object_id: &HashMap<String, String>,
    progress_emitter: &ProgressEmitter<'_>,
) -> (Vec<DownloadedNote>, Vec<FailedDownload>) {
    let mut downloaded: Vec<DownloadedNote> = Vec::with_capacity(to_download.len());
    let mut failed_raw: Vec<(ServerObject, DownloadError)> = Vec::new();
    let mut singles: Vec<ServerObject> = Vec::new();
    let mut batches: Vec<Vec<ServerObject>> = Vec::new();
    for job in plan_download_jobs(to_download) {
        match job {
            DownloadJob::Batch(objs) => batches.push(objs),
            DownloadJob::Single(obj) => singles.push(obj),
        }
    }

    // Phase A: batches. Runs before the singles phase rather than alongside
    // it — bandwidth is shared, so interleaving wouldn't finish sooner, and
    // batches (packed smallest-first) landing first means every note is on
    // disk before the first large blob starts.
    let batch_unsupported = Arc::new(AtomicBool::new(false));
    if !batches.is_empty() {
        let semaphore = Arc::new(Semaphore::new(DOWNLOAD_CONCURRENCY));
        let mut set: JoinSet<BatchJobResult> = JoinSet::new();
        let mut spawned: HashMap<tokio::task::Id, Vec<ServerObject>> = HashMap::new();
        for objs in batches {
            let permit_sem = semaphore.clone();
            let http = http.clone();
            let vault_key = vault_key.clone();
            let unsupported = batch_unsupported.clone();
            let objs_for_panic = objs.clone();
            let handle = set.spawn(async move {
                let _permit = permit_sem.acquire_owned().await.expect("semaphore closed");
                run_batch_job(http, vault_key, objs, unsupported).await
            });
            spawned.insert(handle.id(), objs_for_panic);
        }
        while let Some(joined) = set.join_next_with_id().await {
            match joined {
                Ok((id, res)) => {
                    spawned.remove(&id);
                    // Landed + terminally-failed objects are done for
                    // progress purposes; degraded ones bump in phase B.
                    for _ in 0..(res.downloaded.len() + res.failed.len()) {
                        progress_emitter.bump();
                    }
                    downloaded.extend(res.downloaded);
                    singles.extend(res.retry_as_singles);
                    failed_raw.extend(res.failed);
                }
                Err(e) => {
                    // A panicked job must still fail its objects — losing
                    // them here would advance the cursor past them (the
                    // exact issue-#11 bug). The task id recovers which
                    // objects the job owned.
                    eprintln!("[e2ee] batch job panicked: {e}");
                    if let Some(objs) = spawned.remove(&e.id()) {
                        for obj in objs {
                            // Terminal for this cycle → counts toward
                            // progress like the failed entries above.
                            progress_emitter.bump();
                            failed_raw.push((
                                obj,
                                DownloadError::download("batch task panicked".into(), None),
                            ));
                        }
                    }
                }
            }
        }
    }

    // Phase B: per-blob pool — planned singles (big/unknown-size blobs) plus
    // everything the batch phase degraded. Identical to the pre-batch client
    // (semaphore at PULL_CONCURRENCY, one GET per object) except failures are
    // now attributed per object instead of logged-and-forgotten.
    if !singles.is_empty() {
        let semaphore = Arc::new(Semaphore::new(PULL_CONCURRENCY));
        let mut set: JoinSet<(ServerObject, Result<DownloadedNote, DownloadError>)> =
            JoinSet::new();
        for obj in singles {
            let permit_sem = semaphore.clone();
            let http = http.clone();
            let vault_key = vault_key.clone();
            set.spawn(async move {
                let _permit = permit_sem.acquire_owned().await.expect("semaphore closed");
                let res = download_and_decrypt(http, vault_key, obj.clone()).await;
                (obj, res)
            });
        }
        while let Some(joined) = set.join_next().await {
            progress_emitter.bump();
            match joined {
                Ok((_, Ok(note))) => downloaded.push(note),
                Ok((obj, Err(e))) => {
                    eprintln!("[e2ee] blob download failed: {}", e.message);
                    failed_raw.push((obj, e));
                }
                Err(e) => {
                    // Per-object task panic: the object moved into the task,
                    // so it can't be attributed — but silently dropping it
                    // would advance the cursor past it. A cycle-level
                    // failure with change_seq 0 pins the cursor at `since`,
                    // which is the conservative correct fallback (next pull
                    // re-lists everything; idempotent skips make it cheap).
                    eprintln!("[e2ee] download task panicked: {e}");
                    failed_raw.push((
                        ServerObject {
                            id: String::new(),
                            collection_id: String::new(),
                            version: 0,
                            change_seq: 0,
                            deleted: false,
                            blob_key: None,
                            size_bytes: None,
                            created_at: String::new(),
                            updated_at: String::new(),
                        },
                        DownloadError::download("download task panicked".into(), None),
                    ));
                }
            }
        }
    }

    let failed = failed_raw
        .into_iter()
        .map(|(obj, e)| FailedDownload {
            change_seq: obj.change_seq,
            failure: SyncFailure {
                filename: filename_by_object_id
                    .get(&obj.id)
                    .cloned()
                    .unwrap_or_default(),
                kind: e.kind,
                status_code: e.status_code,
            },
        })
        .collect();
    (downloaded, failed)
}

// ── Path-collision resolution (F4 / F5) ──────────────────────────────────

/// One member of a path-collision group. A group is the set of DISTINCT
/// objects whose filenames share a [`collision_key`] (case- and
/// normalization-folded), i.e. that collapse to one entry on a
/// case/normalization-insensitive filesystem.
#[derive(Debug, Clone)]
struct CollisionCandidate {
    /// The WINNER KEY. `object_id` is globally unique, server-assigned, and
    /// immutable after create, so it is the only stable identifier present on
    /// BOTH downloads and map-only rivals — which is exactly what lets the
    /// detector rank a rival that isn't in this incremental batch (closing the
    /// scope hole) and stay idempotent (editing the winner can't change its
    /// object_id, so the winner never flips).
    object_id: String,
    /// The object's own (canonical) filename as it wants to appear on disk.
    filename: String,
    /// Content hash, when known: `Some` for a download, the recorded hash for a
    /// map entry (may be `None` if the fast-path fields were cleared). Two
    /// colliding objects with the SAME known hash are byte-identical, so the
    /// loser is adopted silently instead of parked at a conflict copy.
    hash: Option<String>,
    source: CandidateSource,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum CandidateSource {
    /// A note downloaded this cycle (index into the `downloaded` vec).
    Download(usize),
    /// An object already present in the persisted object_map (filename key).
    MapEntry(String),
}

/// The actions a resolved collision implies.
#[derive(Debug, Default)]
struct CollisionPlan {
    /// Download index → the conflict filename it must be written under instead
    /// of its canonical filename (this download lost the collision).
    download_overrides: HashMap<usize, String>,
    /// A map-only object that lost: rename it on disk + in the map from
    /// `old_filename` to `new_filename`.
    map_renames: Vec<MapRename>,
    /// Download indices to SKIP entirely: an identical-content collision loser.
    /// The winner already materializes the byte-identical content at the
    /// canonical name, so writing the loser would only mint a redundant
    /// `(conflict <oid>)` copy (the twice-postmortemed conflict-copy spam).
    /// The loser object is left untouched on the server.
    download_skips: HashSet<usize>,
    /// Map-only losers whose content is byte-identical to the winner: drop the
    /// old on-disk file + map entry (the winner is the sole survivor). Removing
    /// the map entry keeps the push phase from tombstoning the still-live server
    /// object — it is simply left on the server.
    identical_map_drops: Vec<String>,
}

#[derive(Debug, Clone)]
struct MapRename {
    old_filename: String,
    new_filename: String,
}

/// Decide, over the UNION of this pull's downloads and the persisted
/// object_map, how to place objects whose filenames collide on a
/// case/normalization-insensitive filesystem so NO object is lost (F4: same
/// name on two clients; F5: NFC vs NFD).
///
/// Winner rule: the object with the lexicographically smallest `object_id`
/// keeps the canonical filename; every other object in the group is parked at
/// [`collision_conflict_filename`]`(winner_canonical, loser_object_id)`. The
/// winner key is `object_id` (globally unique, immutable, present on BOTH
/// downloads and map entries) — never `change_seq` (per-edit, would thrash)
/// and never a per-cycle name set (would diverge across clients). This makes
/// the result:
///   • idempotent — running it again with the same object set yields the same
///     placement, and editing the winner can't flip the winner;
///   • convergent — every client computes the identical winner and identical
///     loser names, so the fleet lands on `{canonical, name (conflict <oid8>)}`;
///   • scope-hole-safe — a rival that is map-only (already on disk, not in this
///     incremental batch) still participates, so a freshly-pulled loser is
///     parked at its conflict name instead of clobbering the on-disk winner,
///     and a freshly-pulled winner re-homes the map-only loser via a disk
///     rename rather than silently colliding.
///
/// `tombstoned` is the set of object_ids being deleted this cycle; they take
/// no part in collision resolution.
fn resolve_pull_collisions(
    downloaded: &[DownloadedNote],
    object_map: &HashMap<String, E2eeObjectMapEntry>,
    tombstoned_filenames: &HashSet<String>,
) -> CollisionPlan {
    // object_ids arriving in this batch — used to skip the map entry that is
    // simply the prior state of a downloaded object (same object_id), and to
    // skip a map entry that is being renamed-in-place by its own download.
    let downloaded_ids: HashSet<&str> =
        downloaded.iter().map(|d| d.object_id.as_str()).collect();

    // Group candidates by collision_key.
    let mut groups: HashMap<String, Vec<CollisionCandidate>> = HashMap::new();

    for (idx, d) in downloaded.iter().enumerate() {
        groups
            .entry(collision_key(&d.filename))
            .or_default()
            .push(CollisionCandidate {
                object_id: d.object_id.clone(),
                filename: d.filename.clone(),
                hash: Some(d.hash.clone()),
                source: CandidateSource::Download(idx),
            });
    }

    for (filename, entry) in object_map {
        // Skip entries that are the prior state of a downloaded object (same
        // object_id) — the download already represents them — and skip entries
        // whose file is being deleted this cycle.
        if downloaded_ids.contains(entry.object_id.as_str()) {
            continue;
        }
        if tombstoned_filenames.contains(filename) {
            continue;
        }
        groups
            .entry(collision_key(filename))
            .or_default()
            .push(CollisionCandidate {
                object_id: entry.object_id.clone(),
                filename: filename.clone(),
                hash: entry.hash.clone(),
                source: CandidateSource::MapEntry(filename.clone()),
            });
    }

    let mut plan = CollisionPlan::default();

    for (_key, mut members) in groups {
        // Distinct object_ids only — multiple candidates for the SAME object_id
        // (shouldn't happen post-filter, but be defensive) aren't a collision.
        members.sort_by(|a, b| a.object_id.cmp(&b.object_id));
        members.dedup_by(|a, b| a.object_id == b.object_id);
        if members.len() < 2 {
            continue;
        }

        // Winner = smallest object_id (already sorted). It keeps its canonical
        // filename. Everyone else is a loser parked at a deterministic name
        // derived from the WINNER's canonical name + the LOSER's object_id.
        let winner_filename = members[0].filename.clone();
        let winner_hash = members[0].hash.clone();
        for loser in &members[1..] {
            // Identical content is NOT a real conflict. A byte-identical loser
            // must be adopted SILENTLY (no `(conflict <oid>)` copy): the winner
            // already materializes the same bytes at the canonical name. This
            // is the guard the push 409 path already has — its absence here let
            // crash-window orphan objects (uploaded-but-unpersisted POSTs that
            // re-list on restart) collide with the re-POSTed live entry and mint
            // user-visible conflict copies that then propagate fleet-wide (the
            // twice-postmortemed conflict-copy-spam class).
            if let (Some(w), Some(l)) = (&winner_hash, &loser.hash) {
                if w == l {
                    match &loser.source {
                        CandidateSource::Download(idx) => {
                            plan.download_skips.insert(*idx);
                        }
                        CandidateSource::MapEntry(old) => {
                            plan.identical_map_drops.push(old.clone());
                        }
                    }
                    continue;
                }
            }
            let conflict_name =
                collision_conflict_filename(&winner_filename, &loser.object_id);
            match &loser.source {
                CandidateSource::Download(idx) => {
                    plan.download_overrides.insert(*idx, conflict_name);
                }
                CandidateSource::MapEntry(old_filename) => {
                    // A map-only loser is already materialized on disk under
                    // its old (canonical-colliding) name; move it aside so the
                    // freshly-pulled winner can take the canonical name.
                    plan.map_renames.push(MapRename {
                        old_filename: old_filename.clone(),
                        new_filename: conflict_name,
                    });
                }
            }
        }
    }

    plan
}

// ── Pull / reconcile orchestrator ────────────────────────────────────────

/// The result of screening a freshly-downloaded set against the incoming-path
/// classifier. Every incoming write path (`run_pull`, `reconcile_empty_map`)
/// runs this BEFORE collision planning, so an ignored/unsafe object can never
/// win a collision against — and thereby delete — a valid sibling (B4).
struct DownloadTriage {
    /// Notes to materialize, each with its filename already HEALED to a safe
    /// form (`sanitize_title`-equivalent) where the peer sent a creatable-but-
    /// unsyncable name.
    kept: Vec<DownloadedNote>,
    /// Names we refuse to write (structurally unsafe: traversal, forbidden
    /// chars, over-length). Surfaced as failures, never cursor-capped, never
    /// abort the cycle. Non-syncable (legacy/foreign) objects are dropped
    /// silently — an expected migration state, not a failure.
    rejected: Vec<SyncFailure>,
}

/// Screen downloaded objects through [`classify_incoming_sync_path`]. Healed
/// names are rewritten in place on the kept notes; ignored (non-syncable)
/// objects are dropped; rejected (unsafe) names become `Download` failures.
fn triage_downloaded(downloaded: Vec<DownloadedNote>) -> DownloadTriage {
    let mut kept = Vec::with_capacity(downloaded.len());
    let mut rejected = Vec::new();
    for mut note in downloaded {
        match classify_incoming_sync_path(&note.filename) {
            IncomingSyncPath::Ignore => {}
            IncomingSyncPath::Accept => kept.push(note),
            IncomingSyncPath::Sanitize(healed) => {
                note.filename = healed;
                kept.push(note);
            }
            IncomingSyncPath::Reject(_) => rejected.push(SyncFailure {
                filename: note.filename,
                kind: FailureKind::Rejected,
                status_code: None,
            }),
        }
    }
    DownloadTriage { kept, rejected }
}

/// A freshly-downloaded set after it has passed through the single incoming
/// choke point: healed/kept notes, the failures for names refused, and the
/// collision plan computed over ONLY the kept set.
struct ScreenedDownloads {
    /// Notes to materialize (unsafe/legacy names already dropped or healed).
    kept: Vec<DownloadedNote>,
    /// Names refused (structurally unsafe) — surfaced as failures, never
    /// cursor-capped.
    path_failures: Vec<SyncFailure>,
    /// Where each kept download lands on disk (canonical vs conflict copy),
    /// planned across the union of the kept set and `object_map`.
    collision_plan: CollisionPlan,
}

/// THE incoming-write choke point. Every batch pull path (`run_pull`,
/// `reconcile_empty_map`) MUST route freshly-downloaded objects through here
/// before materializing anything. It fuses the two steps whose ORDER is the
/// guard: classify/heal/reject each name FIRST (B1/B2), then plan collisions
/// over ONLY the surviving kept set (B4 — so an ignored/unsafe object can
/// never win a collision and thereby delete a valid sibling). Fusing them
/// makes the triage-before-collision ordering structurally unforgettable,
/// which is what closes the "unguarded ingress path" class (PKT-6 B1/B4/B5):
/// a new pull path cannot plan collisions or write without first screening.
///
/// `extra_tombstones` are filenames the caller is already deleting this cycle
/// (run_pull's immediate deletes; empty for the empty-map reconcile). They,
/// plus any in-place-rename source (same object_id now at a new filename),
/// are excluded from the collision set so a delete/rename source can't fight
/// its own winner.
fn screen_incoming(
    downloaded: Vec<DownloadedNote>,
    object_map: &HashMap<String, E2eeObjectMapEntry>,
    extra_tombstones: &HashSet<String>,
) -> ScreenedDownloads {
    let DownloadTriage { kept, rejected } = triage_downloaded(downloaded);
    let mut tombstoned = extra_tombstones.clone();
    let filename_by_object_id = build_filename_by_object_id(object_map);
    for note in &kept {
        if let Some(prev) = filename_by_object_id.get(&note.object_id) {
            if prev != &note.filename {
                tombstoned.insert(prev.clone());
            }
        }
    }
    let collision_plan = resolve_pull_collisions(&kept, object_map, &tombstoned);
    ScreenedDownloads {
        kept,
        path_failures: rejected,
        collision_plan,
    }
}

/// Run the pull side of a sync from a specific `since` cursor. The
/// orchestrator captures `pre_push_max_version` BEFORE push and feeds it
/// here so peer changes whose `change_seq` lands between our last sync
/// and our just-completed push don't get skipped.
///
/// Rule 3: takes `state: &ConnectedState` by reference, clones it into
/// `next`, mutates the clone, persists via `state::persist`, and returns the
/// new `ConnectedState` alongside the summary.
pub async fn run_pull(
    state_cell: &ConnectedState,
    notes_root_path: &Path,
    since: u64,
    progress: &ProgFn,
    pre_write: &PreWriteFn,
) -> Result<(SyncSummary, ConnectedState), SyncErrorKind> {
    let http = Arc::new(build_client(state_cell)?);
    let vault_key = Arc::new(state_cell.vault_key);
    let server_objects = http
        .list_objects(&state_cell.collection_id, since)
        .await
        .map_err(SyncErrorKind::collection_http)?;

    let filename_by_object_id = build_filename_by_object_id(&state_cell.object_map);
    let FirstPass {
        to_download,
        immediate_deletes,
        new_max_version,
    } = first_pass(
        server_objects,
        &state_cell.object_map,
        &filename_by_object_id,
        state_cell.max_version,
    );

    // Batched download stage: bin-packed batch requests for small blobs,
    // per-blob GETs for the rest, per-object failure attribution.
    let total_to_download = to_download.len();
    let progress_emitter = ProgressEmitter::new(progress, "pulling", total_to_download);
    let (downloaded, failed_downloads) = download_all(
        http.clone(),
        vault_key.clone(),
        to_download,
        &filename_by_object_id,
        &progress_emitter,
    )
    .await;

    // Screen the download set through the single incoming choke point BEFORE
    // anything else looks at it: legacy/foreign blobs drop out, creatable-but-
    // unsyncable names heal, structurally unsafe names become recorded
    // failures, and collisions are planned across the UNION of this pull's
    // (surviving) downloads AND the persisted object_map — all in one call, so
    // the triage-before-collision ordering can't be skipped (B1/B2/B4). The
    // plan tells us which downloads park at a conflict name and which already-
    // on-disk map entries move aside. `immediate_deletes` (plus in-place rename
    // sources) are excluded from the collision set.
    let immediate_delete_set: HashSet<String> = immediate_deletes.iter().cloned().collect();
    let ScreenedDownloads {
        kept: downloaded,
        path_failures,
        collision_plan,
    } = screen_incoming(downloaded, &state_cell.object_map, &immediate_delete_set);

    // Build apply-delta input. Renames-in-place: same objectId now points
    // at a different filename — drop the old one as a delete here so the
    // map stays consistent with disk.
    let mut updates: Vec<V2IncomingUpdate> = Vec::with_capacity(downloaded.len());
    let mut deletes: HashSet<String> = immediate_delete_set;
    let mut updated_ids: Vec<String> = Vec::with_capacity(downloaded.len());
    let mut deleted_ids: Vec<String> = immediate_deletes.iter().map(|f| filename_to_id(f)).collect();

    // The effective on-disk filename for each download: its conflict-copy name
    // if it lost a collision, else its canonical filename.
    let effective_filename = |idx: usize, note: &DownloadedNote| -> String {
        collision_plan
            .download_overrides
            .get(&idx)
            .cloned()
            .unwrap_or_else(|| note.filename.clone())
    };

    // Move aside any already-on-disk map-only collision losers. We read the
    // loser's current bytes and re-write them under the conflict name, then
    // delete the old name — all through the shared apply path so watcher
    // suppression fires. Done before the download writes so the canonical name
    // is free for the winner.
    let mut collision_conflict_updates: Vec<V2IncomingUpdate> = Vec::new();
    for mv in &collision_plan.map_renames {
        let path = match safe_relative_sync_path(notes_root_path, &mv.old_filename) {
            Ok(p) => p,
            Err(_) => continue,
        };
        // Read the loser's on-disk bytes as sync content — base64 for an image
        // blob, text otherwise — so the re-write under the conflict name
        // round-trips losslessly through apply_delta.
        let is_blob = is_image_filename(&mv.old_filename);
        let content = tokio::task::spawn_blocking(move || {
            if is_blob {
                read_blob_as_base64(&path).ok()
            } else {
                std::fs::read_to_string(&path).ok()
            }
        })
        .await
        .map_err(task_join_err)?;
        let Some(content) = content else { continue };
        let hash = hash_sha256(&content);
        collision_conflict_updates.push(V2IncomingUpdate {
            filename: mv.new_filename.clone(),
            content,
            // 0 ⇒ keep the filesystem's own mtime for the moved-aside copy.
            modified_at: 0,
            hash,
        });
        deletes.insert(mv.old_filename.clone());
        deleted_ids.push(filename_to_id(&mv.old_filename));
    }

    // Identical-content map-only losers: drop the old on-disk file + map entry
    // so the winner is the sole survivor. The removal from the map (below, via
    // `deletes`) keeps the push phase from tombstoning the still-live server
    // object — it is simply left on the server.
    for old in &collision_plan.identical_map_drops {
        deletes.insert(old.clone());
        deleted_ids.push(filename_to_id(old));
    }

    // Rename detection for the pull side. `deleted_hashes` covers
    // tombstones we just observed (look up the soon-to-be-removed map
    // entry's hash) and `created_hashes` covers everything we just
    // downloaded — if any pull-deleted hash matches a pull-or-push
    // create hash, `derive_renames` pairs them.
    let mut deleted_hashes: HashMap<String, String> = HashMap::new();
    for filename in &immediate_deletes {
        if let Some(entry) = state_cell.object_map.get(filename) {
            if let Some(h) = entry.hash.clone() {
                deleted_hashes.insert(h, filename.clone());
            }
        }
    }
    let mut created_hashes: HashMap<String, String> = HashMap::new();
    let mut hash_to_filenames: HashMap<String, Vec<HashFilenameEntry>> = HashMap::new();

    for (idx, note) in downloaded.iter().enumerate() {
        // Identical-content collision loser: the winner already writes these
        // exact bytes at the canonical name — skip it (no write, no map entry).
        // (Non-syncable/unsafe objects were already screened out by
        // `triage_downloaded` before collision planning.)
        if collision_plan.download_skips.contains(&idx) {
            continue;
        }
        let on_disk = effective_filename(idx, note);
        let previous_filename = filename_by_object_id.get(&note.object_id);
        if let Some(prev) = previous_filename {
            if prev != &on_disk {
                deletes.insert(prev.clone());
                deleted_ids.push(filename_to_id(prev));
                // In-place rename (same objectId, new filename): record
                // the previous filename's hash as the rename source.
                if let Some(entry) = state_cell.object_map.get(prev) {
                    if let Some(h) = entry.hash.clone() {
                        deleted_hashes.insert(h, prev.clone());
                    }
                }
            }
        }
        updates.push(V2IncomingUpdate {
            filename: on_disk.clone(),
            content: note.content.clone(),
            hash: note.hash.clone(),
            modified_at: note.modified_at_ms,
        });
        updated_ids.push(filename_to_id(&on_disk));
        created_hashes.insert(note.hash.clone(), on_disk.clone());
        add_hash_filename(
            &mut hash_to_filenames,
            note.hash.clone(),
            on_disk.clone(),
            note.change_seq,
            note.object_id.clone(),
        );
    }

    // The moved-aside conflict copies must be written but NOT re-deleted by
    // any download targeting the same canonical name; they live at distinct
    // conflict names, so order them after the deletes and before/with the
    // update writes. apply_delta deletes first, then writes updates, so a
    // delete of `old_filename` followed by a write of the winner at the
    // canonical name (and the conflict copy at its own name) is safe.
    updates.extend(collision_conflict_updates.iter().cloned());

    let apply_input = V2SyncApplyInput {
        update: updates,
        delete: deletes.iter().cloned().collect(),
        conflicts: Vec::new(),
        timestamps: HashMap::new(),
    };

    // Local content writes this pull applied (peer downloads + moved-aside
    // collision copies). Feeds `SyncSummary::local_writes_applied`.
    let local_writes_applied = apply_input.update.len() as u32;

    // The apply path writes files atomically + records watcher suppressions
    // (via pre_write). Runs synchronously; pure disk work.
    if !apply_input.update.is_empty() || !apply_input.delete.is_empty() {
        apply_delta(notes_root_path, pre_write, apply_input)?;
    }

    // Update the working copy's map + max_version, then persist. Issue #11:
    // the persisted cursor is capped below the lowest failed change_seq so a
    // failed object is re-listed and retried next pull instead of being
    // silently skipped forever. The cap must WIN over the state's incoming
    // cursor: in run_sync the state arrives from run_push, whose own uploads
    // already advanced `max_version` — possibly past a failed seq — so
    // merging with `.max(state)` would re-skip the failed object forever.
    // Floored at `since` so the unknown-seq (0) panic sentinel pins the
    // cursor at its pre-pull value instead of resetting it to 0.
    let downloaded_count = downloaded.len();
    let deletes_count = deletes.len();
    let new_max = cap_cursor(new_max_version, &failed_downloads).max(since);
    let mut next = state_cell.clone();
    for filename in &deletes {
        next.object_map.remove(filename);
    }
    // Re-home moved-aside map-only losers: insert their conflict-name entry
    // carrying the SAME object_id (so the loser round-trips as itself on the
    // next push, never as a new object). The old key was removed via `deletes`.
    for mv in &collision_plan.map_renames {
        if let Some(entry) = state_cell.object_map.get(&mv.old_filename) {
            let mut moved = entry.clone();
            // The packed `path` field changed, so the on-disk hash/mtime/size
            // bookkeeping must be re-derived on the next push: clear the
            // fast-path fields so push re-reads and re-uploads under the new
            // path.
            moved.mtime_ms = None;
            moved.size_bytes = None;
            next.object_map.insert(mv.new_filename.clone(), moved);
        }
    }
    for (idx, note) in downloaded.iter().enumerate() {
        // Identical-content collision loser: not written, so not mapped either.
        if collision_plan.download_skips.contains(&idx) {
            continue;
        }
        let on_disk = effective_filename(idx, note);
        // Sweep stale rename source from the map too.
        if let Some(prev) = filename_by_object_id.get(&note.object_id) {
            if prev != &on_disk {
                next.object_map.remove(prev);
            }
        }
        next.object_map.insert(
            on_disk.clone(),
            E2eeObjectMapEntry {
                object_id: note.object_id.clone(),
                version: note.version,
                blob_key: note.blob_key.clone(),
                hash: Some(note.hash.clone()),
                mtime_ms: Some(note.modified_at_ms),
                size_bytes: Some(note.content.as_bytes().len() as u64),
            },
        );
    }
    next.max_version = new_max;
    // A completed pull is the one place the pull cursor may advance: everything
    // up to `new_max` has now been listed and reconciled (F32). Capped exactly
    // like max_version so a failed download re-lists next pull.
    next.pull_cursor = new_max;
    state::persist(
        notes_root_path,
        &next.object_map,
        next.max_version,
        next.pull_cursor,
        &next.collection_id,
    )
    .map_err(SyncErrorKind::Io)?;

    Ok((
        SyncSummary {
            downloaded: downloaded_count as u32,
            deleted: deletes_count as u32,
            updated_ids: updated_ids.clone(),
            deleted_ids: deleted_ids.clone(),
            peer_updated_ids: updated_ids,
            peer_deleted_ids: deleted_ids,
            local_writes_applied,
            failures: {
                let mut failures: Vec<SyncFailure> =
                    failed_downloads.into_iter().map(|f| f.failure).collect();
                // F8: incoming names we refused to write, surfaced but not
                // cursor-capped (a permanently-invalid name shouldn't re-list
                // every cycle — recording it once is "not silently dropped").
                failures.extend(path_failures);
                failures
            },
            deleted_hashes,
            created_hashes,
            hash_to_filenames,
            ..Default::default()
        },
        next,
    ))
}

// ── Push orchestrator ────────────────────────────────────────────────────

/// Which candidates need a blob upload, plus the delete list (map entries
/// whose files are no longer on disk). Pure data — no I/O — so this is
/// trivial to unit-test.
struct PushPlan {
    candidates: Vec<NoteFileMeta>,
    deletes: Vec<(String, E2eeObjectMapEntry)>,
}

/// Skip files whose `(mtime_ms, size_bytes)` still match the recorded
/// values — we know the content didn't change so we don't need to read,
/// hash, or upload. This is the same fast-path the TS code uses; without
/// it large vaults re-read every file on every cycle and regress the
/// perf this whole rewrite is meant to fix.
// Convenience wrapper used by the unit tests (the orchestrator path always
// goes through `plan_push_with_moves` with the local-move set).
#[cfg(test)]
fn plan_push(
    local_files: &[NoteFileMeta],
    object_map: &HashMap<String, E2eeObjectMapEntry>,
) -> PushPlan {
    plan_push_with_moves(local_files, object_map, &HashSet::new())
}

/// `plan_push` extended with a set of filenames that are locally-moved
/// (a former filename's `object_id` was re-pointed at this filename).
/// Locally-moved files must NEVER be fast-pathed: even if their on-disk
/// hash matches `existing.hash` (the content didn't change, just the
/// path), the packed-note `path` field has changed and the server needs
/// to see the updated blob.
fn plan_push_with_moves(
    local_files: &[NoteFileMeta],
    object_map: &HashMap<String, E2eeObjectMapEntry>,
    local_move_sources: &HashSet<String>,
) -> PushPlan {
    let local_names: HashSet<&str> = local_files.iter().map(|f| f.name.as_str()).collect();

    let mut candidates = Vec::new();
    for f in local_files {
        if local_move_sources.contains(&f.name) {
            candidates.push(f.clone());
            continue;
        }
        let stale = match object_map.get(&f.name) {
            Some(entry) => {
                !(entry.hash.is_some()
                    && entry.mtime_ms == Some(f.mtime_ms)
                    && entry.size_bytes == Some(f.size_bytes))
            }
            None => true,
        };
        if stale {
            candidates.push(f.clone());
        }
    }

    let mut deletes = Vec::new();
    for (filename, entry) in object_map {
        // F7 migration: a legacy-image (pre-D4 `.tiff/.tif/.heif`) or otherwise
        // non-syncable map entry is no longer produced by the local scan
        // (`list_notes_with_meta` filters to `.md` + canonical images), so it
        // would look "deleted locally" and get tombstoned — destroying it on
        // the server and every peer. Never tombstone a non-syncable entry; it
        // is left on the server untouched.
        if !is_syncable_filename(filename) {
            continue;
        }
        if !local_names.contains(filename.as_str()) {
            deletes.push((filename.clone(), entry.clone()));
        }
    }

    PushPlan { candidates, deletes }
}

#[derive(Debug)]
enum PushOutcome {
    /// Content unchanged vs server — only mtime/size needs stamping.
    StampOnly {
        filename: String,
        entry: E2eeObjectMapEntry,
    },
    /// Created or updated successfully.
    Wrote {
        filename: String,
        entry: E2eeObjectMapEntry,
        modified_at: i64,
        change_seq: u64,
        peer_resolved: bool,
    },
    /// 409 + clean 3-way merge: the merged content must be written to the
    /// local file too so disk catches up to what we just PUT.
    /// `previous_filename` is set when the conflict resolver adopted a
    /// peer rename — the original local filename needs to be removed
    /// from the map and disk.
    MergedClean {
        filename: String,
        previous_filename: Option<String>,
        merged_content: String,
        merged_hash: String,
        entry: E2eeObjectMapEntry,
        modified_at: i64,
    },
    /// 409 + dirty merge: target filename now holds the remote content;
    /// our local edits land in a fresh conflict-named file.
    /// `previous_filename` is set when the conflict resolver adopted a
    /// peer rename — the original local filename needs to be removed
    /// from the map and disk.
    ConflictCopy {
        original_filename: String,
        previous_filename: Option<String>,
        remote_content: String,
        remote_hash: String,
        remote_entry: E2eeObjectMapEntry,
        copy_filename: String,
        copy_content: String,
        // Carried from `resolve_update_conflict` for parity with the desktop's
        // PushOutcome; the post-loop reads `copy_entry.hash` instead.
        #[allow(dead_code)]
        copy_hash: String,
        copy_entry: E2eeObjectMapEntry,
    },
    /// Server rejected the blob with HTTP 413 (exceeds `MAX_BLOB_BYTES`).
    /// Counted toward `conflicts` so the UI surfaces it, and the file's mtime
    /// is recorded in `oversize_skip` so we don't re-encrypt/re-upload it every
    /// cycle until the user edits it (changing the mtime).
    TooLarge { filename: String, mtime_ms: i64 },
    /// Upload failed (read/encrypt or POST/PUT). Logged and counted into
    /// `SyncSummary.failures` so the UI can surface it — but not a hard fail,
    /// so one bad file doesn't abort the whole sync. `status_code` is the
    /// server HTTP status when present (`None` for a local read/encrypt error).
    Error {
        filename: String,
        status_code: Option<u16>,
    },
}

async fn read_local_note(notes_root: &Path, filename: &str) -> Result<String, String> {
    // `filename` is the full relative name (`<id>.md` or an image like
    // `image-….png`). Validate + join it once; image blobs read back as
    // base64 so they ride the text note frame, notes read back as UTF-8.
    let path = safe_relative_sync_path(notes_root, filename)?;
    let is_blob = is_image_filename(filename);
    tokio::task::spawn_blocking(move || {
        if is_blob {
            read_blob_as_base64(&path)
        } else {
            std::fs::read_to_string(&path).map_err(|e| e.to_string())
        }
    })
    .await
    .map_err(task_join_err)?
}

async fn encrypt_note(
    vault_key: &[u8; KEY_BYTES],
    filename: &str,
    content: &str,
) -> Result<Vec<u8>, String> {
    let packed = e2ee::pack_note_v2(filename, content);
    e2ee::aes_gcm_encrypt(vault_key, &packed).map_err(e2ee_err_to_string)
}

/// Outcome of the shared "POST a new object" arm. `Created` carries the server
/// write response for the caller to build its own outcome (Wrote vs MergedClean,
/// with the caller's size accounting); `Terminal` is a non-fatal PushOutcome
/// (413 / server error) the caller returns as-is.
// A short-lived intermediate, always matched immediately by the caller; both
// variants wrap types this module already moves by value (PushOutcome is passed
// unboxed everywhere), so boxing to equalize sizes would add churn for no
// runtime benefit.
#[allow(clippy::large_enum_variant)]
enum PostNewOutcome {
    Created(ObjectWriteResponse),
    Terminal(PushOutcome),
}

/// Encrypt + POST `content` as a brand-new object, with the shared 413/error
/// handling. The single copy of push's POST arm (S7): callers build the entry
/// (and the note-vs-image `size_bytes` accounting) themselves so the image
/// special-case can never drift between call sites.
async fn post_new_blob_object(
    http: &Arc<E2eeClient>,
    vault_key: &[u8; KEY_BYTES],
    collection_id: &str,
    filename: &str,
    content: &str,
    mtime_ms: i64,
) -> Result<PostNewOutcome, String> {
    let ciphertext = encrypt_note(vault_key, filename, content).await?;
    match http.post_blob_object(collection_id, ciphertext).await {
        Ok(r) => Ok(PostNewOutcome::Created(r)),
        Err(e) if e.is_payload_too_large() => {
            eprintln!("[e2ee] {filename} exceeds the server blob size limit (413); not synced");
            Ok(PostNewOutcome::Terminal(PushOutcome::TooLarge {
                filename: filename.to_owned(),
                mtime_ms,
            }))
        }
        Err(e) => {
            eprintln!("[e2ee] failed to create {filename}: {e}");
            Ok(PostNewOutcome::Terminal(PushOutcome::Error {
                filename: filename.to_owned(),
                status_code: e.status_code(),
            }))
        }
    }
}

/// Re-POST `content` as a brand-new object and return a `Wrote` outcome (no
/// local write — the caller's disk already holds `content`). Used by the
/// edit-vs-delete `current_blob_key: None` branch, where the local file already
/// holds the dirty edit. Keeping the note on a FRESH object means the tombstone's
/// object_id no longer matches any local file, so the same cycle's pull cannot
/// immediate-delete it — edit wins, symmetric with `resolve_delete_conflict`.
async fn repost_as_fresh_object(
    http: &Arc<E2eeClient>,
    vault_key: &[u8; KEY_BYTES],
    collection_id: &str,
    filename: &str,
    content: &str,
    hash: String,
    mtime_ms: i64,
) -> Result<PushOutcome, String> {
    match post_new_blob_object(http, vault_key, collection_id, filename, content, mtime_ms).await? {
        PostNewOutcome::Terminal(outcome) => Ok(outcome),
        PostNewOutcome::Created(created) => Ok(PushOutcome::Wrote {
            filename: filename.to_owned(),
            entry: E2eeObjectMapEntry {
                object_id: created.object_id,
                version: created.version,
                blob_key: created.blob_key,
                hash: Some(hash),
                mtime_ms: Some(created.updated_at),
                // Note-only path (images never reach an edit-vs-delete): the
                // content IS the on-disk bytes, so its byte length is the size.
                size_bytes: Some(content.as_bytes().len() as u64),
            },
            modified_at: created.updated_at,
            change_seq: created.change_seq,
            peer_resolved: false,
        }),
    }
}

/// 409 path on PUT: download both the current remote blob and our recorded
/// base blob, attempt a 3-way merge. Clean merge → re-PUT with the bumped
/// version. Dirty merge or missing base → conflict-copy fallback.
#[allow(clippy::too_many_arguments)]
async fn resolve_update_conflict(
    http: Arc<E2eeClient>,
    vault_key: Arc<[u8; KEY_BYTES]>,
    collection_id: &str,
    filename: &str,
    local_content: String,
    local_hash: String,
    existing: E2eeObjectMapEntry,
    conflict: ConflictResponse,
    namespace: HashSet<String>,
    is_local_move: bool,
    mtime_ms: i64,
) -> Result<PushOutcome, String> {
    let current_blob_key = match conflict.current_blob_key.clone() {
        Some(k) => k,
        None => {
            // F3: the peer DELETED this object (tombstone) while we held a dirty
            // local edit and the 409 carries no current blob to merge against.
            // (Some servers keep the blob_key on a delete — that case is caught
            // by the `deleted`-flag check on the re-PUT below.) Preserve the
            // edit by re-POSTing it as a FRESH object instead of dropping it:
            // the old code returned an UnresolvedConflict that wrote nothing, so
            // the same cycle's pull immediate-delete then erased the file and the
            // edit was silently lost.
            return repost_as_fresh_object(
                &http, &vault_key, collection_id, filename, &local_content, local_hash, mtime_ms,
            )
            .await;
        }
    };

    // Pull the new remote content so we either merge it or copy it down.
    let remote_ct = http
        .get_blob(&current_blob_key)
        .await
        .map_err(http_err_to_string)?;
    let remote_plain = e2ee::aes_gcm_decrypt(&vault_key, &remote_ct).map_err(e2ee_err_to_string)?;
    let remote = e2ee::unpack_note(&remote_plain).map_err(e2ee_err_to_string)?;
    let remote_hash = hash_sha256(&remote.content);

    // Target filename: if a peer renamed the note (remote.path differs from
    // ours) and we're NOT the local renamer, adopt the peer's filename so
    // the merge lands at the canonical post-rename path. The original
    // local path will be removed via `previous_filename`.
    let target_filename: String = if remote.path != filename && !is_local_move {
        remote.path.clone()
    } else {
        filename.to_owned()
    };
    let previous_filename: Option<String> = if target_filename != filename {
        Some(filename.to_owned())
    } else {
        None
    };

    // Best-effort fetch of the merge base. The server retains orphaned
    // blobs for ~1 year; missing means "fall through to conflict copy."
    // Images carry base64 content, which a line-oriented 3-way text merge
    // would silently corrupt — and two devices never independently mint the
    // same random image filename, so a real same-object image conflict can't
    // happen. Skip the merge entirely for blobs and conflict-copy instead.
    let base_content: Option<String> = if is_image_filename(filename) {
        None
    } else {
        match http.get_blob(&existing.blob_key).await {
            Ok(ct) => e2ee::aes_gcm_decrypt(&vault_key, &ct)
                .ok()
                .and_then(|p| e2ee::unpack_note(&p).ok())
                .map(|n| n.content),
            Err(_) => None,
        }
    };

    if let Some(base) = base_content {
        if let MergeResult::Clean(merged) = e2ee::three_way_merge_text(&base, &remote.content, &local_content) {
            let merged_hash = hash_sha256(&merged);
            let merged_size = merged.as_bytes().len() as u64;
            let merged_ct = encrypt_note(&vault_key, &target_filename, &merged).await?;
            let put_result = match http
                .put_blob_object(collection_id, &existing.object_id, conflict.current_version + 1, merged_ct)
                .await
            {
                Ok(result) => result,
                Err(e) if e.is_payload_too_large() => {
                    eprintln!("[e2ee] {target_filename} exceeds the server blob size limit (413); not synced");
                    return Ok(PushOutcome::TooLarge { filename: target_filename, mtime_ms });
                }
                Err(e) => return Err(http_err_to_string(e)),
            };
            match put_result {
                PutResult::Ok(resp) => {
                    if resp.deleted {
                        // F3 (real-server edit-vs-delete): the peer had DELETED
                        // this object. The server's DELETE keeps the blob_key and
                        // bumps the version, so our 409 carried a blob to merge
                        // against and the re-PUT "succeeded" — but the row is
                        // still a tombstone (PUT does not un-delete). Mapping the
                        // note to this object would let the same cycle's pull
                        // immediate-delete erase it and lose the merged edit.
                        // Re-POST the merged content as a FRESH live object and
                        // yield a MergedClean-shaped outcome: `merged` can differ
                        // from BOTH the local bytes and the remote (a genuine
                        // 3-way merge incorporating the peer's pre-delete edit), so
                        // it MUST be written to disk — a bare Wrote never writes
                        // locally, so the next cycle would re-upload the stale
                        // local bytes over the merge and erase the peer's
                        // contribution fleet-wide (S9).
                        return match post_new_blob_object(
                            &http,
                            &vault_key,
                            collection_id,
                            &target_filename,
                            &merged,
                            mtime_ms,
                        )
                        .await?
                        {
                            PostNewOutcome::Terminal(outcome) => Ok(outcome),
                            PostNewOutcome::Created(created) => Ok(PushOutcome::MergedClean {
                                filename: target_filename,
                                previous_filename,
                                merged_content: merged,
                                merged_hash: merged_hash.clone(),
                                entry: E2eeObjectMapEntry {
                                    object_id: created.object_id,
                                    version: created.version,
                                    blob_key: created.blob_key,
                                    hash: Some(merged_hash),
                                    mtime_ms: Some(created.updated_at),
                                    size_bytes: Some(merged_size),
                                },
                                modified_at: created.updated_at,
                            }),
                        };
                    }
                    return Ok(PushOutcome::MergedClean {
                        filename: target_filename,
                        previous_filename,
                        merged_content: merged,
                        merged_hash: merged_hash.clone(),
                        entry: E2eeObjectMapEntry {
                            object_id: resp.object_id,
                            version: resp.version,
                            blob_key: resp.blob_key,
                            hash: Some(merged_hash),
                            mtime_ms: Some(resp.updated_at),
                            size_bytes: Some(merged_size),
                        },
                        modified_at: resp.updated_at,
                    });
                }
                PutResult::Conflict(_) => {
                    // Lost the race a second time; fall through to a
                    // conflict copy so the user's local edits are saved.
                }
            }
        }
    }

    // Identical content is not a conflict. If our local bytes already match
    // the remote we just fetched (same hash), the 409 was a spurious race: a
    // peer advanced the object to the exact content we hold. This is common
    // when the merge-base blob has been GC'd (the clean-merge branch above is
    // skipped for a missing base), so without this guard identical content
    // falls straight through to a conflict copy — minting a byte-identical new
    // object every cycle, which the pull-side collision resolver then re-parks
    // under an ever-deeper name (the July 2026 combinatorial blow-up). Adopt
    // the remote object state instead: no copy, no new object. Reuses the
    // MergedClean outcome (target now holds this content; map adopts the
    // remote object), which also drops `previous_filename` on a peer rename.
    if local_hash == remote_hash {
        return Ok(PushOutcome::MergedClean {
            filename: target_filename,
            previous_filename,
            merged_content: remote.content,
            merged_hash: remote_hash.clone(),
            entry: E2eeObjectMapEntry {
                object_id: existing.object_id.clone(),
                version: conflict.current_version,
                blob_key: current_blob_key,
                hash: Some(remote_hash),
                mtime_ms: None,
                size_bytes: None,
            },
            modified_at: now_ms(),
        });
    }

    // Conflict-copy path: keep the remote on the target filename and
    // park the user's local edits in `note (conflict YYYY-MM-DD).md`.
    let date = current_date_yyyy_mm_dd();
    let copy_filename = conflict_filename(&target_filename, &date, &namespace);
    let copy_ct = encrypt_note(&vault_key, &copy_filename, &local_content).await?;
    let created = match http.post_blob_object(collection_id, copy_ct).await {
        Ok(result) => result,
        Err(e) if e.is_payload_too_large() => {
            eprintln!("[e2ee] {copy_filename} exceeds the server blob size limit (413); not synced");
            return Ok(PushOutcome::TooLarge { filename: copy_filename, mtime_ms });
        }
        Err(e) => return Err(http_err_to_string(e)),
    };

    // Update the original objectId to track the remote content we just
    // accepted. The server's `currentVersion` is already past us so we
    // record it as the new map state — no extra PUT needed.
    let remote_entry = E2eeObjectMapEntry {
        object_id: existing.object_id.clone(),
        version: conflict.current_version,
        blob_key: current_blob_key,
        hash: Some(remote_hash.clone()),
        mtime_ms: None,
        size_bytes: None,
    };
    let copy_entry = E2eeObjectMapEntry {
        object_id: created.object_id,
        version: created.version,
        blob_key: created.blob_key,
        hash: Some(local_hash.clone()),
        mtime_ms: Some(created.updated_at),
        size_bytes: Some(local_content.as_bytes().len() as u64),
    };

    Ok(PushOutcome::ConflictCopy {
        original_filename: target_filename,
        previous_filename,
        remote_content: remote.content,
        remote_hash,
        remote_entry,
        copy_filename,
        copy_content: local_content,
        copy_hash: local_hash,
        copy_entry,
    })
}

/// Today's date as `YYYY-MM-DD`. Used to stamp conflict-copy filenames.
fn current_date_yyyy_mm_dd() -> String {
    let now = time::OffsetDateTime::now_utc();
    format!("{:04}-{:02}-{:02}", now.year(), u8::from(now.month()), now.day())
}

#[allow(clippy::too_many_arguments)]
async fn push_one_file(
    notes_root: PathBuf,
    http: Arc<E2eeClient>,
    vault_key: Arc<[u8; KEY_BYTES]>,
    collection_id: String,
    file: NoteFileMeta,
    existing: Option<E2eeObjectMapEntry>,
    namespace: HashSet<String>,
    is_local_move: bool,
    oversize_mark: Option<i64>,
) -> Result<PushOutcome, String> {
    let filename = file.name.clone();

    // Pre-flight skip: the server already rejected this exact version (same
    // mtime) as too large (413). Don't re-read/re-encrypt/re-upload it — that
    // wastes a full-size upload every cycle for a guaranteed 413. The mark is
    // cleared once the mtime changes (user edited the note again).
    if oversize_mark == Some(file.mtime_ms) {
        return Ok(PushOutcome::TooLarge { filename, mtime_ms: file.mtime_ms });
    }

    let content = match read_local_note(&notes_root, &filename).await {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[e2ee] could not read {filename}: {e}");
            return Ok(PushOutcome::Error { filename, status_code: None });
        }
    };
    let hash = hash_sha256(&content);
    // `size` feeds the object-map entry, which the push fast-path
    // (`plan_push_with_moves`) compares against the on-disk `meta.len()` from
    // the scan. For a note the content IS the on-disk bytes, but an image's
    // `content` is base64 (~33% larger than the file), so we must record the
    // RAW on-disk size (`file.size_bytes`) for blobs — otherwise the fast-path
    // would miss every cycle and re-read/-encode the image forever.
    let size = if is_image_filename(&filename) {
        file.size_bytes
    } else {
        content.as_bytes().len() as u64
    };

    // Hash matches the recorded entry — content didn't change despite the
    // mtime/size fast-path miss (a content-identical touch: editor re-save,
    // relink rewrite, `touch`). Keep the recorded server-authoritative
    // mtime; the StampOnly handler feeds it into the timestamp-correction
    // pass, which restores the file's on-disk mtime. Adopting the local
    // mtime here would permanently diverge this device's note ordering
    // from every other device. Fall back to the local mtime only when the
    // entry has none recorded (diverged marker). Skip this short-circuit
    // for local moves: the path changed, so even though the content
    // didn't, the encrypted blob's packed `path` field needs to update.
    if !is_local_move {
        if let Some(e) = &existing {
            if e.hash.as_deref() == Some(hash.as_str()) {
                let entry = E2eeObjectMapEntry {
                    object_id: e.object_id.clone(),
                    version: e.version,
                    blob_key: e.blob_key.clone(),
                    hash: Some(hash),
                    mtime_ms: e.mtime_ms.or(Some(file.mtime_ms)),
                    size_bytes: Some(size),
                };
                return Ok(PushOutcome::StampOnly { filename, entry });
            }
        }
    }

    // No prior entry → POST as a new object (shared POST arm; `size` carries
    // the note-vs-image special-case so it can't drift from the F3 re-POST).
    if existing.is_none() {
        return Ok(
            match post_new_blob_object(&http, &vault_key, &collection_id, &filename, &content, file.mtime_ms)
                .await?
            {
                PostNewOutcome::Terminal(outcome) => outcome,
                PostNewOutcome::Created(created) => PushOutcome::Wrote {
                    filename,
                    entry: E2eeObjectMapEntry {
                        object_id: created.object_id,
                        version: created.version,
                        blob_key: created.blob_key,
                        hash: Some(hash),
                        mtime_ms: Some(created.updated_at),
                        size_bytes: Some(size),
                    },
                    modified_at: created.updated_at,
                    change_seq: created.change_seq,
                    peer_resolved: false,
                },
            },
        );
    }

    // Update path: PUT with expected_version; 409 → resolve.
    let ciphertext = encrypt_note(&vault_key, &filename, &content).await?;
    let existing = existing.unwrap();
    match http
        .put_blob_object(
            &collection_id,
            &existing.object_id,
            existing.version + 1,
            ciphertext,
        )
        .await
    {
        Ok(PutResult::Ok(r)) => {
            if r.deleted {
                // Direct-PUT-onto-tombstone (edit-vs-delete, silent-loss half):
                // a peer DELETED this object while we were disconnected. The
                // server's DELETE bumps the version, so our expected_version
                // (recorded + 1) MATCHED the post-delete version and the PUT
                // "succeeded" WITHOUT a 409 — but the row is still a tombstone
                // (PUT does not un-delete). Mapping the note to this deleted
                // object would let the SAME cycle's pull apply the tombstone and
                // delete our just-edited file: silent loss, no conflict copy.
                // Re-POST as a FRESH live object so the tombstone's object_id no
                // longer matches any local file (edit wins — symmetric with the
                // merge-onto-tombstone arm in resolve_update_conflict, and with
                // the F3 `current_blob_key: None` branch).
                //
                // Wrote-shaped (NOT MergedClean) is correct here: unlike the
                // merge arm — whose `merged` can differ from BOTH disk and remote
                // and so MUST be written back — `content` is the VERBATIM on-disk
                // bytes we just read, so the local file already holds exactly what
                // we re-POST. There is nothing to write locally; repost_as_fresh_object
                // returns a `Wrote` (no local write), which is precisely right.
                return repost_as_fresh_object(
                    &http,
                    &vault_key,
                    &collection_id,
                    &filename,
                    &content,
                    hash,
                    file.mtime_ms,
                )
                .await;
            }
            let entry = E2eeObjectMapEntry {
                object_id: existing.object_id.clone(),
                version: r.version,
                blob_key: r.blob_key,
                hash: Some(hash),
                mtime_ms: Some(r.updated_at),
                size_bytes: Some(size),
            };
            Ok(PushOutcome::Wrote {
                filename,
                entry,
                modified_at: r.updated_at,
                change_seq: r.change_seq,
                peer_resolved: false,
            })
        }
        Ok(PutResult::Conflict(conflict)) => {
            resolve_update_conflict(
                http,
                vault_key,
                &collection_id,
                &filename,
                content,
                hash,
                existing,
                conflict,
                namespace,
                is_local_move,
                file.mtime_ms,
            )
            .await
        }
        Err(e) if e.is_payload_too_large() => {
            eprintln!("[e2ee] {filename} exceeds the server blob size limit (413); not synced");
            Ok(PushOutcome::TooLarge { filename, mtime_ms: file.mtime_ms })
        }
        Err(e) => {
            eprintln!("[e2ee] failed to update {filename}: {e}");
            Ok(PushOutcome::Error { filename, status_code: e.status_code() })
        }
    }
}

/// Edit-wins delete resolution: if DELETE returns 409 because a peer
/// updated the note while we were trying to delete, fetch the new blob
/// and treat it as a peer-pushed update locally.
async fn resolve_delete_conflict(
    http: Arc<E2eeClient>,
    vault_key: Arc<[u8; KEY_BYTES]>,
    _filename: &str,
    conflict: ConflictResponse,
) -> Result<Option<(String, String, String, E2eeObjectMapEntry, i64)>, String> {
    let current_blob_key = match conflict.current_blob_key.clone() {
        Some(k) => k,
        None => return Ok(None),
    };
    let ct = http.get_blob(&current_blob_key).await.map_err(http_err_to_string)?;
    let plain = e2ee::aes_gcm_decrypt(&vault_key, &ct).map_err(e2ee_err_to_string)?;
    let note = e2ee::unpack_note(&plain).map_err(e2ee_err_to_string)?;
    let hash = hash_sha256(&note.content);
    let modified_at = now_ms();
    let entry = E2eeObjectMapEntry {
        // ObjectId comes from the existing map entry the caller knows; we
        // pass it back through the tuple.
        object_id: String::new(),
        version: conflict.current_version,
        blob_key: current_blob_key,
        hash: Some(hash.clone()),
        mtime_ms: Some(modified_at),
        size_bytes: Some(note.content.as_bytes().len() as u64),
    };
    Ok(Some((note.path, note.content, hash, entry, modified_at)))
}

#[allow(clippy::too_many_lines)]
pub async fn run_push(
    state_cell: &ConnectedState,
    notes_root_path: &Path,
    progress: &ProgFn,
    pre_write: &PreWriteFn,
) -> Result<(SyncSummary, ConnectedState), SyncErrorKind> {
    let http = Arc::new(build_client(state_cell)?);
    let vault_key = Arc::new(state_cell.vault_key);

    // Owned working copy we mutate + persist (Rule 3). Mirrors the desktop's
    // `SyncState` cell; we `state::persist(&next.object_map, …)` at exactly the
    // points the desktop called `state.persist`.
    let mut next = state_cell.clone();

    let root_for_walk = notes_root_path.to_path_buf();
    let local_files = tokio::task::spawn_blocking(move || list_notes_with_meta(&root_for_walk))
        .await
        .map_err(task_join_err)?;
    // Keep only syncable rows — `.md` notes and image blobs — just in case
    // (`list_notes_with_meta` already filters, but defense-in-depth keeps push
    // logic local).
    let local_files: Vec<NoteFileMeta> = local_files
        .into_iter()
        .filter(|f| f.name.ends_with(".md") || is_image_filename(&f.name))
        .collect();

    // Detect 1-to-1 local renames before planning. Rewrites a working
    // copy of the object_map so a "delete grocery + create Lists/grocery"
    // pair pushes as a single PUT on the same `object_id` rather than
    // a DELETE + POST. DELETE+POST would tombstone the object and break
    // a concurrent peer edit (peer's PUT would 409 with no current blob
    // to merge against).
    let local_move_pairings = pair_local_moved_objects(&local_files, &state_cell.object_map);
    let mut effective_map = state_cell.object_map.clone();
    for (new_name, old_name) in &local_move_pairings {
        if let Some(entry) = effective_map.remove(old_name) {
            effective_map.insert(new_name.clone(), entry);
        }
    }
    let local_move_sources: HashSet<String> = local_move_pairings.keys().cloned().collect();

    let plan = plan_push_with_moves(&local_files, &effective_map, &local_move_sources);

    // Build the namespace of filenames a conflict-copy must not collide
    // with: union of on-disk + map. Computed once up front; passed to
    // each worker that might need to mint a fresh name.
    let mut namespace: HashSet<String> = HashSet::new();
    for f in &local_files {
        namespace.insert(f.name.clone());
    }
    for k in effective_map.keys() {
        namespace.insert(k.clone());
    }

    // Spawn push workers behind a semaphore. Each returns an outcome we
    // merge into the shared state below.
    let total_candidates = plan.candidates.len();
    let progress_emitter = ProgressEmitter::new(progress, "pushing", total_candidates);
    let semaphore = Arc::new(Semaphore::new(PUSH_CONCURRENCY));
    let mut set: JoinSet<Result<PushOutcome, String>> = JoinSet::new();
    for file in plan.candidates {
        let existing = effective_map.get(&file.name).cloned();
        let is_local_move = local_move_sources.contains(&file.name);
        let oversize_mark = state_cell.oversize_skip.get(&file.name).copied();
        let http = http.clone();
        let vault_key = vault_key.clone();
        let cid = state_cell.collection_id.clone();
        let ns = namespace.clone();
        let root = notes_root_path.to_path_buf();
        let permit_sem = semaphore.clone();
        set.spawn(async move {
            let _permit = permit_sem.acquire_owned().await.expect("semaphore closed");
            push_one_file(
                root,
                http,
                vault_key,
                cid,
                file,
                existing,
                ns,
                is_local_move,
                oversize_mark,
            )
            .await
        });
    }

    // Checkpoint every N completed uploads. Without this, a single
    // process crash partway through a large first-sync re-uploads
    // everything next time — the blob is on the server, but the local
    // object_map doesn't reflect it, so the next push sees the file as
    // brand-new and POSTs a duplicate. We only checkpoint the simple
    // outcomes (StampOnly + Wrote) — MergedClean and ConflictCopy carry
    // local file writes that must stay in the batched post-loop apply.
    const PUSH_CHECKPOINT_EVERY: usize = 50;
    let mut outcomes: Vec<PushOutcome> = Vec::new();
    // Per-item failures collected across the join loop, checkpoint persists,
    // the delete loop, and the outcome flatten below. Folded into the summary.
    let mut failures: Vec<SyncFailure> = Vec::new();
    // Interim and final checkpoint persists share one disk fault; record it
    // once per cycle so the failure count stays honest.
    let mut checkpoint_failed = false;
    let mut pending_ckpt_upserts: Vec<(String, E2eeObjectMapEntry)> = Vec::new();
    let mut pending_ckpt_max_version: u64 = state_cell.max_version;
    let mut since_ckpt: usize = 0;
    while let Some(joined) = set.join_next().await {
        match joined {
            Ok(Ok(out)) => {
                progress_emitter.bump();
                if let Some((fname, entry, change_seq)) = checkpointable_upsert(&out) {
                    if entry.version > pending_ckpt_max_version {
                        pending_ckpt_max_version = entry.version;
                    }
                    if change_seq > pending_ckpt_max_version {
                        pending_ckpt_max_version = change_seq;
                    }
                    pending_ckpt_upserts.push((fname, entry));
                    since_ckpt += 1;
                }
                outcomes.push(out);
                if since_ckpt >= PUSH_CHECKPOINT_EVERY {
                    let upserts_now = std::mem::take(&mut pending_ckpt_upserts);
                    let max_now = pending_ckpt_max_version;
                    for (k, v) in upserts_now {
                        next.object_map.insert(k, v);
                    }
                    next.max_version = next.max_version.max(max_now);
                    // Push advances only max_version; the pull cursor is
                    // preserved so a crash here can't blind the next pull (F32).
                    if let Err(e) = state::persist(
                        notes_root_path,
                        &next.object_map,
                        next.max_version,
                        next.pull_cursor,
                        &next.collection_id,
                    ) {
                        eprintln!("[e2ee] push checkpoint persist failed: {e}");
                        checkpoint_failed = true;
                    }
                    since_ckpt = 0;
                }
            }
            Ok(Err(e)) => {
                eprintln!("[e2ee] push task errored: {e}");
                failures.push(SyncFailure {
                    filename: String::new(),
                    kind: FailureKind::Upload,
                    status_code: None,
                });
                progress_emitter.bump();
            }
            Err(e) => {
                eprintln!("[e2ee] push task panicked: {e}");
                failures.push(SyncFailure {
                    filename: String::new(),
                    kind: FailureKind::Upload,
                    status_code: None,
                });
                progress_emitter.bump();
            }
        }
    }
    // Final partial flush for any unpersisted upserts. The post-loop
    // pass below re-applies the same upserts under one mutation
    // (insert is idempotent), so doing this here is purely defensive
    // against a crash between here and the final persist.
    if !pending_ckpt_upserts.is_empty() {
        let upserts_tail = std::mem::take(&mut pending_ckpt_upserts);
        let max_tail = pending_ckpt_max_version;
        for (k, v) in upserts_tail {
            next.object_map.insert(k, v);
        }
        next.max_version = next.max_version.max(max_tail);
        if let Err(e) = state::persist(
            notes_root_path,
            &next.object_map,
            next.max_version,
            next.pull_cursor,
            &next.collection_id,
        ) {
            eprintln!("[e2ee] push final checkpoint persist failed: {e}");
            checkpoint_failed = true;
        }
    }
    if checkpoint_failed {
        failures.push(SyncFailure {
            filename: String::new(),
            kind: FailureKind::Checkpoint,
            status_code: None,
        });
    }

    // Push deletes serially. The TS code does the same — delete volume is
    // typically tiny and serial keeps the 409 → restore path simple.
    let mut delete_results: Vec<(String, DeletePushResult)> = Vec::new();
    for (filename, entry) in plan.deletes {
        let res = http
            .delete_object(&state_cell.collection_id, &entry.object_id, entry.version)
            .await;
        match res {
            Ok(DeleteResult::Ok(ok)) => {
                delete_results.push((filename, DeletePushResult::Confirmed(ok.change_seq)));
            }
            Ok(DeleteResult::Conflict(c)) => {
                match resolve_delete_conflict(http.clone(), vault_key.clone(), &filename, c).await {
                    Ok(Some((restored_filename, restored_content, restored_hash, mut restored_entry, modified_at))) => {
                        restored_entry.object_id = entry.object_id.clone();
                        delete_results.push((
                            filename,
                            DeletePushResult::RestoredAs {
                                filename: restored_filename,
                                content: restored_content,
                                hash: restored_hash,
                                entry: restored_entry,
                                modified_at,
                            },
                        ));
                    }
                    Ok(None) => {
                        eprintln!("[e2ee] delete 409 missing currentBlobKey for {filename}");
                        failures.push(SyncFailure {
                            filename: filename.clone(),
                            kind: FailureKind::Delete,
                            status_code: None,
                        });
                    }
                    Err(e) => {
                        eprintln!("[e2ee] delete-conflict restore failed for {filename}: {e}");
                        failures.push(SyncFailure {
                            filename: filename.clone(),
                            kind: FailureKind::Delete,
                            status_code: None,
                        });
                    }
                }
            }
            Err(e) => {
                eprintln!("[e2ee] delete failed for {filename}: {e}");
                failures.push(SyncFailure {
                    filename: filename.clone(),
                    kind: FailureKind::Delete,
                    status_code: e.status_code(),
                });
            }
        }
    }

    // ── Now flatten outcomes + delete results into a single apply pass ──

    let mut updates: Vec<V2IncomingUpdate> = Vec::new();
    let mut conflict_writes: Vec<V2IncomingConflict> = Vec::new();
    let mut timestamps: HashMap<String, i64> = HashMap::new();
    let mut deletes_to_apply: HashSet<String> = HashSet::new();

    let mut upserts: Vec<(String, E2eeObjectMapEntry)> = Vec::new();
    let mut removes: HashSet<String> = HashSet::new();

    // Local-move pairings: the OLD filename's map entry was re-pointed
    // at the NEW filename inside `effective_map`. The persisted state
    // still has the OLD entry, so register it for removal here.
    for (new_name, old_name) in &local_move_pairings {
        if new_name != old_name {
            removes.insert(old_name.clone());
        }
    }

    let mut uploaded = 0u32;
    let mut conflicts = 0u32;
    // Peer content that arrives via the push side (edit-wins delete-conflict
    // restore). These are genuine peer downloads even though they're
    // produced while pushing, so they must be counted as `downloaded`.
    let mut downloaded = 0u32;
    let mut updated_ids: Vec<String> = Vec::new();
    let mut deleted_ids: Vec<String> = Vec::new();
    let mut peer_updated_ids: Vec<String> = Vec::new();
    let peer_deleted_ids: Vec<String> = Vec::new();
    let mut new_max_version = state_cell.max_version;
    // Rename detection: record every (hash, filename) pair we delete or
    // create. After both push and pull run, `derive_renames` looks for
    // hashes that appear on both sides — a local rename surfaces as
    // "deleted at old name AND created at new name with same hash."
    let mut deleted_hashes: HashMap<String, String> = HashMap::new();
    let mut created_hashes: HashMap<String, String> = HashMap::new();
    let mut hash_to_filenames: HashMap<String, Vec<HashFilenameEntry>> = HashMap::new();

    for outcome in outcomes {
        match outcome {
            PushOutcome::StampOnly { filename, entry } => {
                next.oversize_skip.remove(&filename);
                upserts.push((filename.clone(), entry.clone()));
                if let Some(ts) = entry.mtime_ms {
                    timestamps.insert(filename.clone(), ts);
                }
            }
            PushOutcome::Wrote { filename, entry, modified_at, change_seq, peer_resolved } => {
                next.oversize_skip.remove(&filename);
                uploaded += 1;
                if entry.version > new_max_version {
                    new_max_version = entry.version;
                }
                if change_seq > new_max_version {
                    new_max_version = change_seq;
                }
                timestamps.insert(filename.clone(), modified_at);
                // Brand-new filename (no prior map entry) → record for
                // rename detection. In-place updates of an existing
                // filename don't contribute — the hash is fresh content,
                // not a moved-from-elsewhere blob.
                if !state_cell.object_map.contains_key(&filename) {
                    if let Some(h) = entry.hash.clone() {
                        created_hashes.insert(h, filename.clone());
                    }
                }
                if let Some(h) = entry.hash.clone() {
                    add_hash_filename(
                        &mut hash_to_filenames,
                        h,
                        filename.clone(),
                        change_seq,
                        entry.object_id.clone(),
                    );
                }
                upserts.push((filename.clone(), entry));
                updated_ids.push(filename_to_id(&filename));
                if peer_resolved {
                    peer_updated_ids.push(filename_to_id(&filename));
                }
            }
            PushOutcome::MergedClean {
                filename,
                previous_filename,
                merged_content,
                merged_hash,
                entry,
                modified_at,
            } => {
                uploaded += 1;
                if entry.version > new_max_version {
                    new_max_version = entry.version;
                }
                // Write the merged text locally so disk catches up.
                updates.push(V2IncomingUpdate {
                    filename: filename.clone(),
                    content: merged_content,
                    hash: merged_hash,
                    modified_at,
                });
                if let Some(prev) = previous_filename {
                    if prev != filename {
                        deletes_to_apply.insert(prev.clone());
                        removes.insert(prev);
                    }
                }
                upserts.push((filename.clone(), entry));
                updated_ids.push(filename_to_id(&filename));
                peer_updated_ids.push(filename_to_id(&filename));
            }
            PushOutcome::ConflictCopy {
                original_filename,
                previous_filename,
                remote_content,
                remote_hash,
                remote_entry,
                copy_filename,
                copy_content,
                copy_hash: _,
                copy_entry,
            } => {
                uploaded += 1;
                conflicts += 1;
                if remote_entry.version > new_max_version {
                    new_max_version = remote_entry.version;
                }
                if copy_entry.version > new_max_version {
                    new_max_version = copy_entry.version;
                }
                // Write remote → original, local → copy filename.
                updates.push(V2IncomingUpdate {
                    filename: original_filename.clone(),
                    content: remote_content,
                    hash: remote_hash,
                    modified_at: now_ms(),
                });
                conflict_writes.push(V2IncomingConflict {
                    filename: copy_filename.clone(),
                    content: copy_content,
                });
                if let Some(ts) = copy_entry.mtime_ms {
                    timestamps.insert(copy_filename.clone(), ts);
                }
                if let Some(prev) = previous_filename {
                    if prev != original_filename {
                        deletes_to_apply.insert(prev.clone());
                        removes.insert(prev);
                    }
                }
                upserts.push((original_filename.clone(), remote_entry));
                upserts.push((copy_filename.clone(), copy_entry));
                updated_ids.push(filename_to_id(&original_filename));
                updated_ids.push(filename_to_id(&copy_filename));
                peer_updated_ids.push(filename_to_id(&original_filename));
                peer_updated_ids.push(filename_to_id(&copy_filename));
            }
            PushOutcome::TooLarge { filename, mtime_ms } => {
                // Surface to the user via the conflict count and remember the
                // mtime so we skip the re-upload next cycle until the user edits
                // the note.
                conflicts += 1;
                next.oversize_skip.insert(filename, mtime_ms);
            }
            PushOutcome::Error { filename, status_code } => {
                failures.push(SyncFailure {
                    filename,
                    kind: FailureKind::Upload,
                    status_code,
                });
            }
        }
    }

    for (filename, res) in delete_results {
        match res {
            DeletePushResult::Confirmed(change_seq) => {
                if change_seq > new_max_version {
                    new_max_version = change_seq;
                }
                // Record the hash of the entry we just deleted so
                // `derive_renames` can pair it with a same-hash create.
                if let Some(entry) = state_cell.object_map.get(&filename) {
                    if let Some(h) = entry.hash.clone() {
                        deleted_hashes.insert(h, filename.clone());
                    }
                }
                deletes_to_apply.insert(filename.clone());
                removes.insert(filename.clone());
                deleted_ids.push(filename_to_id(&filename));
            }
            DeletePushResult::RestoredAs {
                filename: restored,
                content,
                hash,
                entry,
                modified_at,
            } => {
                // The restored filename is peer/server-controlled (the object
                // was restored during a delete-vs-edit race), so screen it
                // through the same classifier as any incoming write before it
                // reaches the writer (B5): heal a creatable-but-unsyncable name,
                // and refuse a structurally-unsafe or non-syncable one rather
                // than write a hostile name or abort the push.
                let safe_restored = match classify_incoming_sync_path(&restored) {
                    IncomingSyncPath::Accept => Some(restored.clone()),
                    IncomingSyncPath::Sanitize(healed) => Some(healed),
                    IncomingSyncPath::Ignore | IncomingSyncPath::Reject(_) => None,
                };
                match safe_restored {
                    Some(restored) => {
                        // C1: the restore name (server-renamed during the race,
                        // or healed above) can collide with an UNRELATED note
                        // already tracked under that name. Writing it there would
                        // overwrite that note AND replace its map entry — data
                        // loss. If the target is owned by a DIFFERENT object,
                        // park the restore at a deterministic conflict copy, the
                        // same way pull collisions resolve; the existing note
                        // keeps the canonical name.
                        let restored = match next.object_map.get(&restored) {
                            Some(existing) if existing.object_id != entry.object_id => {
                                collision_conflict_filename(&restored, &entry.object_id)
                            }
                            _ => restored,
                        };
                        // Remove the old (deleted-locally) entry and write the
                        // restored blob in its place. If the restore landed on a
                        // different filename (rename/heal/park) the old filename
                        // is dropped from the map.
                        if filename != restored {
                            removes.insert(filename.clone());
                        }
                        updates.push(V2IncomingUpdate {
                            filename: restored.clone(),
                            content,
                            hash,
                            modified_at,
                        });
                        upserts.push((restored.clone(), entry));
                        updated_ids.push(filename_to_id(&restored));
                        peer_updated_ids.push(filename_to_id(&restored));
                        // The peer's content was just written back to disk via
                        // the edit-wins restore. This is a real peer download —
                        // count it so totals are honest. The subsequent run_pull
                        // sees this object already at the restored version and
                        // skips it, so there's no double-counting.
                        downloaded += 1;
                    }
                    None => {
                        // Can't safely materialize the restore — surface it,
                        // don't abort the push, don't write a hostile name. C2:
                        // DROP the stale map entry for the locally-deleted file
                        // so the next cycle doesn't re-plan the same delete →
                        // 409 → re-reject forever; the object is left on the
                        // server (the pull side rejects it once and advances).
                        removes.insert(filename.clone());
                        failures.push(SyncFailure {
                            filename: restored,
                            kind: FailureKind::Rejected,
                            status_code: None,
                        });
                    }
                }
            }
        }
    }

    // Count local disk writes BEFORE the vectors are moved into apply_delta.
    // Every push-side content write (MergedClean, ConflictCopy, edit-wins
    // restore) lands in `updates`/`conflict_writes`, so this is the exact set
    // a stale open editor must reload for — see `SyncSummary::local_writes_applied`.
    let local_writes_applied = (updates.len() + conflict_writes.len()) as u32;

    // Apply file writes + deletes + mtime stamps in one batched call.
    if !updates.is_empty() || !deletes_to_apply.is_empty() || !conflict_writes.is_empty() || !timestamps.is_empty()
    {
        let apply_input = V2SyncApplyInput {
            update: updates,
            delete: deletes_to_apply.iter().cloned().collect(),
            conflicts: conflict_writes,
            timestamps,
        };
        apply_delta(notes_root_path, pre_write, apply_input)?;
    }

    // Update the working-copy map + max version, then persist.
    let new_max = new_max_version;
    for filename in &removes {
        next.object_map.remove(filename);
    }
    for (filename, entry) in &upserts {
        next.object_map.insert(filename.clone(), entry.clone());
    }
    next.max_version = next.max_version.max(new_max);
    // Push leaves the pull cursor where the last completed pull set it; the
    // following run_pull re-observes our own pushed objects and advances it.
    state::persist(
        notes_root_path,
        &next.object_map,
        next.max_version,
        next.pull_cursor,
        &next.collection_id,
    )
    .map_err(SyncErrorKind::Io)?;

    Ok((
        SyncSummary {
            uploaded,
            downloaded,
            deleted: removes.len() as u32,
            conflicts,
            failures,
            updated_ids,
            deleted_ids,
            peer_updated_ids,
            peer_deleted_ids,
            local_writes_applied,
            deleted_hashes,
            created_hashes,
            hash_to_filenames,
            ..Default::default()
        },
        next,
    ))
}

#[derive(Debug)]
enum DeletePushResult {
    Confirmed(u64),
    RestoredAs {
        filename: String,
        content: String,
        hash: String,
        entry: E2eeObjectMapEntry,
        modified_at: i64,
    },
}

/// Return the (filename, entry, change_seq) tuple to persist for a
/// PushOutcome that is safe to checkpoint mid-loop. Outcomes that
/// involve LOCAL file writes (MergedClean, ConflictCopy) must stay in
/// the batched post-loop apply, so we skip them here.
fn checkpointable_upsert(out: &PushOutcome) -> Option<(String, E2eeObjectMapEntry, u64)> {
    match out {
        PushOutcome::StampOnly { filename, entry } => {
            Some((filename.clone(), entry.clone(), 0))
        }
        PushOutcome::Wrote { filename, entry, change_seq, .. } => {
            Some((filename.clone(), entry.clone(), *change_seq))
        }
        _ => None,
    }
}

/// Result of a duplicate-move resolution pass. `deleted_ids` are the note ids
/// whose redundant local copy we removed; `conflicts` matches the legacy TS
/// counter for the user-facing "N conflicts resolved" badge.
#[derive(Debug, Default)]
struct DuplicateResolution {
    conflicts: u32,
    deleted_ids: Vec<String>,
    /// Kept for the `SyncSummary.failures` fold; empty in practice now that
    /// loser takedown is a local file/map cleanup (no server call to fail).
    failures: Vec<SyncFailure>,
}

/// Concurrent-move convergence: when the SAME object surfaces under two on-disk
/// filenames in one cycle (our push wrote it at one path, the pull re-listed it
/// at another), collapse to the highest-`change_seq` name and remove the
/// redundant local copies. Mirrors `resolveConcurrentMoveDuplicates` from the
/// deleted TS implementation.
///
/// S3: the losers `pick_duplicate_move_losers` returns share the winner's
/// `object_id` (it groups by object identity — F9). That object legitimately
/// survives on the server under the WINNER's filename, so a loser takedown is a
/// LOCAL cleanup only (its file + map entry). Issuing a server DELETE on the
/// loser would delete the shared object and tombstone the winner.
///
/// Rule 3: mutates the caller's owned working `state` in place (and persists).
async fn resolve_concurrent_move_duplicates(
    state: &mut ConnectedState,
    notes_root_path: &Path,
    pre_write: &PreWriteFn,
    deleted_hashes: &HashMap<String, String>,
    push_h2f: &HashMap<String, Vec<HashFilenameEntry>>,
    pull_h2f: &HashMap<String, Vec<HashFilenameEntry>>,
) -> Result<DuplicateResolution, SyncErrorKind> {
    let mut out = DuplicateResolution::default();

    for (hash, from_filename) in deleted_hashes {
        let losers = pick_duplicate_move_losers(from_filename, hash, push_h2f, pull_h2f);
        for loser in losers {
            if remove_duplicate_loser_locally(state, notes_root_path, pre_write, &loser.filename)? {
                out.conflicts += 1;
                out.deleted_ids.push(filename_to_id(&loser.filename));
            }
        }
    }
    Ok(out)
}

/// Pure candidate selection: returns the loser filenames for one
/// `(hash, from_filename)` deletion. Split out so the resolution logic
/// is unit-testable without an HTTP client.
///
/// F9: keys on OBJECT IDENTITY, not `(content-hash, basename)`. Two notes that
/// merely share content + basename (e.g. two empty `Untitled.md` in different
/// folders) are DISTINCT objects, so a same-content delete in the same cycle
/// must not collapse them — that deleted a real note on server + disk. A true
/// concurrent-move duplicate is the SAME object surfacing under two on-disk
/// names in one cycle (our push wrote it at one path, the pull re-listed it at
/// another); only within one `object_id` do we keep the highest change_seq and
/// take down the rest. The `(hash, basename)` filter is retained purely to
/// narrow the candidate set to the deleted note's move family before grouping.
fn pick_duplicate_move_losers(
    from_filename: &str,
    hash: &str,
    push_h2f: &HashMap<String, Vec<HashFilenameEntry>>,
    pull_h2f: &HashMap<String, Vec<HashFilenameEntry>>,
) -> Vec<HashFilenameEntry> {
    let from_base = filename_basename(from_filename);
    // Dedupe by filename first (the same name can appear in both push and pull
    // maps — a self-push the pull re-listed — which is one on-disk copy, not a
    // collision).
    let mut by_filename: HashMap<String, HashFilenameEntry> = HashMap::new();
    for src in [push_h2f.get(hash), pull_h2f.get(hash)].into_iter().flatten() {
        for cand in src {
            if cand.filename == from_filename {
                continue;
            }
            if filename_basename(&cand.filename) != from_base {
                continue;
            }
            by_filename.insert(cand.filename.clone(), cand.clone());
        }
    }
    // Group by object identity. Only names sharing ONE object_id are the same
    // object at two paths; distinct object_ids are distinct notes → keep all.
    let mut by_object: HashMap<String, Vec<HashFilenameEntry>> = HashMap::new();
    for entry in by_filename.into_values() {
        by_object.entry(entry.object_id.clone()).or_default().push(entry);
    }
    let mut losers: Vec<HashFilenameEntry> = Vec::new();
    for (_object_id, mut group) in by_object {
        if group.len() <= 1 {
            continue;
        }
        // Highest change_seq wins; lexicographic filename order breaks ties
        // (matches `localeCompare` close enough for ASCII paths).
        group.sort_by(|a, b| {
            b.change_seq
                .cmp(&a.change_seq)
                .then_with(|| a.filename.cmp(&b.filename))
        });
        losers.extend(group.into_iter().skip(1));
    }
    losers
}

/// Remove a duplicate-move LOSER locally: its on-disk file + its object_map
/// entry, persisting the map. Returns `true` if a copy was removed, `false` if
/// the loser had no map entry (already gone).
///
/// No server call (S3): the loser shares the winner's `object_id`, so the
/// object survives on the server under the winner's filename — a server DELETE
/// would tombstone the winner. Only the redundant SECOND local filename for the
/// one object is taken down.
///
/// Rule 3: mutates the caller's owned working `state` in place + persists.
fn remove_duplicate_loser_locally(
    state: &mut ConnectedState,
    notes_root_path: &Path,
    pre_write: &PreWriteFn,
    filename: &str,
) -> Result<bool, SyncErrorKind> {
    if !state.object_map.contains_key(filename) {
        return Ok(false);
    }

    let apply_input = V2SyncApplyInput {
        update: Vec::new(),
        delete: vec![filename.to_owned()],
        conflicts: Vec::new(),
        timestamps: HashMap::new(),
    };
    apply_delta(notes_root_path, pre_write, apply_input)?;

    state.object_map.remove(filename);
    state::persist(
        notes_root_path,
        &state.object_map,
        state.max_version,
        state.pull_cursor,
        &state.collection_id,
    )
    .map_err(SyncErrorKind::Io)?;
    Ok(true)
}

/// Detect renames by content-hash equality across the union of delete +
/// create events from both push and pull. A "rename" is any file whose
/// content was deleted on one side and re-created with the same hash on
/// the other. Mirrors the TS logic in `runFullSync` (lines 1536–1575).
fn derive_renames(
    push_deleted_hashes: &HashMap<String, String>,   // hash → from filename
    pull_deleted_hashes: &HashMap<String, String>,
    push_created_hashes: &HashMap<String, String>,   // hash → to filename
    pull_created_hashes: &HashMap<String, String>,
) -> Vec<RenamePair> {
    let mut renamed = Vec::new();
    let mut all_deleted: HashMap<&String, &String> = HashMap::new();
    for (h, f) in push_deleted_hashes {
        all_deleted.insert(h, f);
    }
    for (h, f) in pull_deleted_hashes {
        all_deleted.entry(h).or_insert(f);
    }
    for (hash, from_filename) in all_deleted {
        let to_filename = push_created_hashes
            .get(hash)
            .or_else(|| pull_created_hashes.get(hash));
        if let Some(to) = to_filename {
            if to != from_filename
                && e2ee::is_rename_match(hash, hash)
            {
                renamed.push(RenamePair {
                    from_id: filename_to_id(from_filename),
                    to_id: filename_to_id(to),
                });
            }
        }
    }
    renamed
}

fn combine_summaries(
    mut push: SyncSummary,
    pull: SyncSummary,
    renamed: Vec<RenamePair>,
    dup: DuplicateResolution,
) -> SyncSummary {
    push.downloaded += pull.downloaded;
    push.deleted += pull.deleted + dup.deleted_ids.len() as u32;
    push.conflicts += pull.conflicts + dup.conflicts;
    push.local_writes_applied += pull.local_writes_applied;
    push.failures.extend(pull.failures);
    push.failures.extend(dup.failures);
    push.updated_ids.extend(pull.updated_ids);
    push.deleted_ids.extend(pull.deleted_ids);
    push.peer_updated_ids.extend(pull.peer_updated_ids);
    push.peer_deleted_ids.extend(pull.peer_deleted_ids);
    push.renamed = renamed;

    // Renames replace a (delete + create) pair in the per-id lists so the
    // UI doesn't show ghost deletes for the renamed file's old id.
    let renamed_from: HashSet<String> =
        push.renamed.iter().map(|r| r.from_id.clone()).collect();
    let renamed_to: HashSet<String> =
        push.renamed.iter().map(|r| r.to_id.clone()).collect();
    let dup_deleted: HashSet<String> = dup.deleted_ids.iter().cloned().collect();

    // Duplicate-move losers must not appear as "updated" anywhere — we
    // just deleted them. They also must appear in deleted/peer_deleted so
    // the sidebar removes them.
    push.updated_ids
        .retain(|id| !dup_deleted.contains(id) && !renamed_to.contains(id));
    push.peer_updated_ids
        .retain(|id| !dup_deleted.contains(id) && !renamed_to.contains(id));
    push.deleted_ids
        .retain(|id| !renamed_from.contains(id) && !renamed_to.contains(id));
    push.peer_deleted_ids
        .retain(|id| !renamed_from.contains(id) && !renamed_to.contains(id));
    for id in dup.deleted_ids {
        if !push.deleted_ids.iter().any(|x| x == &id) {
            push.deleted_ids.push(id.clone());
        }
        if !push.peer_deleted_ids.iter().any(|x| x == &id) {
            push.peer_deleted_ids.push(id);
        }
    }
    push
}

/// Pre-pass that populates an empty object map from existing server data
/// without blindly re-uploading every local note. Mirrors the deleted TS
/// `reconcileEmptyMap`. Runs when (and only when) `object_map.is_empty()
/// && max_version == 0` — i.e. the very first connect, a post-disconnect
/// reconnect, or any path where `import_legacy_state` returned an empty
/// map. Without this, run_push runs first and uploads every local file
/// as a fresh blob, duplicating everything already on the server and
/// triggering a flood of conflict copies on the next pull.
///
/// Algorithm:
///   1. List every live server object (skip tombstones).
///   2. Decrypt + unpack each blob in parallel.
///   3. For each remote (filename, content):
///        - no local file → write to disk, record entry.
///        - local content matches → record entry (no content write) and
///          correct the file mtime to the server's modified_at so note
///          ordering converges across devices.
///        - local content differs → record entry WITHOUT mtime/size so
///          the next push uploads the local content as an update. We
///          trust local when we have no common ancestor for a 3-way
///          merge.
///   4. Persist the map + advance max_version.
///
/// One peer tombstone matched to the ancestry it was last synced under. The
/// read/hash/decide/act happens together in `apply_tombstone_reconcile` so the
/// file is never deleted on a stale hash (S1 TOCTOU).
struct TombstoneTarget {
    filename: String,
    object_id: String,
    /// The content hash this device last synced for this object. The local file
    /// is deleted only if it STILL hashes to this; otherwise it diverged and is
    /// parked.
    expected_hash: String,
    change_seq: u64,
}

/// A tombstone whose local effect could not be verified (transient read/remove
/// error). Recorded as a failure; its `change_seq` caps the cursor and blocks
/// ancestry consumption so the next cycle retries (S2/S5).
struct FailedTombstone {
    filename: String,
    change_seq: u64,
}

struct TombstoneApplyResult {
    /// Filenames actually removed from disk (unchanged deletes + parked
    /// originals). Surfaced as `deleted`/`deletedIds` so the rescan gate fires.
    deleted: Vec<String>,
    failed: Vec<FailedTombstone>,
    /// Count of diverged-tombstone conflict copies written to local disk. Folds
    /// into `SyncSummary::local_writes_applied` so the field stays a true count
    /// of local writes (F2) — a parked copy is a new on-disk file the shells
    /// must reload for, even though it always rides alongside a `deleted`.
    parked: u32,
}

/// Tombstone-claim dotfile prefix. A claim is the note's ONLY on-disk copy
/// during the (synchronous, no-persist) window between the claim `rename` and
/// its cleanup, so the recovery sweep must be able to recover the note's
/// ORIGINAL relative path from whatever was left behind by a crash inside that
/// window (P1-1). Claims live at the notes root (single-readdir sweep) and are
/// dotfiles (ignored by scans/sync).
///
/// Two encodings, because a claim name must stay under NAME_MAX (255 bytes on
/// every shipping filesystem) while a legal note path can be far longer (a
/// 200-char title alone hex-encodes to 400+ bytes):
///   • **hex (self-describing)** — `.sf-tomb-<hex(rel)>`: lowercase hex of the
///     UTF-8 bytes of the relative path. Used whenever it fits comfortably under
///     NAME_MAX (the common short-name case); no sidecar, one atomic rename, and
///     the path is readable straight off disk.
///   • **hashed (overflow) + sidecar** — `.sf-tomb-h<sha>` (fixed 42 bytes) plus
///     an atomic sidecar `.sf-tomb-h<sha>.path` whose CONTENT is the original
///     relative path. The `h` marker can never collide with the hex form (hex
///     payloads are `0-9a-f`, never start with `h`).
const CLAIM_PREFIX: &str = ".sf-tomb-";
/// Marks the hashed (overflow) claim form `.sf-tomb-h<sha>`.
const CLAIM_HASH_MARKER: &str = "h";
/// Suffix of the hashed form's sidecar file (holds the original path as content).
const CLAIM_SIDECAR_SUFFIX: &str = ".path";
/// Upper bound for a claim dotfile name, kept well under the universal
/// NAME_MAX of 255 bytes. The self-describing hex form is used only while it
/// fits this bound; longer paths take the fixed-size hashed form + sidecar.
const MAX_CLAIM_NAME_BYTES: usize = 200;

/// Self-describing hex claim name for `rel`.
fn claim_hex(rel: &str) -> String {
    let mut s = String::with_capacity(CLAIM_PREFIX.len() + rel.len() * 2);
    s.push_str(CLAIM_PREFIX);
    for b in rel.as_bytes() {
        s.push(char::from_digit((b >> 4) as u32, 16).unwrap());
        s.push(char::from_digit((b & 0x0f) as u32, 16).unwrap());
    }
    s
}

/// The claim name for `rel`, plus a sidecar name when the path is too long to
/// encode in the name itself (see [`CLAIM_PREFIX`]). `Some(sidecar)` means the
/// hashed form is in use and the sidecar MUST be written (holding `rel`) before
/// the claim rename, so a crash never leaves a claim whose path is unrecoverable.
fn claim_names_for(rel: &str) -> (String, Option<String>) {
    let hex = claim_hex(rel);
    if hex.len() <= MAX_CLAIM_NAME_BYTES {
        (hex, None)
    } else {
        // 32 hex chars = 128 bits of sha256: collision-free for the handful of
        // concurrent tombstones. The sidecar content is the authoritative path.
        let digest = &hash_sha256(rel)[..32];
        let claim = format!("{CLAIM_PREFIX}{CLAIM_HASH_MARKER}{digest}");
        let sidecar = format!("{claim}{CLAIM_SIDECAR_SUFFIX}");
        (claim, Some(sidecar))
    }
}

/// Recover the original relative filename encoded IN a hex claim name, or `None`
/// when `name` is not a well-formed hex claim (the hashed form, a sidecar, or a
/// foreign dotfile). The hashed form is decoded from its sidecar, not here.
fn claim_decode(name: &str) -> Option<String> {
    let hex = name.strip_prefix(CLAIM_PREFIX)?;
    if hex.is_empty() || hex.len() % 2 != 0 {
        return None;
    }
    let bytes = hex.as_bytes();
    let mut out = Vec::with_capacity(hex.len() / 2);
    let mut i = 0;
    while i < bytes.len() {
        let hi = (bytes[i] as char).to_digit(16)?;
        let lo = (bytes[i + 1] as char).to_digit(16)?;
        out.push((hi * 16 + lo) as u8);
        i += 2;
    }
    String::from_utf8(out).ok()
}

/// Recovery sweep (P1-1). Restore every STALE tombstone claim left on disk by a
/// crash inside `apply_tombstone_reconcile`. A claim only ever exists between
/// the claim `rename` and its cleanup, both of which complete INSIDE
/// `apply_tombstone_reconcile` — synchronously, with no persist between them —
/// BEFORE the caller advances the cursor / consumes ancestry (see the ordering
/// note on `reconcile_empty_map`). So a claim surviving to the next run implies
/// the prior run crashed BEFORE that persist: its tombstone was NOT consumed and
/// WILL re-list. Restoring unconditionally is therefore safe — it can never
/// resurrect a consumed tombstone. Restore to the original name unless that name
/// already exists (a re-created / re-synced file wins → drop the stale claim).
/// A failed restore LEAVES the claim for the next sweep — never delete the only
/// copy (item 2 invariant).
///
/// Fail-safe rules for the hashed (overflow) form:
///   • a hashed claim with NO sidecar → its original path is unrecoverable, so
///     LEAVE it (the bytes survive as a dotfile; never delete or misplace it);
///   • a sidecar with NO claim → harmless leftover (the claim was already
///     consumed or never renamed) → delete it.
///
/// Finding 2 (close-out, ACCEPTED not fixed): if BOTH the claim rename-back and
/// its retention somehow fail — a double filesystem failure — a claim can be
/// stranded on disk after the cursor already advanced past change_seq 0, so it
/// is only re-examined on the next FULL empty-map reconcile rather than the next
/// incremental cycle. This is fail-safe: the note's bytes persist verbatim as
/// the claim dotfile and are recovered by that later sweep; nothing is lost.
fn recover_stale_claims(notes_root: &Path, pre_write: &PreWriteFn) {
    let Ok(entries) = std::fs::read_dir(notes_root) else {
        return;
    };
    // Collect first so we don't mutate the directory while iterating it.
    let all: Vec<String> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            name.starts_with(CLAIM_PREFIX).then_some(name)
        })
        .collect();
    let claims: Vec<&String> =
        all.iter().filter(|n| !n.ends_with(CLAIM_SIDECAR_SUFFIX)).collect();
    let sidecars: HashSet<&str> = all
        .iter()
        .filter(|n| n.ends_with(CLAIM_SIDECAR_SUFFIX))
        .map(String::as_str)
        .collect();

    for name in &claims {
        // Resolve the original path (+ optional sidecar) for this claim.
        let (rel, sidecar_path) = if let Some(rel) = claim_decode(name) {
            // Self-describing hex form — no sidecar.
            (rel, None)
        } else {
            // Hashed form: the path lives in the sidecar. No/unreadable sidecar
            // ⇒ unrecoverable ⇒ LEAVE the claim untouched.
            let sc_name = format!("{name}{CLAIM_SIDECAR_SUFFIX}");
            if !sidecars.contains(sc_name.as_str()) {
                continue;
            }
            let sc_path = notes_root.join(&sc_name);
            match std::fs::read_to_string(&sc_path) {
                Ok(rel) => (rel, Some(sc_path)),
                Err(_) => continue,
            }
        };
        let Ok(orig) = safe_relative_sync_path(notes_root, &rel) else {
            continue;
        };
        pre_write(&rel);
        restore_or_discard_claim(&notes_root.join(name), &orig, sidecar_path.as_deref());
    }

    // Delete orphan sidecars (a sidecar whose claim is gone — already consumed,
    // or the claim rename never happened). Harmless leftover; safe to remove.
    for sc in &sidecars {
        let claim_name = sc.strip_suffix(CLAIM_SIDECAR_SUFFIX).unwrap_or(sc);
        if !claims.iter().any(|c| c.as_str() == claim_name) {
            let _ = std::fs::remove_file(notes_root.join(sc));
        }
    }
}

/// Put a claimed tombstone file back at its original path, or discard it ONLY
/// when a replacement is POSITIVELY confirmed (a concurrent save re-created the
/// note — newer content wins). Best-effort recovery for the near-impossible
/// case where the claim succeeded but a follow-up read/write/remove failed.
///
/// INVARIANT (item 2): a claim may be deleted ONLY when the tombstone outcome
/// deliberately consumed it (hash match → discarded after the delete is
/// recorded; diverged → discarded after the edit is parked) OR a replacement is
/// positively confirmed here. On the no-replacement path we NEVER delete the
/// claim — if the restore `rename` fails we leave it, and `recover_stale_claims`
/// recovers it next cycle. `symlink_metadata(Ok)` is the confirmation:
/// `Path::exists()` maps metadata errors (e.g. EACCES on the parent) to `false`
/// and could drop the note's only copy.
///
/// `sidecar` is the hashed form's `.path` companion (if any). It is removed
/// alongside the claim on the confirmed-drop path, and after a SUCCESSFUL
/// restore. On a failed restore both the claim AND its sidecar are left in place
/// so the next sweep can still recover the original path.
fn restore_or_discard_claim(claim: &Path, orig: &Path, sidecar: Option<&Path>) {
    if std::fs::symlink_metadata(orig).is_ok() {
        // Replacement positively confirmed → recreated file wins; drop claim.
        let _ = std::fs::remove_file(claim);
        if let Some(sc) = sidecar {
            let _ = std::fs::remove_file(sc);
        }
    } else {
        // No confirmed replacement: restore. A failed restore LEAVES the claim
        // (and its sidecar) for the sweep — never delete the only copy.
        if let Some(dir) = orig.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if std::fs::rename(claim, orig).is_ok() {
            if let Some(sc) = sidecar {
                let _ = std::fs::remove_file(sc);
            }
        }
    }
}

/// Claim-and-delete-or-park each peer tombstone (S1/S2/S5 + P1-a/P1-b). For each
/// target, CLAIM the file first — atomically `rename` it to a dotfile-prefixed
/// sibling — then hash the CLAIMED bytes and act on the claim:
///   • current hash == expected → the peer's delete wins; discard the claim;
///   • diverged (edited since last sync) → park the CLAIMED bytes in a
///     deterministic conflict copy keyed on the tombstoned object_id, then
///     discard the claim (the tombstoned name stays gone);
///   • `rename` returns `NotFound` → the file is already gone; the delete is
///     satisfied; no-op (this is the ONLY convergence signal — a permission /
///     metadata error is NOT "gone", P1-b);
///   • any other error → recorded as a failure (NOT deleted, does not advance
///     the cursor, retains ancestry, S2/S5).
///
/// Claiming first closes the race a bare read→hash→remove left open (P1-a): a
/// concurrent editor save that lands AFTER the claim recreates the note at the
/// original path and survives untouched (the editor's newer content wins),
/// while the frozen claimed bytes are what we compare and either delete or park.
/// The claim is a dotfile in the same directory (same filesystem → atomic
/// rename; scans/sync ignore dotfiles) and is cleaned up on every exit path.
/// Synchronous like `apply_delta`; `pre_write` records watcher suppression.
fn apply_tombstone_reconcile(
    notes_root: &Path,
    pre_write: &PreWriteFn,
    targets: &[TombstoneTarget],
) -> TombstoneApplyResult {
    // Recover any claim orphaned by a crash in a PRIOR run before doing new
    // work (P1-1) — safe because a surviving claim means that run never
    // persisted its cursor/ancestry (see `recover_stale_claims`).
    recover_stale_claims(notes_root, pre_write);

    let mut deleted: Vec<String> = Vec::new();
    let mut failed: Vec<FailedTombstone> = Vec::new();
    let mut parked: u32 = 0;
    let fail = |t: &TombstoneTarget| FailedTombstone {
        filename: t.filename.clone(),
        change_seq: t.change_seq,
    };
    for t in targets {
        let path = match safe_relative_sync_path(notes_root, &t.filename) {
            Ok(p) => p,
            // An unsafe/relative name should never reach here (ancestry names
            // came from a local scan); treat as unverifiable rather than delete.
            Err(_) => {
                failed.push(fail(t));
                continue;
            }
        };
        // Claim: a dotfile at the notes ROOT so a single-readdir sweep finds it
        // after a crash (P1-1). The name encodes the path directly (hex) when
        // short, else a fixed-size hashed name + a sidecar holding the path —
        // either way BOUNDED under NAME_MAX (an unbounded hex name overflowed
        // ENAMETOOLONG for long titles/deep paths, failing the claim and
        // re-opening F1 resurrection). Same filesystem as the target → the
        // rename is atomic; scans/sync ignore dotfiles.
        let (claim_name, sidecar_name) = claim_names_for(&t.filename);
        let claim_path = notes_root.join(&claim_name);
        let sidecar_path = sidecar_name.as_ref().map(|n| notes_root.join(n));

        // The sidecar (overflow form) MUST exist BEFORE the claim rename so a
        // crash between them leaves a harmless sidecar-without-claim, never a
        // claim whose original path can't be recovered.
        if let Some(sc) = &sidecar_path {
            if write_atomic_text(sc, &t.filename).is_err() {
                // Couldn't record the path → don't claim; leave the note in place.
                failed.push(fail(t));
                continue;
            }
        }

        // Suppress the watcher for the original's disappearance, then CLAIM it.
        pre_write(&t.filename);
        match std::fs::rename(&path, &claim_path) {
            Ok(()) => {}
            // ONLY NotFound is convergence: the peer's delete is already
            // satisfied. A permission/metadata error is NOT "gone" (P1-b).
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // The note is gone; the sidecar we just wrote is now an orphan.
                if let Some(sc) = &sidecar_path {
                    let _ = std::fs::remove_file(sc);
                }
                continue;
            }
            Err(_) => {
                if let Some(sc) = &sidecar_path {
                    let _ = std::fs::remove_file(sc);
                }
                failed.push(fail(t));
                continue;
            }
        }

        let is_blob = is_image_filename(&t.filename);
        let read = if is_blob {
            read_blob_as_base64(&claim_path)
        } else {
            std::fs::read_to_string(&claim_path).map_err(|e| e.to_string())
        };
        let content = match read {
            Ok(c) => c,
            // Near-impossible right after a successful rename. Put the bytes back
            // (unless a concurrent save reclaimed the path) and retry next cycle.
            Err(_) => {
                restore_or_discard_claim(&claim_path, &path, sidecar_path.as_deref());
                failed.push(fail(t));
                continue;
            }
        };

        if hash_sha256(&content) == t.expected_hash {
            // Unchanged since last sync → peer delete wins; consume the claim
            // (+ its sidecar). If the claim can't be removed, the delete is NOT
            // done (the claim still holds the note's only bytes): a FAILED
            // tombstone — no deleted-report, no cursor advance, ancestry retained
            // (item 3). Restore so the note isn't stranded; a failed restore
            // leaves it for the sweep.
            if std::fs::remove_file(&claim_path).is_err() {
                restore_or_discard_claim(&claim_path, &path, sidecar_path.as_deref());
                failed.push(fail(t));
                continue;
            }
            if let Some(sc) = &sidecar_path {
                let _ = std::fs::remove_file(sc);
            }
            prune_empty_parent_dirs(notes_root, &path);
            deleted.push(t.filename.clone());
        } else {
            // Diverged → park the CLAIMED bytes as the conflict copy, then
            // discard the claim.
            let copy = collision_conflict_filename(&t.filename, &t.object_id);
            let copy_path = match safe_relative_sync_path(notes_root, &copy) {
                Ok(p) => p,
                Err(_) => {
                    restore_or_discard_claim(&claim_path, &path, sidecar_path.as_deref());
                    failed.push(fail(t));
                    continue;
                }
            };
            pre_write(&copy);
            let write_res = if is_blob {
                write_base64_as_blob(&copy_path, &content)
            } else {
                write_atomic_text(&copy_path, &content)
            };
            if write_res.is_err() {
                // Couldn't preserve the edit — restore rather than lose it.
                restore_or_discard_claim(&claim_path, &path, sidecar_path.as_deref());
                failed.push(fail(t));
                continue;
            }
            // The conflict copy is now on disk — count it as a local write
            // IMMEDIATELY (F2), before the claim cleanup below. If that cleanup
            // fails this target still becomes a FAILED tombstone (restore +
            // retry), but the copy file already exists, so the reload signal
            // MUST fire or the new copy stays invisible until a later sync.
            parked += 1;
            // Edit preserved in the conflict copy. Consuming the claim drops the
            // tombstoned name; if that removal fails the claim still holds the
            // only copy of the original bytes → FAILED tombstone (item 3, same
            // rule as the matched path). Restore + retry; the next cycle re-parks
            // to the same deterministic conflict name idempotently.
            if std::fs::remove_file(&claim_path).is_err() {
                restore_or_discard_claim(&claim_path, &path, sidecar_path.as_deref());
                failed.push(fail(t));
                continue;
            }
            if let Some(sc) = &sidecar_path {
                let _ = std::fs::remove_file(sc);
            }
            prune_empty_parent_dirs(notes_root, &path);
            deleted.push(t.filename.clone());
        }
    }
    TombstoneApplyResult { deleted, failed, parked }
}

/// Rule 3: takes `&ConnectedState`, mutates a clone, persists, returns the
/// new state alongside the count.
async fn reconcile_empty_map(
    state_cell: &ConnectedState,
    notes_root_path: &Path,
    progress: &ProgFn,
    pre_write: &PreWriteFn,
) -> Result<(SyncSummary, ConnectedState), SyncErrorKind> {
    let http = Arc::new(build_client(state_cell)?);
    let vault_key = Arc::new(state_cell.vault_key);

    let server_objects = http
        .list_objects(&state_cell.collection_id, 0)
        .await
        .map_err(SyncErrorKind::collection_http)?;

    // Split the listing: live objects carry a blob to reconcile; tombstones
    // (deleted) carry only an object id, which the F1 pass below matches back to
    // an ancestry entry so a peer delete made while this device was disconnected
    // is honored instead of re-POSTed (resurrected fleet-wide).
    let mut live: Vec<ServerObject> = Vec::new();
    let mut tombstones: Vec<ServerObject> = Vec::new();
    for o in server_objects {
        if o.deleted {
            tombstones.push(o);
        } else if o.blob_key.is_some() {
            live.push(o);
        }
        // A non-deleted object with no blob_key is skipped, as before.
    }
    if live.is_empty() && tombstones.is_empty() {
        return Ok((SyncSummary::default(), state_cell.clone()));
    }

    // Ancestry left behind by a disconnect / collection reset: filename →
    // last-synced {objectId, hash}. Lets the diverged branch below separate
    // "drifted while this device was disconnected, never edited here" and
    // "edited here against an unchanged remote" from true divergence, so
    // neither mints a `(conflict <oid8>)` copy. Advisory: absent or stale
    // entries just fall through to the conservative park.
    let ancestry = state::load_ancestry(notes_root_path);

    // Index local files by name so we can compare without re-walking
    // disk per object. list_notes_with_meta already filters to
    // `.md` and skips dotfile dirs.
    let root_for_walk = notes_root_path.to_path_buf();
    let local_files = tokio::task::spawn_blocking(move || list_notes_with_meta(&root_for_walk))
        .await
        .map_err(task_join_err)?;
    let local_by_name: HashMap<String, (i64, u64)> = local_files
        .iter()
        .filter(|f| f.name.ends_with(".md") || is_image_filename(&f.name))
        .map(|f| (f.name.clone(), (f.mtime_ms, f.size_bytes)))
        .collect();
    let ancestry_by_object_id: HashMap<String, (String, state::AncestryEntry)> = ancestry
        .iter()
        .filter(|(filename, _)| local_by_name.contains_key(filename.as_str()))
        .map(|(filename, entry)| (entry.object_id.clone(), (filename.clone(), entry.clone())))
        .collect();

    // Batched download stage — same machinery as run_pull. The object map is
    // empty here, so failures carry no filename (none is known pre-decrypt).
    let total = live.len();
    let progress_emitter = ProgressEmitter::new(progress, "reconciling", total);
    let no_names: HashMap<String, String> = HashMap::new();
    let (downloaded, failed_downloads) = download_all(
        http.clone(),
        vault_key.clone(),
        live,
        &no_names,
        &progress_emitter,
    )
    .await;

    // The cursor must advance past objects we ignore/reject too (they were
    // fetched successfully, just not materialized) so the next reconcile does
    // not re-list them. Captured BEFORE triage drops them from `downloaded`.
    let fetched_max_seq = downloaded.iter().map(|n| n.change_seq).max().unwrap_or(0);
    // Screen the download set through the SAME choke point `run_pull` uses,
    // fusing classification and collision planning (B1/B4): legacy/foreign
    // blobs drop out (never written as notes, never phantom-mapped, never
    // counted), creatable-but-unsyncable names heal, and structurally unsafe
    // names become recorded failures — all without aborting this fresh-device
    // first sync. Collisions are then planned over the surviving download set:
    // two distinct server objects can carry names that collide on a case/
    // normalization-insensitive FS (same name from two clients; NFC vs NFD),
    // which would otherwise BOTH adopt the same on-disk path and clobber one
    // note. The map is empty here, so only download_overrides can be produced.
    let ScreenedDownloads {
        kept: downloaded,
        path_failures,
        collision_plan,
    } = screen_incoming(downloaded, &state_cell.object_map, &HashSet::new());

    // For each remote note: compare to local (if any) and decide
    // whether to write, skip, or omit mtime/size to flag divergence.
    let mut updates: Vec<V2IncomingUpdate> = Vec::new();
    let mut timestamps: HashMap<String, i64> = HashMap::new();
    let mut deletes: Vec<String> = Vec::new();
    let mut upserts: Vec<(String, E2eeObjectMapEntry)> = Vec::new();
    // Filenames adopted from the server (written to disk) — these are
    // genuine peer-driven downloads and must be surfaced in the summary so
    // the TS rescan gate fires and the `downloaded` count is honest.
    let mut adopted: Vec<String> = Vec::new();
    let mut new_max_version: u64 = 0;
    for (idx, note) in downloaded.iter().enumerate() {
        if note.change_seq > new_max_version {
            new_max_version = note.change_seq;
        }
        // Identical-content collision loser: the winner writes these exact bytes
        // at the canonical name — skip it (no write, no map upsert, no adopt).
        if collision_plan.download_skips.contains(&idx) {
            continue;
        }
        // The on-disk name this object lands at: its conflict copy if it lost a
        // collision, else its canonical name.
        let target_name = collision_plan
            .download_overrides
            .get(&idx)
            .cloned()
            .unwrap_or_else(|| note.filename.clone());
        let remote_size = note.content.as_bytes().len() as u64;
        let entry_common = |mtime: Option<i64>, size: Option<u64>| E2eeObjectMapEntry {
            object_id: note.object_id.clone(),
            version: note.version,
            blob_key: note.blob_key.clone(),
            hash: Some(note.hash.clone()),
            mtime_ms: mtime,
            size_bytes: size,
        };

        match local_by_name.get(&target_name) {
            None => {
                if let Some((previous_name, anc)) = ancestry_by_object_id.get(&note.object_id) {
                    if previous_name != &target_name {
                        if let Ok(content) = read_local_note(notes_root_path, previous_name).await {
                            let local_hash = hash_sha256(&content);
                            if anc.hash == local_hash {
                                // The object moved while this device was
                                // disconnected, and the old local path is
                                // still exactly what this device last synced.
                                // Adopt the remote at its new path and delete
                                // the stale old path so it cannot be POSTed as
                                // a duplicate on the push phase.
                                deletes.push(previous_name.clone());
                                updates.push(V2IncomingUpdate {
                                    filename: target_name.clone(),
                                    content: note.content.clone(),
                                    hash: note.hash.clone(),
                                    modified_at: note.modified_at_ms,
                                });
                                upserts.push((
                                    target_name.clone(),
                                    entry_common(Some(note.modified_at_ms), Some(remote_size)),
                                ));
                                adopted.push(target_name.clone());
                                continue;
                            }
                            if anc.hash == note.hash {
                                // The peer renamed the object without changing
                                // its content; this device edited the old path
                                // while disconnected. Move the local edit to
                                // the peer's new path and map it to the same
                                // object with no fast-path fields so the next
                                // push updates that object instead of minting a
                                // duplicate.
                                deletes.push(previous_name.clone());
                                updates.push(V2IncomingUpdate {
                                    filename: target_name.clone(),
                                    content,
                                    hash: local_hash,
                                    modified_at: 0,
                                });
                                upserts.push((target_name.clone(), entry_common(None, None)));
                                adopted.push(target_name.clone());
                                continue;
                            }

                            // Both sides changed: keep the remote at its new
                            // path, preserve the local edit as a conflict copy,
                            // and remove the stale old path so it cannot upload
                            // as an unrelated new object.
                            let copy_name =
                                collision_conflict_filename(&target_name, &note.object_id);
                            deletes.push(previous_name.clone());
                            updates.push(V2IncomingUpdate {
                                filename: copy_name,
                                content,
                                hash: local_hash,
                                modified_at: 0,
                            });
                            updates.push(V2IncomingUpdate {
                                filename: target_name.clone(),
                                content: note.content.clone(),
                                hash: note.hash.clone(),
                                modified_at: note.modified_at_ms,
                            });
                            upserts.push((
                                target_name.clone(),
                                entry_common(Some(note.modified_at_ms), Some(remote_size)),
                            ));
                            adopted.push(target_name.clone());
                            continue;
                        }
                    }
                }
                // No local file → adopt the remote at its (collision-resolved)
                // target name.
                updates.push(V2IncomingUpdate {
                    filename: target_name.clone(),
                    content: note.content.clone(),
                    hash: note.hash.clone(),
                    modified_at: note.modified_at_ms,
                });
                upserts.push((
                    target_name.clone(),
                    entry_common(Some(note.modified_at_ms), Some(remote_size)),
                ));
                adopted.push(target_name.clone());
            }
            Some(_) => {
                // Local file present — read its content (base64 for an image
                // blob) to compare its hash against the remote's.
                let path = notes_root_path.join(&target_name);
                let is_blob = is_image_filename(&target_name);
                let local_content = tokio::task::spawn_blocking(move || {
                    if is_blob {
                        read_blob_as_base64(&path).ok()
                    } else {
                        std::fs::read_to_string(&path).ok()
                    }
                })
                .await
                .map_err(task_join_err)?;
                match local_content {
                    Some(content) if hash_sha256(&content) == note.hash => {
                        // Identical content — stamp the map so push fast-paths
                        // past this file forever, and converge the on-disk
                        // mtime to the server-authoritative modified_at so
                        // note ordering matches every other device (the
                        // local mtime is a pre-relink artifact, not an edit).
                        upserts.push((
                            target_name.clone(),
                            entry_common(Some(note.modified_at_ms), Some(remote_size)),
                        ));
                        timestamps.insert(target_name.clone(), note.modified_at_ms);
                    }
                    Some(content) => {
                        let local_hash = hash_sha256(&content);
                        // Ancestry (written on disconnect / collection reset)
                        // can prove the divergence is one-sided for THIS
                        // object; a one-sided change is a fast-forward, not a
                        // conflict. Without it, a device that reconnected
                        // after fleet drift parked a conflict copy of every
                        // note it never touched (July 2026 incident).
                        let anc = ancestry
                            .get(&target_name)
                            .filter(|a| a.object_id == note.object_id);
                        if let Some(anc) = anc {
                            if anc.hash == local_hash {
                                // Local is bit-for-bit what this device last
                                // synced for this object; only the remote
                                // moved. Fast-forward: adopt the remote, no
                                // conflict copy.
                                updates.push(V2IncomingUpdate {
                                    filename: target_name.clone(),
                                    content: note.content.clone(),
                                    hash: note.hash.clone(),
                                    modified_at: note.modified_at_ms,
                                });
                                upserts.push((
                                    target_name.clone(),
                                    entry_common(
                                        Some(note.modified_at_ms),
                                        Some(remote_size),
                                    ),
                                ));
                                adopted.push(target_name.clone());
                                continue;
                            }
                            if anc.hash == note.hash {
                                // The remote is still exactly what this device
                                // last synced; only local was edited (while
                                // disconnected). Keep local and record a
                                // divergence entry (no mtime/size) so the next
                                // push uploads it as an UPDATE to this same
                                // object — safe because the remote content IS
                                // the common ancestor.
                                upserts.push((target_name.clone(), entry_common(None, None)));
                                continue;
                            }
                        }
                        // F6: local diverges from an UNSEEN remote (empty map).
                        // The old code recorded the entry with no mtime/size so
                        // the next push would re-upload LOCAL as an update —
                        // silently clobbering the remote we never reconciled
                        // against (no common ancestor ⇒ no safe 3-way merge).
                        // Instead, adopt the remote on the canonical name AND
                        // park the local edits in a deterministic conflict copy
                        // so NEITHER side is lost. The conflict name is derived
                        // from the REMOTE object_id (every client sees the same
                        // remote object, so all clients mint the identical copy
                        // name and converge — see collision_conflict_filename).
                        let copy_name = collision_conflict_filename(
                            &target_name,
                            &note.object_id,
                        );
                        // Write the local edits to the conflict copy.
                        updates.push(V2IncomingUpdate {
                            filename: copy_name.clone(),
                            content,
                            hash: local_hash,
                            // 0 ⇒ keep the filesystem mtime for the copy.
                            modified_at: 0,
                        });
                        // Adopt the remote content on the canonical name.
                        updates.push(V2IncomingUpdate {
                            filename: target_name.clone(),
                            content: note.content.clone(),
                            hash: note.hash.clone(),
                            modified_at: note.modified_at_ms,
                        });
                        // Map: canonical name → remote object (fast-path
                        // primed); conflict copy gets no map entry, so the next
                        // push uploads it as its OWN new object (it has no
                        // server identity yet — the local edits are net-new).
                        upserts.push((
                            target_name.clone(),
                            entry_common(Some(note.modified_at_ms), Some(remote_size)),
                        ));
                        adopted.push(target_name.clone());
                    }
                    None => {
                        // Local file disappeared between the dir scan and
                        // the read (deleted concurrently). Treat as "no
                        // local" and adopt the remote at its target name.
                        updates.push(V2IncomingUpdate {
                            filename: target_name.clone(),
                            content: note.content.clone(),
                            hash: note.hash.clone(),
                            modified_at: note.modified_at_ms,
                        });
                        upserts.push((
                            target_name.clone(),
                            entry_common(Some(note.modified_at_ms), Some(remote_size)),
                        ));
                        adopted.push(target_name.clone());
                    }
                }
            }
        }
    }

    // F1: honor peer tombstones. A server object deleted while this device was
    // disconnected never appears in `live`, so the loop above leaves its local
    // file untouched — and run_push then re-POSTs it as a brand-new object,
    // resurrecting the note on every device permanently. Collect one target per
    // tombstone we can match to the ancestry it was last synced under (object_id
    // → filename + last-synced hash). No I/O here and NO cursor advance yet: the
    // read/hash/decide/act happens together in `apply_tombstone_reconcile` below
    // (closing the TOCTOU window), and only a VERIFIED effect may advance the
    // cursor / consume ancestry (S1/S2/S5).
    //
    // A name a live object is adopting this cycle is skipped — the adopt (and
    // its own F6 divergence handling) owns that file; the delete-before-write
    // apply order would otherwise fight it.
    let adopted_set: HashSet<&String> = adopted.iter().collect();
    let mut tombstone_targets: Vec<TombstoneTarget> = Vec::new();
    for tomb in &tombstones {
        let Some((filename, anc)) = ancestry_by_object_id.get(&tomb.id) else {
            continue;
        };
        if adopted_set.contains(filename) {
            continue;
        }
        tombstone_targets.push(TombstoneTarget {
            filename: filename.clone(),
            object_id: tomb.id.clone(),
            expected_hash: anc.hash.clone(),
            change_seq: tomb.change_seq,
        });
    }

    // Apply file writes for remote-only adoptions — plus mtime corrections
    // for identical-content matches — via the shared apply path so watcher
    // suppressions are recorded.
    if !updates.is_empty() || !timestamps.is_empty() || !deletes.is_empty() {
        let apply_input = V2SyncApplyInput {
            update: updates,
            delete: deletes,
            conflicts: Vec::new(),
            timestamps,
        };
        apply_delta(notes_root_path, pre_write, apply_input)?;
    }

    // Compare-and-delete-or-park each tombstone target (S1 TOCTOU: re-read +
    // hash immediately before acting). Deletes that could not be VERIFIED
    // (transient read/remove error) are returned as failures — they must not
    // advance the cursor or consume ancestry (S2/S5).
    let tomb_result = apply_tombstone_reconcile(notes_root_path, pre_write, &tombstone_targets);
    let parked_writes = tomb_result.parked;
    let peer_deleted = tomb_result.deleted;

    // Populate the map and advance max_version, then persist. Issue #11:
    // capped below the lowest failed change_seq — reconcile's max is computed
    // from SUCCESSFUL downloads only, but a failed object whose change_seq
    // sits below a succeeded one would still be jumped without the cap (and
    // then never re-listed, i.e. never land on this device). The `.max()`
    // merge is safe here ONLY because run_sync gates this path on
    // `max_version == 0` — with a nonzero incoming cursor it would defeat
    // the cap exactly like the pre-fix run_pull persist did.
    let mut next = state_cell.clone();
    for (filename, entry) in upserts {
        next.object_map.insert(filename, entry);
    }
    // A VERIFIED tombstone effect (deleted/parked, or the file was already
    // gone) may advance the cursor; a FAILED one must not — and it caps the
    // cursor below its change_seq so the next cycle re-lists it (cap_cursor
    // idiom, S5). Successful tombstone change_seqs are folded into new_max_version;
    // failed ones become synthetic cap entries alongside the failed downloads.
    let failed_tombstone_seqs: HashSet<u64> =
        tomb_result.failed.iter().map(|f| f.change_seq).collect();
    for t in &tombstone_targets {
        if !failed_tombstone_seqs.contains(&t.change_seq) && t.change_seq > new_max_version {
            new_max_version = t.change_seq;
        }
    }
    // Advance past ignored/rejected (successfully-fetched but not materialized)
    // objects so they are not re-listed next reconcile. Genuinely-failed
    // downloads are still handled by the cap below.
    new_max_version = new_max_version.max(fetched_max_seq);
    // Cap below the lowest failed change_seq of EITHER a failed download or a
    // failed tombstone (same rule as `cap_cursor`, extended to tombstones).
    let capped = match failed_downloads
        .iter()
        .map(|f| f.change_seq)
        .chain(tomb_result.failed.iter().map(|f| f.change_seq))
        .min()
    {
        Some(lowest) => new_max_version.min(lowest.saturating_sub(1)),
        None => new_max_version,
    };
    next.max_version = next.max_version.max(capped);
    // The empty-map reconcile is a completed pull over the whole collection, so
    // the pull cursor advances with it (F32).
    next.pull_cursor = next.max_version;
    state::persist(
        notes_root_path,
        &next.object_map,
        next.max_version,
        next.pull_cursor,
        &next.collection_id,
    )
    .map_err(SyncErrorKind::Io)?;

    // Consume the ancestry only when EVERY tombstone was verified — a leftover
    // failed tombstone must keep its ancestry entry for a retry (S5). Retention
    // is coarse (whole file) but safe: ancestry is advisory and only ever
    // changes a fast-forward decision when object_id AND hash both still match,
    // and consumed entries whose files are now gone are ignored next time.
    if tomb_result.failed.is_empty() {
        if let Err(e) = state::delete_ancestry_file(notes_root_path) {
            eprintln!("[e2ee] reconcile: failed to delete consumed ancestry file: {e}");
        }
    }

    // Surface adoptions as real downloads AND tombstone deletes as real
    // deletes. Without this the empty-map reconcile path mutates disk but
    // contributes nothing to the SyncSummary, so the TS rescan gate
    // (`hasPeerNoteChanges`) never fires and the sidebar misses the change.
    let adopted_ids: Vec<String> = adopted.iter().map(|f| filename_to_id(f)).collect();
    let peer_deleted_ids: Vec<String> = peer_deleted.iter().map(|f| filename_to_id(f)).collect();
    let mut failures: Vec<SyncFailure> =
        failed_downloads.into_iter().map(|f| f.failure).collect();
    // Incoming names we refused to write (structurally unsafe) — surfaced,
    // never cursor-capped, never abort this first sync (B1).
    failures.extend(path_failures);
    // Unverified tombstone effects are real per-item failures (S2): they drive
    // the UI failure indicator and keep the cycle honest about not-yet-done work.
    for f in tomb_result.failed {
        failures.push(SyncFailure {
            filename: f.filename,
            kind: FailureKind::Delete,
            status_code: None,
        });
    }
    let summary = SyncSummary {
        downloaded: adopted.len() as u32,
        deleted: peer_deleted.len() as u32,
        updated_ids: adopted_ids.clone(),
        peer_updated_ids: adopted_ids,
        deleted_ids: peer_deleted_ids.clone(),
        peer_deleted_ids,
        // Adopted notes + diverged-tombstone conflict copies were all written
        // to local disk (F2).
        local_writes_applied: adopted.len() as u32 + parked_writes,
        failures,
        ..Default::default()
    };
    Ok((summary, next))
}

/// Run one full sync cycle: reconcile-if-empty → push → pull(since =
/// pre_push_max captured BEFORE push) → resolve_concurrent_move_duplicates
/// → derive_renames → combine_summaries.
///
/// Relocated verbatim from the desktop's `e2ee_sync_run` body (Rule 3:
/// threads an owned `ConnectedState` through each phase instead of a Tauri
/// `SyncState` cell, and returns the final state).
pub async fn run_sync(
    state_cell: &ConnectedState,
    notes_root_path: &Path,
    progress: &ProgFn,
    pre_write: &PreWriteFn,
) -> Result<(SyncSummary, ConnectedState), SyncErrorKind> {
    // First-connect / post-disconnect reconcile: if the object_map is
    // empty AND max_version is 0, run a pre-pass that matches existing
    // server data against the local vault before any push runs. Without
    // this, push would treat every local file as new and POST duplicates
    // of every blob already on the server. See `reconcile_empty_map`.
    let needs_reconcile = state_cell.object_map.is_empty() && state_cell.max_version == 0;
    let mut working = state_cell.clone();
    // Peer adoptions made by the empty-map reconcile pass. Folded into the
    // final summary so the reconcile-driven disk writes are counted as real
    // downloads (the TS rescan gate + test assertions depend on this).
    let mut reconcile_summary = SyncSummary::default();
    if needs_reconcile {
        match reconcile_empty_map(&working, notes_root_path, progress, pre_write).await {
            Ok((summary, next)) => {
                reconcile_summary = summary;
                working = next;
            }
            Err(e) => {
                // Reconcile failure must NOT silently fall through to push
                // — that's the exact data-duplication path we're guarding
                // against. Surface the error and let the user retry.
                return Err(SyncErrorKind::Io(format!("reconcile failed: {}", e.message())));
            }
        }
    }

    // The pull `since` is the persisted pull cursor — the highest change_seq we
    // have actually pulled and reconciled. It is NOT `max_version`: push
    // advances max_version for our own writes and persists it mid-push, so
    // deriving `since` from it would drop peer changes whose change_seq landed
    // below our pushed seqs — and a crash between the push persist and pull
    // completion would make that loss permanent (F32). `pull_cursor` only
    // advances when a pull completes, so it survives a crash pointing at the
    // last fully-reconciled position. (In-process this equals the old
    // pre_push_max capture; the distinction only bites across a crash.)
    let pull_since = working.pull_cursor;

    let (push_summary, after_push) =
        run_push(&working, notes_root_path, progress, pre_write).await?;
    let (pull_summary, after_pull) =
        run_pull(&after_push, notes_root_path, pull_since, progress, pre_write).await?;
    working = after_pull;

    // Concurrent-move dedup runs BEFORE rename detection so any losers
    // it deletes don't get paired by `derive_renames` as a phantom rename
    // (the loser's filename would otherwise appear in `created_hashes`).
    let all_deleted_hashes = union_deleted_hashes(
        &push_summary.deleted_hashes,
        &pull_summary.deleted_hashes,
    );
    let dup_resolution = resolve_concurrent_move_duplicates(
        &mut working,
        notes_root_path,
        pre_write,
        &all_deleted_hashes,
        &push_summary.hash_to_filenames,
        &pull_summary.hash_to_filenames,
    )
    .await?;

    let renamed = derive_renames(
        &push_summary.deleted_hashes,
        &pull_summary.deleted_hashes,
        &push_summary.created_hashes,
        &pull_summary.created_hashes,
    );

    let combined = combine_summaries(push_summary, pull_summary, renamed, dup_resolution);
    Ok((fold_reconcile_summary(combined, reconcile_summary), working))
}

/// Merge the empty-map reconcile pass's peer adoptions into the combined
/// push+pull summary. Reconcile runs BEFORE push/pull and advances the
/// cursor, so the objects it adopted are invisible to the subsequent
/// `run_pull` (it sees them already at the recorded version and skips
/// them). Without folding these in, the reconcile-driven disk writes are
/// never counted as downloads — the exact bug behind scenario 1.
/// Append `src` ids to `dst`, skipping ones already present (order-preserving).
fn dedup_append(dst: &mut Vec<String>, src: Vec<String>) {
    for id in src {
        if !dst.iter().any(|x| x == &id) {
            dst.push(id);
        }
    }
}

fn fold_reconcile_summary(mut combined: SyncSummary, mut reconcile: SyncSummary) -> SyncSummary {
    // Reconcile failures (if any) fold in regardless of the download count.
    combined.failures.append(&mut reconcile.failures);
    // F1 tombstone-reconcile deletes must fold in even when nothing was adopted
    // (a reconnect can observe only peer deletes), so this runs before the
    // download-count early-return below.
    if reconcile.deleted > 0 {
        combined.deleted += reconcile.deleted;
        dedup_append(&mut combined.deleted_ids, reconcile.deleted_ids);
        dedup_append(&mut combined.peer_deleted_ids, reconcile.peer_deleted_ids);
    }
    if reconcile.downloaded == 0 {
        return combined;
    }
    combined.downloaded += reconcile.downloaded;
    combined.local_writes_applied += reconcile.local_writes_applied;
    dedup_append(&mut combined.updated_ids, reconcile.updated_ids);
    dedup_append(&mut combined.peer_updated_ids, reconcile.peer_updated_ids);
    combined
}

fn union_deleted_hashes(
    push: &HashMap<String, String>,
    pull: &HashMap<String, String>,
) -> HashMap<String, String> {
    let mut out: HashMap<String, String> = push.clone();
    for (h, f) in pull {
        out.entry(h.clone()).or_insert_with(|| f.clone());
    }
    out
}

// ── Error helpers (String-based; mapped into SyncErrorKind) ──────────────

fn http_err_to_string(e: crate::client::E2eeHttpError) -> String {
    format!("{e}")
}

fn e2ee_err_to_string(e: e2ee::E2eeError) -> String {
    format!("{e}")
}

fn task_join_err<E: std::fmt::Display>(err: E) -> String {
    format!("background task failed: {err}")
}

// ── Error kind (internal) ────────────────────────────────────────────────

/// Internal error used by the orchestrator. Converted to the UniFFI
/// `SyncError` in `futo-notes-ffi`.
#[derive(Debug)]
pub enum SyncErrorKind {
    Http(String),
    Crypto(String),
    Io(String),
    Auth(String),
    /// The collection this session was pinned to no longer exists on the server
    /// (404) — e.g. a duplicate vault collapsed by the single-vault migration.
    /// Produced by `resume` (cold start) AND by the active-session pull path
    /// (`run_pull` / `reconcile_empty_map` via `collection_http`). Every client
    /// catches this and re-connects to the canonical vault: desktop via
    /// `syncE2eeAuto` / `ensureConnected`, native via `SyncManager`'s heal, and
    /// the shared live loop stops (terminal) so it can't spin against the dead
    /// vault. The message is prefixed `collection-gone:` so the JS boundary and
    /// the live loop can recognize it.
    CollectionGone(String),
    NotConnected,
}

impl SyncErrorKind {
    fn http(e: crate::client::E2eeHttpError) -> Self {
        if e.is_unauthorized() {
            SyncErrorKind::Auth(format!("{e}"))
        } else {
            SyncErrorKind::Http(format!("{e}"))
        }
    }

    /// Like `http`, but maps a 404 on a collection-scoped request to
    /// `CollectionGone`. The objects endpoint returns 404 when the vault no
    /// longer exists (e.g. collapsed by the single-vault migration), so an
    /// active session can re-point instead of failing the sync forever.
    fn collection_http(e: crate::client::E2eeHttpError) -> Self {
        if e.is_not_found() {
            SyncErrorKind::CollectionGone(format!("collection-gone: {e}"))
        } else {
            Self::http(e)
        }
    }

    fn auth(e: crate::client::E2eeHttpError) -> Self {
        SyncErrorKind::Auth(format!("{e}"))
    }

    fn crypto(e: e2ee::E2eeError) -> Self {
        SyncErrorKind::Crypto(format!("{e}"))
    }

    pub(crate) fn message(&self) -> String {
        match self {
            SyncErrorKind::Http(s)
            | SyncErrorKind::Crypto(s)
            | SyncErrorKind::Io(s)
            | SyncErrorKind::Auth(s)
            | SyncErrorKind::CollectionGone(s) => s.clone(),
            SyncErrorKind::NotConnected => "not connected".to_owned(),
        }
    }
}

/// `String` errors come from the filesystem helpers (`apply_delta`,
/// `read_local_note`, `safe_relative_sync_path`); they're all I/O failures.
impl From<String> for SyncErrorKind {
    fn from(s: String) -> Self {
        SyncErrorKind::Io(s)
    }
}

/// Public stringification for non-FFI consumers (the Tauri desktop returns
/// `Result<_, String>` and converts via `?` / `.to_string()`).
impl std::fmt::Display for SyncErrorKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}

impl std::error::Error for SyncErrorKind {}

/// Lets the desktop commands use `?` to convert a `SyncErrorKind` into the
/// `String` error their `#[tauri::command]` signatures return.
impl From<SyncErrorKind> for String {
    fn from(e: SyncErrorKind) -> Self {
        e.message()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    // ── Relocated desktop unit tests (the PARITY ORACLE) ─────────────────
    //
    // Migrated unchanged from the former desktop sync adapter's test module.
    // (everything EXCEPT status_when_* and input_output_serde_camel_case,
    // which test the Tauri command structs that stay in the desktop).

    fn server_object(
        id: &str,
        version: u64,
        change_seq: u64,
        deleted: bool,
        blob_key: Option<&str>,
    ) -> ServerObject {
        ServerObject {
            id: id.to_owned(),
            collection_id: "c1".to_owned(),
            version,
            change_seq,
            deleted,
            blob_key: blob_key.map(str::to_owned),
            size_bytes: None,
            created_at: "2026-05-13T00:00:00.000Z".to_owned(),
            updated_at: "2026-05-13T00:00:00.000Z".to_owned(),
        }
    }

    fn sized_object(id: &str, change_seq: u64, size_bytes: Option<u64>) -> ServerObject {
        let mut obj = server_object(id, 1, change_seq, false, Some(&format!("bk-{id}")));
        obj.size_bytes = size_bytes;
        obj
    }

    fn failed_download(change_seq: u64, kind: FailureKind) -> FailedDownload {
        FailedDownload {
            change_seq,
            failure: SyncFailure {
                filename: String::new(),
                kind,
                status_code: None,
            },
        }
    }

    // ── Batch download planning ──

    #[test]
    fn plan_download_jobs_packs_smallest_first_under_byte_cap() {
        // 3 notes + a blob that still fits the 8 MiB chunk: everything packs
        // into ONE batch, ordered ascending by size (notes land first).
        let objs = vec![
            sized_object("mid", 4, Some(6 * 1024 * 1024)),
            sized_object("n1", 1, Some(1024)),
            sized_object("n2", 2, Some(2048)),
            sized_object("n3", 3, Some(512)),
        ];
        let jobs = plan_download_jobs(objs);
        assert_eq!(jobs.len(), 1);
        match &jobs[0] {
            DownloadJob::Batch(objs) => {
                let ids: Vec<&str> = objs.iter().map(|o| o.id.as_str()).collect();
                assert_eq!(ids, vec!["n3", "n1", "n2", "mid"]);
            }
            DownloadJob::Single(_) => panic!("expected one packed batch"),
        }
    }

    #[test]
    fn plan_download_jobs_flushes_when_next_object_would_overflow() {
        // Notes pack into a batch; the 7.9 MiB blob would push the chunk past
        // 8 MiB, so the notes flush and the blob (a singleton) degrades to a
        // Single.
        let objs = vec![
            sized_object("near", 4, Some(8 * 1024 * 1024 - 1024)),
            sized_object("n1", 1, Some(1024)),
            sized_object("n2", 2, Some(2048)),
        ];
        let jobs = plan_download_jobs(objs);
        assert_eq!(jobs.len(), 2);
        match &jobs[0] {
            DownloadJob::Batch(objs) => {
                let ids: Vec<&str> = objs.iter().map(|o| o.id.as_str()).collect();
                assert_eq!(ids, vec!["n1", "n2"]);
            }
            DownloadJob::Single(_) => panic!("notes should batch"),
        }
        assert!(matches!(&jobs[1], DownloadJob::Single(o) if o.id == "near"));
    }

    #[test]
    fn plan_download_jobs_splits_at_byte_cap_and_demotes_oversize() {
        // Two 5 MiB blobs can't share an 8 MiB chunk; a 9 MiB blob and an
        // unknown-size object are never batched at all.
        let objs = vec![
            sized_object("a", 1, Some(5 * 1024 * 1024)),
            sized_object("b", 2, Some(5 * 1024 * 1024)),
            sized_object("huge", 3, Some(9 * 1024 * 1024)),
            sized_object("mystery", 4, None),
        ];
        let jobs = plan_download_jobs(objs);
        // a and b flush into singleton "batches" → demoted to singles;
        // huge and mystery are singles by rule. All four are Single.
        assert_eq!(jobs.len(), 4);
        assert!(jobs.iter().all(|j| matches!(j, DownloadJob::Single(_))));
    }

    #[test]
    fn plan_download_jobs_splits_at_key_cap() {
        let objs: Vec<ServerObject> = (0..(MAX_BATCH_KEYS + 5))
            .map(|i| sized_object(&format!("o{i}"), i as u64 + 1, Some(10)))
            .collect();
        let jobs = plan_download_jobs(objs);
        assert_eq!(jobs.len(), 2);
        match (&jobs[0], &jobs[1]) {
            (DownloadJob::Batch(first), DownloadJob::Batch(rest)) => {
                assert_eq!(first.len(), MAX_BATCH_KEYS);
                assert_eq!(rest.len(), 5);
            }
            _ => panic!("expected two batches"),
        }
    }

    #[test]
    fn plan_download_jobs_single_object_stays_on_legacy_path() {
        // A 1-file sync must remain byte-for-byte identical to the pre-batch
        // client: one GET, no batch request.
        let jobs = plan_download_jobs(vec![sized_object("only", 1, Some(100))]);
        assert_eq!(jobs.len(), 1);
        assert!(matches!(&jobs[0], DownloadJob::Single(o) if o.id == "only"));
    }

    // ── Cursor cap (issue #11) ──

    #[test]
    fn cap_cursor_holds_below_lowest_failed_change_seq() {
        let failed = vec![
            failed_download(7, FailureKind::Download),
            failed_download(4, FailureKind::Decrypt),
        ];
        // Failures at 4 and 7: cursor may only advance to 3, even though
        // downloads up to 10 succeeded.
        assert_eq!(cap_cursor(10, &failed), 3);
    }

    #[test]
    fn cap_cursor_no_failures_passes_through() {
        assert_eq!(cap_cursor(42, &[]), 42);
    }

    #[test]
    fn cap_cursor_change_seq_zero_pins_cursor() {
        // A failure with unknown change_seq (task panic) pins the cursor at
        // its pre-pull value — saturating, not underflowing.
        let failed = vec![failed_download(0, FailureKind::Download)];
        assert_eq!(cap_cursor(42, &failed), 0);
    }

    #[test]
    fn failure_message_covers_download_and_decrypt_kinds() {
        let s = SyncSummary {
            failures: vec![
                SyncFailure {
                    filename: "a.md".into(),
                    kind: FailureKind::Download,
                    status_code: Some(503),
                },
                SyncFailure {
                    filename: "b.md".into(),
                    kind: FailureKind::Download,
                    status_code: None,
                },
                SyncFailure {
                    filename: "c.md".into(),
                    kind: FailureKind::Decrypt,
                    status_code: None,
                },
            ],
            ..Default::default()
        };
        let msg = s.failure_message().expect("failures present");
        assert_eq!(
            msg,
            "2 notes couldn't be downloaded (will retry); 1 note couldn't be decrypted"
        );
    }

    #[test]
    fn first_pass_downloads_new_and_tombstones_known_deletes() {
        let mut map = HashMap::new();
        map.insert(
            "alpha.md".to_owned(),
            E2eeObjectMapEntry {
                object_id: "oA".into(),
                version: 1,
                blob_key: "bk-old".into(),
                hash: None,
                mtime_ms: None,
                size_bytes: None,
            },
        );
        let by_id = build_filename_by_object_id(&map);

        let objects = vec![
            // Deleted object we know about → immediate delete.
            server_object("oA", 2, 5, true, None),
            // Brand-new object → download.
            server_object("oB", 1, 6, false, Some("bk-B")),
            // Unknown deleted → skip silently (nothing to delete locally).
            server_object("oC", 1, 7, true, None),
        ];

        let fp = first_pass(objects, &map, &by_id, 0);
        assert_eq!(fp.immediate_deletes, vec!["alpha.md"]);
        assert_eq!(fp.to_download.len(), 1);
        assert_eq!(fp.to_download[0].id, "oB");
        assert_eq!(fp.new_max_version, 7);
    }

    #[test]
    fn first_pass_skips_already_synced_at_same_version_and_blob() {
        let mut map = HashMap::new();
        map.insert(
            "alpha.md".to_owned(),
            E2eeObjectMapEntry {
                object_id: "oA".into(),
                version: 3,
                blob_key: "bk-3".into(),
                hash: None,
                mtime_ms: None,
                size_bytes: None,
            },
        );
        let by_id = build_filename_by_object_id(&map);

        // Server reports the same version we already have → skip the download.
        let objects = vec![server_object("oA", 3, 9, false, Some("bk-3"))];
        let fp = first_pass(objects, &map, &by_id, 5);
        assert!(fp.to_download.is_empty());
        assert!(fp.immediate_deletes.is_empty());
        assert_eq!(fp.new_max_version, 9);
    }

    #[test]
    fn first_pass_redownloads_when_blob_rotates_at_same_version() {
        // Same version, different blob_key → must redownload (server
        // updated the blob without bumping version — e.g. recompression
        // or rewrap.) Belt-and-suspenders since the protocol shouldn't
        // emit this in practice, but the TS path also redownloads here.
        let mut map = HashMap::new();
        map.insert(
            "alpha.md".to_owned(),
            E2eeObjectMapEntry {
                object_id: "oA".into(),
                version: 3,
                blob_key: "bk-old".into(),
                hash: None,
                mtime_ms: None,
                size_bytes: None,
            },
        );
        let by_id = build_filename_by_object_id(&map);

        let objects = vec![server_object("oA", 3, 4, false, Some("bk-NEW"))];
        let fp = first_pass(objects, &map, &by_id, 0);
        assert_eq!(fp.to_download.len(), 1);
    }

    #[test]
    fn first_pass_advances_max_version_even_when_nothing_to_apply() {
        let map = HashMap::new();
        let by_id = build_filename_by_object_id(&map);
        // All objects are deleted and unknown locally — nothing to do, but
        // we still advance the cursor so the next pull doesn't re-fetch them.
        let objects = vec![
            server_object("oA", 1, 50, true, None),
            server_object("oB", 1, 51, true, None),
        ];
        let fp = first_pass(objects, &map, &by_id, 10);
        assert_eq!(fp.new_max_version, 51);
        assert!(fp.to_download.is_empty());
        assert!(fp.immediate_deletes.is_empty());
    }

    fn local(filename: &str, mtime: i64, size: u64) -> NoteFileMeta {
        NoteFileMeta {
            name: filename.to_owned(),
            mtime_ms: mtime,
            size_bytes: size,
        }
    }

    fn map_entry(version: u64, hash: Option<&str>, mtime: Option<i64>, size: Option<u64>) -> E2eeObjectMapEntry {
        E2eeObjectMapEntry {
            object_id: "o".into(),
            version,
            blob_key: "bk".into(),
            hash: hash.map(str::to_owned),
            mtime_ms: mtime,
            size_bytes: size,
        }
    }

    #[test]
    fn plan_push_fast_path_skips_matching_mtime_size() {
        let local = vec![local("a.md", 100, 10), local("b.md", 200, 20)];
        let mut map = HashMap::new();
        map.insert("a.md".into(), map_entry(1, Some("h"), Some(100), Some(10)));
        // b.md has a stale mtime — must still upload.
        map.insert("b.md".into(), map_entry(1, Some("h"), Some(150), Some(20)));
        let plan = plan_push(&local, &map);
        let names: Vec<_> = plan.candidates.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, vec!["b.md"]);
        assert!(plan.deletes.is_empty());
    }

    #[test]
    fn plan_push_detects_deletes() {
        let local = vec![local("kept.md", 1, 1)];
        let mut map = HashMap::new();
        map.insert("kept.md".into(), map_entry(1, Some("h"), Some(1), Some(1)));
        map.insert("gone.md".into(), map_entry(2, Some("h"), Some(1), Some(1)));
        let plan = plan_push(&local, &map);
        let delete_names: Vec<_> = plan.deletes.iter().map(|(f, _)| f.as_str()).collect();
        assert_eq!(delete_names, vec!["gone.md"]);
        assert!(plan.candidates.is_empty());
    }

    // F7 migration: a legacy `.tiff` (or otherwise non-syncable) map entry is
    // no longer produced by the local scan, so it looks "deleted locally" and
    // would be tombstoned — destroying it on the server and every peer. It must
    // NEVER be tombstoned; a genuinely-gone `.md` still is.
    #[test]
    fn plan_push_never_tombstones_non_syncable_map_entry() {
        let local = vec![local("kept.md", 1, 1)];
        let mut map = HashMap::new();
        map.insert("kept.md".into(), map_entry(1, Some("h"), Some(1), Some(1)));
        map.insert("scan.tiff".into(), map_entry(2, Some("h"), Some(1), Some(1)));
        map.insert("gone.md".into(), map_entry(3, Some("h"), Some(1), Some(1)));
        let plan = plan_push(&local, &map);
        let delete_names: Vec<_> = plan.deletes.iter().map(|(f, _)| f.as_str()).collect();
        assert_eq!(
            delete_names,
            vec!["gone.md"],
            "only the genuinely-gone .md is tombstoned; the legacy .tiff is left alone"
        );
    }

    #[test]
    fn plan_push_uploads_brand_new_files() {
        let local = vec![local("new.md", 5, 5)];
        let map = HashMap::new();
        let plan = plan_push(&local, &map);
        assert_eq!(plan.candidates.len(), 1);
        assert_eq!(plan.candidates[0].name, "new.md");
    }

    #[test]
    fn plan_push_uploads_when_hash_missing_from_entry() {
        // Older map entries from before the hash field was added must
        // still be re-uploaded so a backfill happens on the next push.
        let local = vec![local("a.md", 1, 1)];
        let mut map = HashMap::new();
        map.insert("a.md".into(), map_entry(1, None, Some(1), Some(1)));
        let plan = plan_push(&local, &map);
        assert_eq!(plan.candidates.len(), 1);
    }

    #[test]
    fn derive_renames_matches_hash_across_phases() {
        let mut push_deleted = HashMap::new();
        push_deleted.insert("h1".to_owned(), "old.md".to_owned());
        let mut pull_created = HashMap::new();
        pull_created.insert("h1".to_owned(), "new.md".to_owned());
        let r = derive_renames(&push_deleted, &HashMap::new(), &HashMap::new(), &pull_created);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].from_id, "old");
        assert_eq!(r[0].to_id, "new");
    }

    #[test]
    fn derive_renames_skips_when_no_match() {
        let mut push_deleted = HashMap::new();
        push_deleted.insert("h-only-delete".to_owned(), "gone.md".to_owned());
        let r = derive_renames(&push_deleted, &HashMap::new(), &HashMap::new(), &HashMap::new());
        assert!(r.is_empty());
    }

    #[test]
    fn combine_summaries_drops_ghost_delete_for_renamed_id() {
        let push = SyncSummary {
            deleted_ids: vec!["old".into()],
            peer_deleted_ids: vec!["old".into()],
            ..Default::default()
        };
        let pull = SyncSummary {
            updated_ids: vec!["new".into()],
            peer_updated_ids: vec!["new".into()],
            ..Default::default()
        };
        let renamed = vec![RenamePair {
            from_id: "old".into(),
            to_id: "new".into(),
        }];
        let combined = combine_summaries(push, pull, renamed, DuplicateResolution::default());
        assert!(combined.deleted_ids.is_empty());
        assert!(combined.peer_deleted_ids.is_empty());
        assert!(combined.updated_ids.is_empty());
        assert!(combined.peer_updated_ids.is_empty());
        assert_eq!(combined.renamed.len(), 1);
    }

    #[test]
    fn combine_summaries_merges_push_and_pull_failures() {
        // The failure channel (work-item #10) must survive the push+pull merge
        // so the combined summary the UI reads carries every per-item failure.
        let push = SyncSummary {
            failures: vec![SyncFailure {
                filename: "up.md".into(),
                kind: FailureKind::Upload,
                status_code: Some(500),
            }],
            ..Default::default()
        };
        let pull = SyncSummary {
            failures: vec![SyncFailure {
                filename: "del.md".into(),
                kind: FailureKind::Delete,
                status_code: None,
            }],
            ..Default::default()
        };
        let dup = DuplicateResolution {
            failures: vec![SyncFailure {
                filename: "dup.md".into(),
                kind: FailureKind::Delete,
                status_code: Some(502),
            }],
            ..Default::default()
        };
        let combined = combine_summaries(push, pull, Vec::new(), dup);
        assert_eq!(combined.failures.len(), 3);
        assert_eq!(combined.failures[0].filename, "up.md");
        assert_eq!(combined.failures[1].kind, FailureKind::Delete);
        assert_eq!(combined.failures[2].filename, "dup.md");
        assert_eq!(combined.failures[2].status_code, Some(502));
    }

    fn failure(filename: &str, kind: FailureKind, status_code: Option<u16>) -> SyncFailure {
        SyncFailure {
            filename: filename.into(),
            kind,
            status_code,
        }
    }

    fn summary_with(failures: Vec<SyncFailure>) -> SyncSummary {
        SyncSummary {
            failures,
            ..Default::default()
        }
    }

    // failure_message is the single source of the user-facing wording for all
    // three shells (docs/spec/sync.md) — these pin it.
    #[test]
    fn failure_message_none_for_clean_cycle() {
        assert_eq!(summary_with(Vec::new()).failure_message(), None);
    }

    #[test]
    fn failure_message_singular_vs_plural() {
        let one = summary_with(vec![failure("a.md", FailureKind::Upload, None)]);
        assert_eq!(
            one.failure_message().unwrap(),
            "1 change couldn't reach the server"
        );
        let three = summary_with(vec![
            failure("a.md", FailureKind::Upload, None),
            failure("b.md", FailureKind::Upload, None),
            failure("c.md", FailureKind::Delete, None),
        ]);
        assert_eq!(
            three.failure_message().unwrap(),
            "3 changes couldn't reach the server"
        );
    }

    #[test]
    fn failure_message_appends_most_frequent_status() {
        let s = summary_with(vec![
            failure("a.md", FailureKind::Upload, Some(500)),
            failure("b.md", FailureKind::Upload, Some(500)),
            failure("c.md", FailureKind::Delete, Some(403)),
        ]);
        assert_eq!(
            s.failure_message().unwrap(),
            "3 changes couldn't reach the server (HTTP 500)"
        );
    }

    #[test]
    fn failure_message_tie_keeps_first_seen_status() {
        // Deterministic tie-break: first-seen wins, on every platform, every
        // run — the shells render this string verbatim.
        let s = summary_with(vec![
            failure("a.md", FailureKind::Upload, Some(500)),
            failure("b.md", FailureKind::Upload, Some(403)),
        ]);
        assert_eq!(
            s.failure_message().unwrap(),
            "2 changes couldn't reach the server (HTTP 500)"
        );
    }

    #[test]
    fn failure_message_checkpoint_is_local_not_server() {
        // A checkpoint failure is a local persist error — the data DID reach
        // the server, so it must not be described as a server-reach failure.
        let s = summary_with(vec![failure("", FailureKind::Checkpoint, None)]);
        assert_eq!(
            s.failure_message().unwrap(),
            "sync state couldn't be saved locally"
        );
    }

    #[test]
    fn failure_message_mixed_server_and_checkpoint() {
        let s = summary_with(vec![
            failure("a.md", FailureKind::Upload, Some(500)),
            failure("", FailureKind::Checkpoint, None),
        ]);
        assert_eq!(
            s.failure_message().unwrap(),
            "1 change couldn't reach the server (HTTP 500); sync state couldn't be saved locally"
        );
    }

    #[test]
    fn failure_kind_wire_strings() {
        assert_eq!(FailureKind::Upload.as_str(), "upload");
        assert_eq!(FailureKind::Delete.as_str(), "delete");
        assert_eq!(FailureKind::Checkpoint.as_str(), "checkpoint");
    }

    #[test]
    fn fold_reconcile_surfaces_adoptions_as_downloads() {
        // Scenario 1: B's first sync adopts A's note via the empty-map
        // reconcile pass. The subsequent push/pull see nothing new, so the
        // combined summary is empty — folding the reconcile summary in must
        // make the adoption a real download + peer update so the TS rescan
        // gate fires.
        let combined = SyncSummary::default();
        let reconcile = SyncSummary {
            downloaded: 1,
            updated_ids: vec!["editor roundtrip".into()],
            peer_updated_ids: vec!["editor roundtrip".into()],
            ..Default::default()
        };
        let folded = fold_reconcile_summary(combined, reconcile);
        assert_eq!(folded.downloaded, 1);
        assert_eq!(folded.updated_ids, vec!["editor roundtrip".to_string()]);
        assert_eq!(folded.peer_updated_ids, vec!["editor roundtrip".to_string()]);
    }

    #[test]
    fn fold_reconcile_no_op_when_nothing_adopted() {
        // No adoptions → no change to the combined summary (and no double
        // counting of objects the pull already reported).
        let combined = SyncSummary {
            downloaded: 2,
            peer_updated_ids: vec!["existing".into()],
            ..Default::default()
        };
        let folded = fold_reconcile_summary(combined.clone(), SyncSummary::default());
        assert_eq!(folded.downloaded, 2);
        assert_eq!(folded.peer_updated_ids, vec!["existing".to_string()]);
    }

    #[test]
    fn fold_reconcile_dedupes_ids_already_present() {
        // If both reconcile and pull report the same id, it appears once.
        let combined = SyncSummary {
            downloaded: 1,
            peer_updated_ids: vec!["dup".into()],
            ..Default::default()
        };
        let reconcile = SyncSummary {
            downloaded: 1,
            updated_ids: vec!["dup".into()],
            peer_updated_ids: vec!["dup".into()],
            ..Default::default()
        };
        let folded = fold_reconcile_summary(combined, reconcile);
        // downloaded counts are additive (each pass counted a real write);
        // the id list dedupes so the sidebar doesn't see a phantom row.
        assert_eq!(folded.downloaded, 2);
        assert_eq!(folded.peer_updated_ids, vec!["dup".to_string()]);
        assert_eq!(folded.updated_ids, vec!["dup".to_string()]);
    }

    #[test]
    fn combine_summaries_carries_push_side_download_from_restore() {
        // Scenario 2: B's edit-wins delete-conflict restore writes A's
        // content back on the push side, bumping run_push's `downloaded`.
        // combine_summaries must preserve that count (push is the base) and
        // add any pull downloads on top.
        let push = SyncSummary {
            downloaded: 1,
            peer_updated_ids: vec!["during sync".into()],
            ..Default::default()
        };
        let pull = SyncSummary::default();
        let combined = combine_summaries(push, pull, Vec::new(), DuplicateResolution::default());
        assert_eq!(combined.downloaded, 1);
        assert_eq!(combined.peer_updated_ids, vec!["during sync".to_string()]);
    }

    #[test]
    fn combine_summaries_carries_local_writes_applied() {
        // F2: a push-side clean merge (MergedClean) writes merged text to the
        // LOCAL disk but bumps `uploaded`, not `downloaded`/`deleted`. The
        // count of those local writes must survive combine so a native shell
        // that gates its editor reload on it never treats a merge as a no-op
        // and lets its next autosave clobber the merged-in peer edit.
        let push = SyncSummary {
            uploaded: 1,
            local_writes_applied: 1,
            ..Default::default()
        };
        let pull = SyncSummary {
            downloaded: 2,
            local_writes_applied: 2,
            ..Default::default()
        };
        let combined = combine_summaries(push, pull, Vec::new(), DuplicateResolution::default());
        assert_eq!(combined.local_writes_applied, 3);
        // The bug's fingerprint: local writes with no downloads/deletes.
        let merge_only = combine_summaries(
            SyncSummary { uploaded: 1, local_writes_applied: 1, ..Default::default() },
            SyncSummary::default(),
            Vec::new(),
            DuplicateResolution::default(),
        );
        assert_eq!(merge_only.downloaded, 0);
        assert_eq!(merge_only.deleted, 0);
        assert_eq!(merge_only.local_writes_applied, 1);
    }

    #[test]
    fn fold_reconcile_carries_local_writes_applied() {
        // Reconcile adoptions write server content to local disk; the count
        // must fold in alongside the download count it also surfaces.
        let combined = SyncSummary::default();
        let reconcile = SyncSummary {
            downloaded: 1,
            local_writes_applied: 1,
            updated_ids: vec!["adopted".into()],
            peer_updated_ids: vec!["adopted".into()],
            ..Default::default()
        };
        let folded = fold_reconcile_summary(combined, reconcile);
        assert_eq!(folded.local_writes_applied, 1);
    }

    #[test]
    fn combine_summaries_routes_dup_losers_to_deleted_lists() {
        // Pull surfaced both FolderA/contested and FolderB/contested as
        // peer updates; the dup resolver picked FolderB as winner and
        // deleted FolderA. The combined summary must move FolderA out of
        // updated_ids and into deleted_ids so the sidebar reflects reality.
        let push = SyncSummary::default();
        let pull = SyncSummary {
            updated_ids: vec!["FolderA/contested".into(), "FolderB/contested".into()],
            peer_updated_ids: vec!["FolderA/contested".into(), "FolderB/contested".into()],
            ..Default::default()
        };
        let dup = DuplicateResolution {
            conflicts: 1,
            deleted_ids: vec!["FolderA/contested".into()],
            ..Default::default()
        };
        let combined = combine_summaries(push, pull, Vec::new(), dup);
        assert_eq!(combined.updated_ids, vec!["FolderB/contested".to_string()]);
        assert_eq!(combined.peer_updated_ids, vec!["FolderB/contested".to_string()]);
        assert_eq!(combined.deleted_ids, vec!["FolderA/contested".to_string()]);
        assert_eq!(combined.peer_deleted_ids, vec!["FolderA/contested".to_string()]);
        assert_eq!(combined.conflicts, 1);
        assert_eq!(combined.deleted, 1);
    }

    #[test]
    fn filename_basename_strips_path_prefix() {
        assert_eq!(filename_basename("FolderA/contested.md"), "contested.md");
        assert_eq!(filename_basename("contested.md"), "contested.md");
        assert_eq!(filename_basename("a/b/c/leaf.md"), "leaf.md");
    }

    fn h2f(filename: &str, change_seq: u64) -> HashFilenameEntry {
        // Legacy helper: distinct filenames get distinct synthetic object ids,
        // so a bare h2f models two DIFFERENT notes. Tests that need the SAME
        // object surfacing under two names use `h2f_oid`.
        HashFilenameEntry {
            filename: filename.to_owned(),
            change_seq,
            object_id: format!("obj-{filename}"),
        }
    }

    fn h2f_oid(filename: &str, change_seq: u64, object_id: &str) -> HashFilenameEntry {
        HashFilenameEntry {
            filename: filename.to_owned(),
            change_seq,
            object_id: object_id.to_owned(),
        }
    }

    #[test]
    fn dup_losers_empty_when_only_one_candidate() {
        // Normal rename: one delete, one create at a different path. No
        // dup resolution; derive_renames handles this case instead.
        let mut push = HashMap::new();
        push.insert("hX".to_owned(), vec![h2f("Lists/grocery.md", 5)]);
        let losers = pick_duplicate_move_losers("grocery.md", "hX", &push, &HashMap::new());
        assert!(losers.is_empty());
    }

    #[test]
    fn dup_losers_picks_lower_change_seq_when_two_folders_compete() {
        // The SAME object (o1) surfaced under two names in one cycle: our push
        // wrote it at FolderB/contested (change_seq=5), the pull re-listed it at
        // FolderA/contested (change_seq=3). One object, two on-disk copies →
        // collapse to the higher change_seq. B wins; FolderA must lose.
        let mut push = HashMap::new();
        push.insert("hX".to_owned(), vec![h2f_oid("FolderB/contested.md", 5, "o1")]);
        let mut pull = HashMap::new();
        pull.insert("hX".to_owned(), vec![h2f_oid("FolderA/contested.md", 3, "o1")]);
        let losers = pick_duplicate_move_losers("contested.md", "hX", &push, &pull);
        assert_eq!(losers.len(), 1);
        assert_eq!(losers[0].filename, "FolderA/contested.md");
    }

    #[test]
    fn dup_losers_keeps_distinct_objects_sharing_basename_and_content() {
        // F9: two LEGITIMATELY DISTINCT notes with the same basename and the
        // same content (e.g. two empty `Untitled.md` in different folders) plus
        // a same-content delete in the cycle. They are different objects, so
        // the move-dedup must keep BOTH — deleting one is silent data loss.
        let mut push = HashMap::new();
        push.insert(
            "hEmpty".to_owned(),
            vec![
                h2f_oid("FolderA/Untitled.md", 5, "oa"),
                h2f_oid("FolderB/Untitled.md", 7, "ob"),
            ],
        );
        let losers =
            pick_duplicate_move_losers("Trash/Untitled.md", "hEmpty", &push, &HashMap::new());
        assert!(
            losers.is_empty(),
            "distinct objects sharing basename+content must both survive, got {losers:?}"
        );
    }

    #[test]
    fn dup_losers_ignores_basename_mismatch() {
        // Same hash at a non-matching basename → not a move-collision; skip.
        // (E.g. two notes that happen to have identical content but
        // different names — keep both.)
        let mut push = HashMap::new();
        push.insert(
            "hX".to_owned(),
            vec![h2f("FolderA/foo.md", 5), h2f("FolderB/bar.md", 3)],
        );
        let losers = pick_duplicate_move_losers("contested.md", "hX", &push, &HashMap::new());
        assert!(losers.is_empty());
    }

    #[test]
    fn dup_losers_tiebreaks_lexicographically_on_same_change_seq() {
        // The same object (o1) at two names with the same change_seq → tie-break
        // by filename (Aaa wins, Bbb loses) so the result is deterministic
        // across clients.
        let mut push = HashMap::new();
        push.insert(
            "hX".to_owned(),
            vec![
                h2f_oid("Bbb/contested.md", 7, "o1"),
                h2f_oid("Aaa/contested.md", 7, "o1"),
            ],
        );
        let losers = pick_duplicate_move_losers("contested.md", "hX", &push, &HashMap::new());
        assert_eq!(losers.len(), 1);
        assert_eq!(losers[0].filename, "Bbb/contested.md");
    }

    #[test]
    fn dup_losers_deduplicates_filename_appearing_in_both_maps() {
        // A push and a pull both surface the same destination filename
        // (e.g. self-push followed by pull re-listing it). That's not a
        // collision — only one unique destination.
        let mut push = HashMap::new();
        push.insert("hX".to_owned(), vec![h2f("Lists/grocery.md", 4)]);
        let mut pull = HashMap::new();
        pull.insert("hX".to_owned(), vec![h2f("Lists/grocery.md", 4)]);
        let losers = pick_duplicate_move_losers("grocery.md", "hX", &push, &pull);
        assert!(losers.is_empty());
    }

    fn nfm(name: &str) -> NoteFileMeta {
        NoteFileMeta {
            name: name.to_owned(),
            mtime_ms: 0,
            size_bytes: 0,
        }
    }

    fn simple_entry() -> E2eeObjectMapEntry {
        E2eeObjectMapEntry {
            object_id: "o1".into(),
            version: 1,
            blob_key: "bk".into(),
            hash: Some("h".into()),
            mtime_ms: Some(0),
            size_bytes: Some(0),
        }
    }

    #[test]
    fn pair_local_moves_detects_rename() {
        // Map had `grocery.md`; on disk we now have `Lists/grocery.md`
        // (and `grocery.md` is gone). Pair them so push reuses the same
        // object_id via PUT instead of DELETE + POST.
        let mut map = HashMap::new();
        map.insert("grocery.md".to_owned(), simple_entry());
        let local = vec![nfm("Lists/grocery.md")];
        let pairings = pair_local_moved_objects(&local, &map);
        assert_eq!(pairings.get("Lists/grocery.md").map(String::as_str), Some("grocery.md"));
        assert_eq!(pairings.len(), 1);
    }

    #[test]
    fn pair_local_moves_skips_ambiguous_basenames() {
        // Two files with the same basename are missing AND two new files
        // share that basename → can't tell which paired with which.
        // Don't pair anything.
        let mut map = HashMap::new();
        map.insert("A/note.md".to_owned(), simple_entry());
        map.insert("B/note.md".to_owned(), simple_entry());
        let local = vec![nfm("C/note.md"), nfm("D/note.md")];
        let pairings = pair_local_moved_objects(&local, &map);
        assert!(pairings.is_empty());
    }

    #[test]
    fn pair_local_moves_skips_when_file_still_on_disk() {
        // The map entry's filename is still on disk → not missing. Even
        // if there's an unmapped same-basename file, no pairing.
        let mut map = HashMap::new();
        map.insert("note.md".to_owned(), simple_entry());
        let local = vec![nfm("note.md"), nfm("Lists/note.md")];
        let pairings = pair_local_moved_objects(&local, &map);
        assert!(pairings.is_empty());
    }

    #[test]
    fn pair_local_moves_skips_when_basenames_differ() {
        // Missing file and new file don't share a basename — not a move.
        let mut map = HashMap::new();
        map.insert("alpha.md".to_owned(), simple_entry());
        let local = vec![nfm("beta.md")];
        let pairings = pair_local_moved_objects(&local, &map);
        assert!(pairings.is_empty());
    }

    #[test]
    fn plan_push_includes_local_moves_even_when_hash_unchanged() {
        // Local move case: the filename in `effective_map` matches the
        // on-disk filename and (hash, mtime, size) all match — would be
        // a fast-path skip without the local-move signal. With it, the
        // file must be pushed so the encrypted blob's `path` updates.
        let mut map = HashMap::new();
        map.insert(
            "Lists/grocery.md".to_owned(),
            E2eeObjectMapEntry {
                object_id: "o1".into(),
                version: 1,
                blob_key: "bk".into(),
                hash: Some("h".into()),
                mtime_ms: Some(42),
                size_bytes: Some(7),
            },
        );
        let local = vec![NoteFileMeta {
            name: "Lists/grocery.md".to_owned(),
            mtime_ms: 42,
            size_bytes: 7,
        }];
        let mut moves = HashSet::new();
        moves.insert("Lists/grocery.md".to_owned());
        let plan = plan_push_with_moves(&local, &map, &moves);
        assert_eq!(plan.candidates.len(), 1);
        assert_eq!(plan.candidates[0].name, "Lists/grocery.md");
        assert!(plan.deletes.is_empty());
    }

    #[test]
    fn union_deleted_hashes_prefers_push_over_pull_on_collision() {
        // If both sides observed the same hash deleted, push's filename
        // wins (it's the local rename source; pull would just be
        // applying the same tombstone we just sent).
        let mut push = HashMap::new();
        push.insert("hX".to_owned(), "push-name.md".to_owned());
        let mut pull = HashMap::new();
        pull.insert("hX".to_owned(), "pull-name.md".to_owned());
        pull.insert("hY".to_owned(), "pull-only.md".to_owned());
        let unioned = union_deleted_hashes(&push, &pull);
        assert_eq!(unioned.get("hX").unwrap(), "push-name.md");
        assert_eq!(unioned.get("hY").unwrap(), "pull-only.md");
        assert_eq!(unioned.len(), 2);
    }

    #[test]
    fn filename_to_id_strips_md_suffix_only() {
        assert_eq!(filename_to_id("note.md"), "note");
        assert_eq!(filename_to_id("Specs/folder/note.md"), "Specs/folder/note");
        // Already an id (no extension) → returned unchanged.
        assert_eq!(filename_to_id("plain"), "plain");
    }

    // ── Crate-local apply / path-safety tests (kept from the spike) ──────

    fn temp_root() -> PathBuf {
        use std::sync::atomic::AtomicU32;
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("futo-sync-orch-test-{}-{n}", now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn no_pre_write() -> Box<PreWriteFn> {
        Box::new(|_f: &str| {})
    }

    #[test]
    fn safe_relative_sync_path_rejects_traversal() {
        let base = Path::new("/tmp/x");
        assert!(safe_relative_sync_path(base, "../escape.md").is_err());
        assert!(safe_relative_sync_path(base, "/abs.md").is_err());
        assert!(safe_relative_sync_path(base, "no-ext").is_err());
        assert!(safe_relative_sync_path(base, "ok.md").is_ok());
        assert!(safe_relative_sync_path(base, "Specs/ok.md").is_ok());
        // Image blobs are syncable too; arbitrary binaries are not.
        assert!(safe_relative_sync_path(base, "image-123.png").is_ok());
        assert!(safe_relative_sync_path(base, "Specs/pic.JPEG").is_ok());
        assert!(safe_relative_sync_path(base, "../evil.png").is_err());
        assert!(safe_relative_sync_path(base, "secrets.txt").is_err());
    }

    #[test]
    fn list_notes_skips_hidden_and_finds_md_and_images() {
        let root = temp_root();
        std::fs::write(root.join("a.md"), "alpha").unwrap();
        std::fs::create_dir_all(root.join("Specs")).unwrap();
        std::fs::write(root.join("Specs/b.md"), "beta").unwrap();
        // An embedded image blob must be picked up so it syncs with its note.
        std::fs::write(root.join("image-1.png"), [0x89u8, b'P', b'N', b'G']).unwrap();
        std::fs::write(root.join(".e2ee-state.json"), "{}").unwrap();
        std::fs::write(root.join("ignore.txt"), "nope").unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join(".git/c.md"), "hidden").unwrap();

        let names: HashSet<String> = list_notes_with_meta(&root)
            .into_iter()
            .map(|f| f.name)
            .collect();
        assert!(names.contains("a.md"));
        assert!(names.contains("Specs/b.md"));
        assert!(names.contains("image-1.png"));
        assert!(!names.contains("ignore.txt"));
        assert!(!names.iter().any(|n| n.contains(".git")));
        assert_eq!(names.len(), 3);
        std::fs::remove_dir_all(&root).ok();
    }

    /// End-to-end I/O round-trip proving an image blob survives the sync
    /// content layer: apply_delta decodes base64 → raw bytes on disk, and
    /// read_local_note re-encodes the on-disk bytes → the same base64. This is
    /// the path that was missing entirely (images were never scanned, so the
    /// `![](…)` reference synced but the bytes never did).
    #[tokio::test]
    async fn image_blob_round_trips_through_apply_and_read() {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        let root = temp_root();
        let pre = no_pre_write();
        // Non-UTF-8 bytes — exactly what read_to_string would have choked on.
        let raw: Vec<u8> = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0xff, 0x00, 0xfe, 0x01];
        let b64 = STANDARD.encode(&raw);

        apply_delta(
            &root,
            pre.as_ref(),
            V2SyncApplyInput {
                update: vec![V2IncomingUpdate {
                    filename: "image-xyz.png".into(),
                    content: b64.clone(),
                    hash: hash_sha256(&b64),
                    modified_at: 0,
                }],
                delete: Vec::new(),
                conflicts: Vec::new(),
                timestamps: HashMap::new(),
            },
        )
        .unwrap();

        // On disk it's the raw bytes, not the base64 text.
        assert_eq!(std::fs::read(root.join("image-xyz.png")).unwrap(), raw);

        // Reading it back for a push re-produces the identical base64 content,
        // so the content hash is stable across the round-trip.
        let read_back = read_local_note(&root, "image-xyz.png").await.unwrap();
        assert_eq!(read_back, b64);
        assert_eq!(hash_sha256(&read_back), hash_sha256(&b64));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn apply_delta_writes_and_deletes_round_trip() {
        let root = temp_root();
        let pre = no_pre_write();
        apply_delta(
            &root,
            pre.as_ref(),
            V2SyncApplyInput {
                update: vec![V2IncomingUpdate {
                    filename: "Specs/note.md".into(),
                    content: "body".into(),
                    hash: "h".into(),
                    modified_at: 0,
                }],
                delete: Vec::new(),
                conflicts: Vec::new(),
                timestamps: HashMap::new(),
            },
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("Specs/note.md")).unwrap(),
            "body"
        );

        apply_delta(
            &root,
            pre.as_ref(),
            V2SyncApplyInput {
                update: Vec::new(),
                delete: vec!["Specs/note.md".into()],
                conflicts: Vec::new(),
                timestamps: HashMap::new(),
            },
        )
        .unwrap();
        assert!(!root.join("Specs/note.md").exists());
        // Empty parent dir got pruned.
        assert!(!root.join("Specs").exists());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn apply_delta_fires_pre_write_for_each_filename() {
        use std::sync::Mutex;
        let root = temp_root();
        let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let seen2 = seen.clone();
        let hook: Box<PreWriteFn> = Box::new(move |f: &str| seen2.lock().unwrap().push(f.to_owned()));
        apply_delta(
            &root,
            hook.as_ref(),
            V2SyncApplyInput {
                update: vec![V2IncomingUpdate {
                    filename: "a.md".into(),
                    content: "x".into(),
                    hash: "h".into(),
                    modified_at: 0,
                }],
                delete: vec!["gone.md".into()],
                conflicts: vec![V2IncomingConflict {
                    filename: "c.md".into(),
                    content: "y".into(),
                }],
                timestamps: HashMap::new(),
            },
        )
        .unwrap();
        let seen = seen.lock().unwrap();
        // pre_write fires for the delete, the update, and the conflict copy.
        assert!(seen.contains(&"gone.md".to_string()));
        assert!(seen.contains(&"a.md".to_string()));
        assert!(seen.contains(&"c.md".to_string()));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn current_date_is_yyyy_mm_dd() {
        let date = current_date_yyyy_mm_dd();
        // YYYY-MM-DD = 10 chars, dashes at indices 4 and 7.
        assert_eq!(date.len(), 10);
        assert_eq!(&date[4..5], "-");
        assert_eq!(&date[7..8], "-");
        assert!(date[0..4].chars().all(|c| c.is_ascii_digit()));
    }

    // ── resolve_pull_collisions (F4 / F5) ──────────────────────────────

    // Distinct objects get DISTINCT content hashes (derived from object_id) so
    // a name collision between them is a REAL conflict (→ conflict copy). The
    // identical-content adoption path is exercised by a dedicated test that
    // gives the colliding objects the same hash explicitly.
    fn dnote(object_id: &str, filename: &str) -> DownloadedNote {
        DownloadedNote {
            object_id: object_id.to_owned(),
            version: 1,
            change_seq: 1,
            blob_key: "bk".to_owned(),
            filename: filename.to_owned(),
            content: "x".to_owned(),
            hash: format!("h-{object_id}"),
            modified_at_ms: 1,
        }
    }

    fn map_entry_oid(object_id: &str) -> E2eeObjectMapEntry {
        E2eeObjectMapEntry {
            object_id: object_id.to_owned(),
            version: 1,
            blob_key: "bk".to_owned(),
            hash: Some(format!("h-{object_id}")),
            mtime_ms: Some(1),
            size_bytes: Some(1),
        }
    }

    // F4: two distinct objects land in the SAME pull batch under names that
    // collide by case. Winner = smaller object_id keeps the canonical name;
    // the other download is parked at a deterministic conflict copy.
    #[test]
    fn collision_both_in_batch_parks_loser() {
        let dl = vec![dnote("obj-bbb", "Welcome.md"), dnote("obj-aaa", "welcome.md")];
        let map = HashMap::new();
        let plan = resolve_pull_collisions(&dl, &map, &HashSet::new());
        // obj-aaa < obj-bbb → idx 1 (welcome.md) wins, idx 0 is parked.
        assert!(plan.map_renames.is_empty());
        assert_eq!(plan.download_overrides.len(), 1);
        assert_eq!(
            plan.download_overrides.get(&0).unwrap(),
            "welcome (conflict objbbb).md"
        );
    }

    // F4 scope-hole: the WINNER is already on disk + in the map (a prior sync);
    // only the rival arrives in this incremental pull. The freshly-pulled
    // loser must be parked, NOT written over the on-disk winner.
    #[test]
    fn collision_rival_is_map_only_loser_download_parked() {
        // Map already holds the winner welcome.md (obj-aaa). The pull brings
        // Welcome.md (obj-bbb), a distinct object that collides.
        let dl = vec![dnote("obj-bbb", "Welcome.md")];
        let mut map = HashMap::new();
        map.insert("welcome.md".to_owned(), map_entry_oid("obj-aaa"));
        let plan = resolve_pull_collisions(&dl, &map, &HashSet::new());
        // obj-aaa (map) wins; obj-bbb (download) is parked at the conflict name
        // derived from the WINNER's canonical filename (welcome.md).
        assert!(plan.map_renames.is_empty(), "winner stays put on disk");
        assert_eq!(
            plan.download_overrides.get(&0).unwrap(),
            "welcome (conflict objbbb).md"
        );
    }

    // F4 scope-hole, other direction: the freshly-pulled object WINS and the
    // map-only object loses → the on-disk loser is moved aside via a rename.
    #[test]
    fn collision_map_only_loser_is_renamed_on_disk() {
        // Map holds the loser Welcome.md (obj-bbb). The pull brings welcome.md
        // (obj-aaa) which wins (smaller object_id).
        let dl = vec![dnote("obj-aaa", "welcome.md")];
        let mut map = HashMap::new();
        map.insert("Welcome.md".to_owned(), map_entry_oid("obj-bbb"));
        let plan = resolve_pull_collisions(&dl, &map, &HashSet::new());
        assert!(plan.download_overrides.is_empty(), "winner download keeps its name");
        assert_eq!(plan.map_renames.len(), 1);
        let mv = &plan.map_renames[0];
        assert_eq!(mv.old_filename, "Welcome.md");
        // Conflict name derived from the WINNER's canonical name (welcome.md)
        // + the LOSER's object_id (obj-bbb).
        assert_eq!(mv.new_filename, "welcome (conflict objbbb).md");
    }

    // F5: NFC vs NFD spellings of the same accented name are distinct objects
    // that collapse to one file on APFS — must be detected as a collision.
    #[test]
    fn collision_nfc_vs_nfd_detected() {
        let nfc = "caf\u{00E9}.md";
        let nfd = "cafe\u{0301}.md";
        let dl = vec![dnote("obj-z", nfc), dnote("obj-a", nfd)];
        let plan = resolve_pull_collisions(&dl, &HashMap::new(), &HashSet::new());
        // obj-a wins (nfd, idx 1); obj-z parked.
        assert_eq!(plan.download_overrides.len(), 1);
        assert!(plan.download_overrides.contains_key(&0));
    }

    // OBJ-1 idempotency: the SAME object set yields the SAME placement on a
    // re-run, and bumping the winner's change_seq does NOT flip the winner.
    #[test]
    fn collision_is_idempotent_under_winner_edit() {
        let map = HashMap::new();
        let dl1 = vec![dnote("obj-aaa", "welcome.md"), dnote("obj-bbb", "Welcome.md")];
        let plan1 = resolve_pull_collisions(&dl1, &map, &HashSet::new());

        // Simulate a later cycle where the winner (obj-aaa) was edited: bump
        // its change_seq. The winner key is object_id, not change_seq, so the
        // placement must be byte-identical.
        let mut w = dnote("obj-aaa", "welcome.md");
        w.change_seq = 999;
        let dl2 = vec![w, dnote("obj-bbb", "Welcome.md")];
        let plan2 = resolve_pull_collisions(&dl2, &map, &HashSet::new());

        assert_eq!(plan1.download_overrides, plan2.download_overrides);
        // obj-aaa wins both times; obj-bbb (idx 1) is parked both times.
        assert_eq!(
            plan2.download_overrides.get(&1).unwrap(),
            "welcome (conflict objbbb).md"
        );
    }

    // OBJ-2 cross-client convergence: two clients with DIFFERENT local state
    // resolving the same collision mint the byte-identical loser name (it is a
    // pure function of the winner's canonical name + the loser's object_id,
    // independent of any per-client name set).
    #[test]
    fn collision_loser_name_is_client_independent() {
        // Client X: both objects arrive in one batch.
        let dl_x = vec![dnote("obj-aaa", "welcome.md"), dnote("obj-bbb", "Welcome.md")];
        let plan_x = resolve_pull_collisions(&dl_x, &HashMap::new(), &HashSet::new());

        // Client Y: the winner is already on disk (map-only); only the loser
        // arrives this cycle.
        let dl_y = vec![dnote("obj-bbb", "Welcome.md")];
        let mut map_y = HashMap::new();
        map_y.insert("welcome.md".to_owned(), map_entry_oid("obj-aaa"));
        let plan_y = resolve_pull_collisions(&dl_y, &map_y, &HashSet::new());

        // Both clients place obj-bbb at the identical conflict name.
        assert_eq!(
            plan_x.download_overrides.get(&1).unwrap(),
            plan_y.download_overrides.get(&0).unwrap(),
        );
        assert_eq!(
            plan_y.download_overrides.get(&0).unwrap(),
            "welcome (conflict objbbb).md"
        );
    }

    // Item 4: two DISTINCT live server objects share a filename AND have
    // IDENTICAL content (the crash-window orphan-object case: an
    // uploaded-but-unpersisted POST re-lists and collides with the re-POSTed
    // live entry). No `(conflict <oid>)` copy may be minted — the winner is the
    // sole canonical survivor and the identical loser is adopted silently. Red
    // before the fix: it produced a download_override for the loser.
    #[test]
    fn collision_identical_content_adopts_silently_no_conflict_copy() {
        let mut a = dnote("obj-aaa", "welcome.md");
        let mut b = dnote("obj-bbb", "welcome.md");
        // Byte-identical content on both objects → same hash.
        a.hash = "same-hash".to_owned();
        b.hash = "same-hash".to_owned();
        let dl = vec![a, b];
        let plan = resolve_pull_collisions(&dl, &HashMap::new(), &HashSet::new());

        // obj-aaa (idx 0) wins the canonical name; obj-bbb (idx 1) is the
        // identical loser → skipped, NOT parked at a conflict copy.
        assert!(
            plan.download_overrides.is_empty(),
            "no conflict copy for a byte-identical loser",
        );
        assert!(plan.map_renames.is_empty());
        assert_eq!(
            plan.download_skips.iter().copied().collect::<Vec<_>>(),
            vec![1],
            "the identical loser download is skipped (winner is the sole survivor)",
        );
    }

    // Item 4, map-only variant: the winner arrives in this pull, an
    // identical-content rival is already on disk (map-only). The stale on-disk
    // loser is dropped (winner is the sole survivor) — no conflict copy, and its
    // map entry is dropped so push never tombstones the still-live server object.
    #[test]
    fn collision_identical_map_only_loser_is_dropped_not_parked() {
        let mut d = dnote("obj-aaa", "welcome.md"); // winner (smaller object_id)
        d.hash = "same-hash".to_owned();
        let dl = vec![d];
        let mut map = HashMap::new();
        let mut loser = map_entry_oid("obj-bbb");
        loser.hash = Some("same-hash".to_owned());
        map.insert("Welcome.md".to_owned(), loser);

        let plan = resolve_pull_collisions(&dl, &map, &HashSet::new());

        assert!(plan.download_overrides.is_empty());
        assert!(plan.map_renames.is_empty(), "no conflict-copy rename for identical content");
        assert_eq!(
            plan.identical_map_drops,
            vec!["Welcome.md".to_owned()],
            "the identical map-only loser is dropped, winner survives",
        );
    }

    // A downloaded object that is simply the new version of an already-mapped
    // object (same object_id) is NOT a self-collision.
    #[test]
    fn collision_same_object_id_is_not_a_collision() {
        let dl = vec![dnote("obj-aaa", "welcome.md")];
        let mut map = HashMap::new();
        // Same object_id, prior name — this is the prior state of the download.
        map.insert("welcome.md".to_owned(), map_entry_oid("obj-aaa"));
        let plan = resolve_pull_collisions(&dl, &map, &HashSet::new());
        assert!(plan.download_overrides.is_empty());
        assert!(plan.map_renames.is_empty());
    }

    // No collision when keys genuinely differ.
    #[test]
    fn collision_distinct_names_no_action() {
        let dl = vec![dnote("obj-aaa", "alpha.md"), dnote("obj-bbb", "beta.md")];
        let plan = resolve_pull_collisions(&dl, &HashMap::new(), &HashSet::new());
        assert!(plan.download_overrides.is_empty());
        assert!(plan.map_renames.is_empty());
    }

    // Tombstoned filenames don't participate (a deleted file isn't a rival).
    #[test]
    fn collision_ignores_tombstoned_map_entry() {
        let dl = vec![dnote("obj-bbb", "Welcome.md")];
        let mut map = HashMap::new();
        map.insert("welcome.md".to_owned(), map_entry_oid("obj-aaa"));
        let mut tomb = HashSet::new();
        tomb.insert("welcome.md".to_owned());
        let plan = resolve_pull_collisions(&dl, &map, &tomb);
        // The map rival is being deleted, so no collision remains.
        assert!(plan.download_overrides.is_empty());
        assert!(plan.map_renames.is_empty());
    }

    // ── Oversize blob (HTTP 413) on the CONFLICT-RESOLUTION path ──────────
    //
    // Regression for the gap left by commit a9a2c7a: the 413 surface/skip
    // handling covered only push_one_file's two upload sites and MISSED the
    // two upload sites inside resolve_update_conflict. An oversize CONFLICTED
    // note flattened its 413 through `.map_err(http_err_to_string)?` into a
    // generic Err — never surfaced (conflicts not incremented), never marked
    // oversize_skip, and so re-encrypted + re-uploaded every cycle forever.
    //
    // These drive resolve_update_conflict directly (the function push_one_file
    // calls on a PUT 409) with a wiremock server that 413s the re-upload, and
    // assert it returns PushOutcome::TooLarge — the variant run_push's existing
    // handler turns into `conflicts += 1` + `oversize_skip.insert(...)`.

    use wiremock::matchers::{method as wm_method, path as wm_path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const TEST_VAULT_KEY: [u8; KEY_BYTES] = [7u8; KEY_BYTES];

    fn test_client(server: &MockServer) -> Arc<E2eeClient> {
        let mut c = E2eeClient::new(&server.uri()).unwrap();
        c.set_token("test-token");
        Arc::new(c)
    }

    /// Encrypt a note exactly the way the orchestrator does, so the
    /// conflict-resolution decrypt/unpack round-trips when served as a blob.
    async fn enc(filename: &str, content: &str) -> Vec<u8> {
        encrypt_note(&TEST_VAULT_KEY, filename, content).await.unwrap()
    }

    fn map_entry_for(object_id: &str, version: u64, blob_key: &str) -> E2eeObjectMapEntry {
        E2eeObjectMapEntry {
            object_id: object_id.to_owned(),
            version,
            blob_key: blob_key.to_owned(),
            hash: None,
            mtime_ms: None,
            size_bytes: None,
        }
    }

    fn connected_state(server: &MockServer) -> ConnectedState {
        ConnectedState {
            base_url: server.uri(),
            token: "test-token".into(),
            user_id: "u1".into(),
            collection_id: "c1".into(),
            vault_key: TEST_VAULT_KEY,
            object_map: HashMap::new(),
            max_version: 0,
            pull_cursor: 0,
            oversize_skip: HashMap::new(),
        }
    }

    fn no_prog(_p: SyncProgress) {}
    fn no_pre(_f: &str) {}

    /// Encode one batch-response frame, mirroring the server's encodeFrame.
    fn batch_frame(key: &str, status: u8, blob: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&(key.len() as u16).to_be_bytes());
        out.extend_from_slice(key.as_bytes());
        out.push(status);
        out.extend_from_slice(&(blob.len() as u32).to_be_bytes());
        out.extend_from_slice(blob);
        out
    }

    fn wire_object(id: &str, change_seq: u64, size_bytes: Option<u64>) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "collection_id": "c1",
            "version": 1,
            "change_seq": change_seq,
            "deleted": false,
            "blob_key": format!("bk-{id}"),
            "size_bytes": size_bytes,
            "created_at": "2026-05-13T00:00:00.000Z",
            "updated_at": "2026-05-13T00:00:00.000Z",
        })
    }

    // Full pull through the batch endpoint: sized objects pack into one
    // batch request; both notes land and the cursor advances. No per-blob
    // GET mock is mounted, so any fallback would fail the assertions.
    #[tokio::test]
    async fn run_pull_lands_notes_via_batch_endpoint() {
        let server = MockServer::start().await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/collections/c1/objects"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "objects": [wire_object("o1", 1, Some(64)), wire_object("o2", 2, Some(64))]
            })))
            .mount(&server)
            .await;
        let mut body = batch_frame("bk-o1", 0, &enc("one.md", "alpha\n").await);
        body.extend(batch_frame("bk-o2", 0, &enc("two.md", "beta\n").await));
        Mock::given(wm_method("POST"))
            .and(wm_path("/api/blobs/batch"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(body))
            .mount(&server)
            .await;

        let root = temp_root();
        let state = connected_state(&server);
        let (summary, next) = run_pull(&state, &root, 0, &no_prog, &no_pre)
            .await
            .expect("pull");

        assert_eq!(summary.downloaded, 2);
        // Every downloaded blob is a local disk write — the native reload
        // signal must reflect it (F2).
        assert_eq!(summary.local_writes_applied, 2);
        assert!(summary.failures.is_empty());
        assert_eq!(next.max_version, 2);
        assert_eq!(std::fs::read_to_string(root.join("one.md")).unwrap(), "alpha\n");
        assert_eq!(std::fs::read_to_string(root.join("two.md")).unwrap(), "beta\n");
    }

    // F7 migration: a server listing that includes a legacy `.tiff` blob (an
    // older client uploaded it before D4 narrowed IMAGE_EXTENSIONS to 10). The
    // pull must land the valid note and IGNORE the legacy blob — never write it
    // as a note, never record a failure, never tombstone it, never error the
    // cycle. Guards `is_syncable_filename` in run_pull's downloaded loop.
    #[tokio::test]
    async fn run_pull_ignores_legacy_image_blob() {
        let server = MockServer::start().await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/collections/c1/objects"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "objects": [wire_object("o1", 1, Some(64)), wire_object("o2", 2, Some(64))]
            })))
            .mount(&server)
            .await;
        let mut body = batch_frame("bk-o1", 0, &enc("one.md", "alpha\n").await);
        // Legacy image blob: an older client's `.tiff`, no longer syncable.
        body.extend(batch_frame("bk-o2", 0, &enc("scan.tiff", "AAAA").await));
        Mock::given(wm_method("POST"))
            .and(wm_path("/api/blobs/batch"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(body))
            .mount(&server)
            .await;

        let root = temp_root();
        let state = connected_state(&server);
        let (summary, next) = run_pull(&state, &root, 0, &no_prog, &no_pre)
            .await
            .expect("pull must not error on a legacy image blob");

        assert_eq!(std::fs::read_to_string(root.join("one.md")).unwrap(), "alpha\n");
        assert!(!root.join("scan.tiff").exists(), "legacy blob must not be written");
        assert!(
            summary.failures.is_empty(),
            "a legacy blob is an expected migration state, not a failure"
        );
        assert_eq!(summary.deleted, 0, "legacy blob must not be tombstoned");
        assert!(
            !next.object_map.contains_key("scan.tiff"),
            "legacy blob must not enter the map"
        );
        // Cursor still advances past the ignored object.
        assert_eq!(next.max_version, 2);
        std::fs::remove_dir_all(&root).ok();
    }

    // B2a: a peer pushes a name local creation legitimately produces on
    // macOS/Linux but Windows can't hold (a reserved device name). The pull
    // HEALS it — writes it under the safe `sanitize_title`-equivalent name,
    // maps the object there, and records NO failure — so the note is never
    // dropped and the healed name is legal on every platform.
    #[tokio::test]
    async fn run_pull_heals_creatable_but_unsyncable_name() {
        let server = MockServer::start().await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/collections/c1/objects"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "objects": [wire_object("o1", 1, Some(64)), wire_object("o2", 2, Some(64))]
            })))
            .mount(&server)
            .await;
        let mut body = batch_frame("bk-o1", 0, &enc("good.md", "alpha\n").await);
        body.extend(batch_frame("bk-o2", 0, &enc("CON.md", "device\n").await));
        Mock::given(wm_method("POST"))
            .and(wm_path("/api/blobs/batch"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(body))
            .mount(&server)
            .await;

        let root = temp_root();
        let state = connected_state(&server);
        let (summary, next) = run_pull(&state, &root, 0, &no_prog, &no_pre)
            .await
            .expect("pull must heal, not error");

        assert_eq!(std::fs::read_to_string(root.join("good.md")).unwrap(), "alpha\n");
        assert_eq!(
            std::fs::read_to_string(root.join("CON_.md")).unwrap(),
            "device\n",
            "reserved name healed to CON_.md"
        );
        assert!(!root.join("CON.md").exists(), "raw reserved name never written");
        assert!(next.object_map.contains_key("CON_.md"), "healed name is mapped");
        assert!(!next.object_map.contains_key("CON.md"));
        assert!(summary.failures.is_empty(), "a heal is not a failure");
        assert_eq!(summary.deleted, 0);
        std::fs::remove_dir_all(&root).ok();
    }

    // B2a idempotency: a second pull of the SAME healed object does not
    // re-download, re-write, or re-mint — the map already points the object at
    // its healed name, so it is skipped in `first_pass`.
    #[tokio::test]
    async fn run_pull_heal_is_idempotent_across_cycles() {
        let server = MockServer::start().await;
        // Unknown size (None) → the singleton takes the classic per-blob GET.
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/collections/c1/objects"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "objects": [wire_object("o2", 2, None)]
            })))
            .mount(&server)
            .await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/blobs/bk-o2"))
            .respond_with(
                ResponseTemplate::new(200).set_body_bytes(enc("CON.md", "device\n").await),
            )
            .mount(&server)
            .await;

        let root = temp_root();
        let state = connected_state(&server);
        let (_s1, next1) = run_pull(&state, &root, 0, &no_prog, &no_pre).await.expect("pull 1");
        assert!(root.join("CON_.md").exists());
        // Second pull from the advanced cursor with the healed map: nothing new.
        let (s2, next2) = run_pull(&next1, &root, 0, &no_prog, &no_pre).await.expect("pull 2");
        assert_eq!(s2.downloaded, 0, "healed object is not re-downloaded");
        assert!(s2.failures.is_empty());
        assert_eq!(next2.object_map.len(), 1);
        assert!(next2.object_map.contains_key("CON_.md"));
        assert!(!root.join("CON.md").exists());
        std::fs::remove_dir_all(&root).ok();
    }

    // A structurally-unsafe incoming name (a buggy/older peer only — local
    // creation could never mint traversal) is REJECTED: skipped, never written,
    // surfaced as a permanent `Rejected` failure (not the retryable `Download`),
    // and the valid sibling still lands without aborting the cycle.
    #[tokio::test]
    async fn run_pull_rejects_structurally_unsafe_name() {
        let server = MockServer::start().await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/collections/c1/objects"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "objects": [wire_object("o1", 1, Some(64)), wire_object("o2", 2, Some(64))]
            })))
            .mount(&server)
            .await;
        let mut body = batch_frame("bk-o1", 0, &enc("good.md", "alpha\n").await);
        body.extend(batch_frame("bk-o2", 0, &enc("../escape.md", "evil\n").await));
        Mock::given(wm_method("POST"))
            .and(wm_path("/api/blobs/batch"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(body))
            .mount(&server)
            .await;

        let root = temp_root();
        let state = connected_state(&server);
        let (summary, next) = run_pull(&state, &root, 0, &no_prog, &no_pre)
            .await
            .expect("pull must not error on an unsafe incoming name");

        assert_eq!(std::fs::read_to_string(root.join("good.md")).unwrap(), "alpha\n");
        assert!(!root.join("escape.md").exists());
        assert_eq!(summary.failures.len(), 1, "the unsafe name surfaces once");
        assert_eq!(summary.failures[0].kind, FailureKind::Rejected);
        assert_eq!(summary.deleted, 0, "unsafe name must not be tombstoned");
        // Rejected → the honest message must NOT promise a retry.
        let msg = summary.failure_message().unwrap();
        assert!(msg.contains("skipped") && !msg.contains("will retry"), "msg: {msg}");
        std::fs::remove_dir_all(&root).ok();
    }

    // B4: two incoming objects whose names HEAL to the same on-disk name reach
    // collision planning AFTER healing (triage runs first), so they resolve as
    // a normal collision — winner keeps the canonical name, loser is parked at
    // a conflict copy — and NEITHER note is dropped.
    #[tokio::test]
    async fn run_pull_healed_names_collide_and_both_survive() {
        let server = MockServer::start().await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/collections/c1/objects"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "objects": [wire_object("o1", 1, Some(64)), wire_object("o2", 2, Some(64))]
            })))
            .mount(&server)
            .await;
        // o1 = clean "note.md"; o2 = "note .md" (trailing space heals to note.md).
        let mut body = batch_frame("bk-o1", 0, &enc("note.md", "clean\n").await);
        body.extend(batch_frame("bk-o2", 0, &enc("note .md", "healed\n").await));
        Mock::given(wm_method("POST"))
            .and(wm_path("/api/blobs/batch"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(body))
            .mount(&server)
            .await;

        let root = temp_root();
        let state = connected_state(&server);
        let (summary, _next) = run_pull(&state, &root, 0, &no_prog, &no_pre)
            .await
            .expect("pull");

        assert!(summary.failures.is_empty());
        // Both notes survive on disk: the canonical winner + one conflict copy,
        // carrying both contents. Neither was dropped.
        let md: Vec<_> = std::fs::read_dir(&root)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".md"))
            .collect();
        assert_eq!(md.len(), 2, "winner + parked loser, got {md:?}");
        assert!(root.join("note.md").exists(), "canonical winner kept");
        let contents: std::collections::HashSet<String> = md
            .iter()
            .map(|n| std::fs::read_to_string(root.join(n)).unwrap())
            .collect();
        assert!(contents.contains("clean\n") && contents.contains("healed\n"));
        std::fs::remove_dir_all(&root).ok();
    }

    // B1: a fresh device (empty map, cursor 0 → reconcile path) pulls a listing
    // with a valid note + a reserved name + a legacy .tiff + a traversal name.
    // The valid note lands, the reserved name heals, the legacy blob is ignored,
    // the traversal name is rejected — none phantom-mapped or counted — and the
    // cycle completes with the cursor advanced past every object.
    #[tokio::test]
    async fn reconcile_empty_map_heals_ignores_and_rejects() {
        let server = MockServer::start().await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/collections/c1/objects"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "objects": [
                    wire_object("o1", 1, Some(64)),
                    wire_object("o2", 2, Some(64)),
                    wire_object("o3", 3, Some(64)),
                    wire_object("o4", 4, Some(64)),
                ]
            })))
            .mount(&server)
            .await;
        let mut body = batch_frame("bk-o1", 0, &enc("good.md", "a1\n").await);
        body.extend(batch_frame("bk-o2", 0, &enc("CON.md", "a2\n").await));
        body.extend(batch_frame("bk-o3", 0, &enc("scan.tiff", "AAAA").await));
        body.extend(batch_frame("bk-o4", 0, &enc("../evil.md", "a4\n").await));
        Mock::given(wm_method("POST"))
            .and(wm_path("/api/blobs/batch"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(body))
            .mount(&server)
            .await;

        let root = temp_root();
        let state = connected_state(&server);
        let (summary, next) = reconcile_empty_map(&state, &root, &no_prog, &no_pre)
            .await
            .expect("reconcile must complete over an unsafe listing");

        assert_eq!(std::fs::read_to_string(root.join("good.md")).unwrap(), "a1\n");
        assert_eq!(
            std::fs::read_to_string(root.join("CON_.md")).unwrap(),
            "a2\n",
            "reserved name healed"
        );
        assert!(!root.join("CON.md").exists());
        assert!(!root.join("scan.tiff").exists(), "legacy blob ignored");
        assert!(!root.join("evil.md").exists() && !root.join("../evil.md").exists());
        // Map holds only the two materialized notes — no phantom legacy entry.
        assert!(next.object_map.contains_key("good.md"));
        assert!(next.object_map.contains_key("CON_.md"));
        assert!(!next.object_map.contains_key("scan.tiff"));
        assert!(!next.object_map.contains_key("CON.md"));
        assert_eq!(next.object_map.len(), 2);
        // Count reflects only materialized notes (aligned with run_pull).
        assert_eq!(summary.downloaded, 2);
        // The traversal name surfaces as one permanent rejection.
        assert_eq!(summary.failures.len(), 1);
        assert_eq!(summary.failures[0].kind, FailureKind::Rejected);
        // Cursor advanced past every object, including the ignored/rejected ones.
        assert_eq!(next.max_version, 4);
        std::fs::remove_dir_all(&root).ok();
    }

    // B5: the edit-wins delete restore writes a PEER-CONTROLLED filename. A
    // hostile restored name (traversal) is refused — never written, surfaced as
    // a rejection — and the push completes without aborting.
    #[tokio::test]
    async fn run_push_rejects_hostile_restored_filename() {
        let server = MockServer::start().await;
        // DELETE of our locally-gone note 409s (a peer edited it); the restore
        // then fetches the peer's current blob, whose decrypted path is hostile.
        Mock::given(wm_method("DELETE"))
            .and(wm_path("/api/collections/c1/objects/og"))
            .respond_with(ResponseTemplate::new(409).set_body_json(serde_json::json!({
                "error": "conflict",
                "currentVersion": 2,
                "currentBlobKey": "bk-restored"
            })))
            .mount(&server)
            .await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/blobs/bk-restored"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_bytes(enc("../evil.md", "hostile\n").await),
            )
            .mount(&server)
            .await;

        let root = temp_root();
        let mut state = connected_state(&server);
        // A note present in the map but absent on disk → a delete candidate.
        state.object_map.insert(
            "gone.md".to_owned(),
            E2eeObjectMapEntry {
                object_id: "og".to_owned(),
                version: 1,
                blob_key: "bk-gone".to_owned(),
                hash: Some("h".to_owned()),
                mtime_ms: Some(1),
                size_bytes: Some(1),
            },
        );

        let (summary, _next) = run_push(&state, &root, &no_prog, &no_pre)
            .await
            .expect("push must not abort on a hostile restored name");

        assert!(!root.join("evil.md").exists(), "hostile restore never written");
        assert!(
            summary.failures.iter().any(|f| f.kind == FailureKind::Rejected),
            "hostile restore surfaces as a rejection: {:?}",
            summary.failures
        );
        // C2: the stale map entry for the locally-deleted note is dropped, so
        // the cycle converges — a second push does NOT re-plan the delete.
        assert!(
            !_next.object_map.contains_key("gone.md"),
            "rejected restore must drop the stale map entry so the delete isn't re-attempted"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    // C1 (data loss): a delete-vs-edit restore whose name HEALS onto an
    // unrelated existing note must NOT overwrite it. The healed restore is
    // parked at a conflict copy; the existing note keeps its name + content +
    // map entry, and both survive.
    #[tokio::test]
    async fn run_push_heal_restore_parks_on_collision_with_unrelated_note() {
        let server = MockServer::start().await;
        // Deleting object oB 409s; its peer edit's path "note .md" heals to
        // "note.md" — the name an UNRELATED live note (oA) already holds.
        Mock::given(wm_method("DELETE"))
            .and(wm_path("/api/collections/c1/objects/oB"))
            .respond_with(ResponseTemplate::new(409).set_body_json(serde_json::json!({
                "error": "conflict",
                "currentVersion": 2,
                "currentBlobKey": "bk-b"
            })))
            .mount(&server)
            .await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/blobs/bk-b"))
            .respond_with(
                ResponseTemplate::new(200).set_body_bytes(enc("note .md", "restored\n").await),
            )
            .mount(&server)
            .await;

        let root = temp_root();
        std::fs::write(root.join("note.md"), "original\n").unwrap();
        let meta = std::fs::metadata(root.join("note.md")).unwrap();
        let mut state = connected_state(&server);
        // oA: the unrelated live note, fast-pathed (matches disk → not a push
        // candidate).
        state.object_map.insert(
            "note.md".to_owned(),
            E2eeObjectMapEntry {
                object_id: "oA".to_owned(),
                version: 1,
                blob_key: "bk-a".to_owned(),
                hash: Some(hash_sha256("original\n")),
                mtime_ms: Some(file_mtime_ms(&meta)),
                size_bytes: Some(meta.len()),
            },
        );
        // oB: locally-deleted note (in map, absent on disk) → a delete candidate.
        state.object_map.insert(
            "note .md".to_owned(),
            E2eeObjectMapEntry {
                object_id: "oB".to_owned(),
                version: 1,
                blob_key: "bk-b-old".to_owned(),
                hash: Some("h".to_owned()),
                mtime_ms: Some(1),
                size_bytes: Some(1),
            },
        );

        let (_summary, next) = run_push(&state, &root, &no_prog, &no_pre)
            .await
            .expect("push");

        // The unrelated note survives untouched, in place and in the map.
        assert_eq!(
            std::fs::read_to_string(root.join("note.md")).unwrap(),
            "original\n",
            "unrelated note must not be overwritten"
        );
        assert_eq!(next.object_map.get("note.md").unwrap().object_id, "oA");
        // The restore landed at a conflict copy carrying its own content.
        let parked: Vec<_> = std::fs::read_dir(&root)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".md") && n != "note.md")
            .collect();
        assert_eq!(parked.len(), 1, "restore parked at a conflict copy: {parked:?}");
        assert_eq!(
            std::fs::read_to_string(root.join(&parked[0])).unwrap(),
            "restored\n"
        );
        assert_eq!(next.object_map.get(&parked[0]).unwrap().object_id, "oB");
        std::fs::remove_dir_all(&root).ok();
    }

    // Old server: the batch endpoint 404s → the pull degrades to per-blob
    // GETs and still lands everything (compat path).
    #[tokio::test]
    async fn run_pull_falls_back_to_per_blob_when_batch_unsupported() {
        let server = MockServer::start().await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/collections/c1/objects"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "objects": [wire_object("o1", 1, Some(64)), wire_object("o2", 2, Some(64))]
            })))
            .mount(&server)
            .await;
        Mock::given(wm_method("POST"))
            .and(wm_path("/api/blobs/batch"))
            .respond_with(ResponseTemplate::new(404).set_body_string("not found"))
            .mount(&server)
            .await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/blobs/bk-o1"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(enc("one.md", "alpha\n").await))
            .mount(&server)
            .await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/blobs/bk-o2"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(enc("two.md", "beta\n").await))
            .mount(&server)
            .await;

        let root = temp_root();
        let state = connected_state(&server);
        let (summary, next) = run_pull(&state, &root, 0, &no_prog, &no_pre)
            .await
            .expect("pull");

        assert_eq!(summary.downloaded, 2);
        assert!(summary.failures.is_empty());
        assert_eq!(next.max_version, 2);
        assert!(root.join("one.md").exists() && root.join("two.md").exists());
    }

    // Issue #11 end-to-end: a failed blob download surfaces a SyncFailure AND
    // holds the cursor below the failed change_seq, so the NEXT pull re-lists
    // and lands it. (Objects carry no size hint → per-blob path, so the test
    // isn't slowed by the batch retry ladder's backoff.)
    #[tokio::test]
    async fn run_pull_caps_cursor_on_failed_download_and_retries_next_pull() {
        let server = MockServer::start().await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/collections/c1/objects"))
            .and(query_param("sinceVersion", "0"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "objects": [wire_object("o1", 5, None), wire_object("o2", 9, None)]
            })))
            .mount(&server)
            .await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/blobs/bk-o1"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(enc("one.md", "alpha\n").await))
            .mount(&server)
            .await;
        // First attempt at o2's blob: 500. (Consumed once, then the healthy
        // mock below takes over for the second pull.)
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/blobs/bk-o2"))
            .respond_with(ResponseTemplate::new(500).set_body_string("boom"))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/blobs/bk-o2"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(enc("two.md", "beta\n").await))
            .mount(&server)
            .await;
        // Second pull re-lists from the capped cursor (8) → only o2 remains.
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/collections/c1/objects"))
            .and(query_param("sinceVersion", "8"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "objects": [wire_object("o2", 9, None)]
            })))
            .mount(&server)
            .await;

        let root = temp_root();
        let state = connected_state(&server);
        let (summary, next) = run_pull(&state, &root, 0, &no_prog, &no_pre)
            .await
            .expect("first pull");

        // o1 landed; o2 failed, surfaced, and capped the cursor at 8 (not 9).
        assert_eq!(summary.downloaded, 1);
        assert_eq!(summary.failures.len(), 1);
        assert_eq!(summary.failures[0].kind, FailureKind::Download);
        assert_eq!(summary.failures[0].status_code, Some(500));
        assert_eq!(next.max_version, 8, "cursor must stop below the failed change_seq");
        assert!(!root.join("two.md").exists());

        let (summary2, next2) = run_pull(&next, &root, next.max_version, &no_prog, &no_pre)
            .await
            .expect("second pull");
        assert_eq!(summary2.downloaded, 1, "failed object must be retried and land");
        assert!(summary2.failures.is_empty());
        assert_eq!(next2.max_version, 9);
        assert_eq!(std::fs::read_to_string(root.join("two.md")).unwrap(), "beta\n");
    }

    // Issue #11, reconcile flavor: reconcile computes its max from
    // SUCCESSFUL downloads, so a failed object whose change_seq sits BELOW a
    // succeeded one would be jumped without the cap and never re-listed.
    #[tokio::test]
    async fn reconcile_caps_cursor_when_failed_seq_below_succeeded() {
        let server = MockServer::start().await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/collections/c1/objects"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                // o1 (seq 5) fails; o2 (seq 9) succeeds.
                "objects": [wire_object("o1", 5, None), wire_object("o2", 9, None)]
            })))
            .mount(&server)
            .await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/blobs/bk-o1"))
            .respond_with(ResponseTemplate::new(500).set_body_string("boom"))
            .mount(&server)
            .await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/blobs/bk-o2"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(enc("two.md", "beta\n").await))
            .mount(&server)
            .await;

        let root = temp_root();
        let state = connected_state(&server);
        let (summary, next) = reconcile_empty_map(&state, &root, &no_prog, &no_pre)
            .await
            .expect("reconcile");

        assert_eq!(summary.downloaded, 1);
        // The single adoption is a local disk write (F2).
        assert_eq!(summary.local_writes_applied, 1);
        assert_eq!(summary.failures.len(), 1);
        assert_eq!(summary.failures[0].kind, FailureKind::Download);
        assert_eq!(
            next.max_version, 4,
            "cursor must hold below the failed seq 5 even though seq 9 landed"
        );
        assert!(root.join("two.md").exists());
    }

    // Regression: the cap must WIN over the state's incoming cursor. In
    // run_sync the pull's state arrives from run_push, whose own uploads
    // already advanced max_version (here simulated as 6, e.g. our upload's
    // change_seq) past a peer object at seq 5 whose blob fails. The old
    // `.max(state)` merge persisted 6 → seq 5 was never re-listed and never
    // landed, exactly the issue-#11 bug, now behind "will retry" wording.
    #[tokio::test]
    async fn run_pull_cap_wins_when_push_already_advanced_cursor() {
        let server = MockServer::start().await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/collections/c1/objects"))
            .and(query_param("sinceVersion", "4"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "objects": [wire_object("o1", 5, None)]
            })))
            .mount(&server)
            .await;
        // First attempt fails; the second pull's attempt succeeds.
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/blobs/bk-o1"))
            .respond_with(ResponseTemplate::new(500).set_body_string("boom"))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/blobs/bk-o1"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(enc("one.md", "alpha\n").await))
            .mount(&server)
            .await;

        let root = temp_root();
        let mut state = connected_state(&server);
        state.max_version = 6; // push already advanced the cursor past seq 5

        let (summary, next) = run_pull(&state, &root, 4, &no_prog, &no_pre)
            .await
            .expect("first pull");
        assert_eq!(summary.failures.len(), 1);
        assert_eq!(
            next.max_version, 4,
            "cap must override the push-advanced cursor, not merge with it"
        );

        // Next cycle re-lists from 4 → seq 5 is retried and lands.
        let (summary2, next2) = run_pull(&next, &root, 4, &no_prog, &no_pre)
            .await
            .expect("second pull");
        assert_eq!(summary2.downloaded, 1);
        assert!(summary2.failures.is_empty());
        // The clean pull rebuilds the cursor from what it listed (seq 5).
        // The push-advanced 6 stays overwritten — at worst the own seq-6
        // upload is re-listed once and skipped idempotently.
        assert_eq!(next2.max_version, 5, "clean pull advances past the recovered object");
        assert_eq!(std::fs::read_to_string(root.join("one.md")).unwrap(), "alpha\n");
    }

    // A non-retryable batch failure (401) must skip the whole-chunk retry
    // ladder — no 2.5s of backoff — and degrade straight to per-blob GETs.
    #[tokio::test]
    async fn batch_4xx_skips_retry_ladder_and_degrades_to_singles() {
        let server = MockServer::start().await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/collections/c1/objects"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "objects": [wire_object("o1", 1, Some(64)), wire_object("o2", 2, Some(64))]
            })))
            .mount(&server)
            .await;
        Mock::given(wm_method("POST"))
            .and(wm_path("/api/blobs/batch"))
            .respond_with(ResponseTemplate::new(401).set_body_string("unauthorized"))
            .mount(&server)
            .await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/blobs/bk-o1"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(enc("one.md", "alpha\n").await))
            .mount(&server)
            .await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/blobs/bk-o2"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(enc("two.md", "beta\n").await))
            .mount(&server)
            .await;

        let root = temp_root();
        let state = connected_state(&server);
        let started = std::time::Instant::now();
        let (summary, next) = run_pull(&state, &root, 0, &no_prog, &no_pre)
            .await
            .expect("pull");

        assert_eq!(summary.downloaded, 2);
        assert!(summary.failures.is_empty());
        assert_eq!(next.max_version, 2);
        assert!(
            started.elapsed() < std::time::Duration::from_millis(2000),
            "401 must not burn the retry ladder's backoff (took {:?})",
            started.elapsed()
        );
    }

    // Two objects sharing one blob_key (shouldn't happen — server keys are
    // uuids, so this is defensive): the rejoin keeps one on the batch path
    // and degrades the other to a per-blob single instead of silently
    // dropping it — a dropped object would advance the cursor past it
    // (issue-#11 shape). The duplicate frame in the response must not
    // double-download the winner.
    #[tokio::test]
    async fn batch_duplicate_blob_key_degrades_loser_to_single() {
        let server = MockServer::start().await;
        let ciphertext = enc("dup.md", "hello\n").await;
        // The request carries the key twice, so the server (one frame per
        // requested key, in order) answers with two identical frames.
        let mut body = batch_frame("bk-dup", 0, &ciphertext);
        body.extend(batch_frame("bk-dup", 0, &ciphertext));
        Mock::given(wm_method("POST"))
            .and(wm_path("/api/blobs/batch"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(body))
            .mount(&server)
            .await;

        let mut a = server_object("o1", 1, 1, false, Some("bk-dup"));
        a.size_bytes = Some(64);
        let mut b = server_object("o2", 1, 2, false, Some("bk-dup"));
        b.size_bytes = Some(64);

        let http = Arc::new(build_client(&connected_state(&server)).expect("client"));
        let res = run_batch_job(
            http,
            Arc::new(TEST_VAULT_KEY),
            vec![a, b],
            Arc::new(AtomicBool::new(false)),
        )
        .await;

        assert_eq!(res.downloaded.len(), 1, "winner decrypts exactly once");
        assert_eq!(res.retry_as_singles.len(), 1, "loser degrades to per-blob");
        assert!(res.failed.is_empty());
        let ids: HashSet<&str> = res
            .downloaded
            .iter()
            .map(|d| d.object_id.as_str())
            .chain(res.retry_as_singles.iter().map(|o| o.id.as_str()))
            .collect();
        assert_eq!(ids.len(), 2, "both objects accounted for, neither dropped");
    }

    // ── F1: empty-map reconcile honors peer tombstones ──────────────────
    //
    // Seed an ancestry file (the disconnect artifact) that records a note this
    // device last synced as object `o1`, drop it out of the live object map to
    // mimic a reconnect, and have the server return a TOMBSTONE for `o1`.

    /// Write `.e2ee-ancestry.json` the way a disconnect would: persist a state
    /// with the given map, then demote it to ancestry.
    fn seed_ancestry(root: &Path, filename: &str, object_id: &str, content: &str) {
        let mut map = HashMap::new();
        map.insert(
            filename.to_owned(),
            E2eeObjectMapEntry {
                object_id: object_id.to_owned(),
                version: 1,
                blob_key: format!("bk-{object_id}"),
                hash: Some(hash_sha256(content)),
                mtime_ms: None,
                size_bytes: None,
            },
        );
        state::persist(root, &map, 1, 1, "c1").unwrap();
        state::demote_state_to_ancestry(root).unwrap();
    }

    // F1 (the resurrection bug): A pushed a note then disconnected (state
    // demoted to ancestry). A peer deleted it (server tombstone). On reconnect
    // the empty-map reconcile must DELETE the local copy — not drop the
    // tombstone and let run_push re-POST it, resurrecting the note fleet-wide.
    #[tokio::test]
    async fn reconcile_honors_peer_tombstone_deletes_unchanged_local() {
        let server = MockServer::start().await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/collections/c1/objects"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "objects": [{
                    "id": "o1",
                    "collection_id": "c1",
                    "version": 2,
                    "change_seq": 5,
                    "deleted": true,
                    "blob_key": null,
                    "size_bytes": null,
                    "created_at": "2026-07-10T00:00:00.000Z",
                    "updated_at": "2026-07-10T00:00:00.000Z"
                }]
            })))
            .mount(&server)
            .await;

        let root = temp_root();
        std::fs::write(root.join("doomed.md"), "# Doomed").unwrap();
        seed_ancestry(&root, "doomed.md", "o1", "# Doomed");

        let state = connected_state(&server); // empty map, max_version 0
        let (summary, next) = reconcile_empty_map(&state, &root, &no_prog, &no_pre)
            .await
            .expect("reconcile");

        assert!(
            !root.join("doomed.md").exists(),
            "a peer-deleted note must be removed on reconnect, not resurrected",
        );
        assert_eq!(summary.deleted, 1, "the tombstone delete must be surfaced");
        assert!(
            summary.deleted_ids.contains(&"doomed".to_owned()),
            "deleted_ids must carry the note so the rescan gate fires, got {:?}",
            summary.deleted_ids,
        );
        assert!(
            !next.object_map.contains_key("doomed.md"),
            "the deleted note must NOT be in the map (would re-POST as a new object)",
        );
    }

    // PKT-17 (user-visible regression): a pre-port vault carries its E2EE
    // object map in `.app-state.json` (tagged with `e2eeCollectionId`). A note
    // edited OFFLINE before the port must, on first connect+sync, land as a
    // CLEAN UPDATE to the existing server object — same object_id, PUT at the
    // next version — not a conflict copy and not a version fork.
    //
    // Before the fix, `import_legacy_state` tagged the imported state with
    // `collection_id: None`, so `load_for_collection` reset the map to empty;
    // `run_sync` then took the empty-map reconcile path and POSTed the edit as
    // a brand-new object (no PUT mock is mounted here, so that POST would 404
    // and leave `note.md` out of the map entirely — the assertion below fails).
    #[tokio::test]
    async fn legacy_import_offline_edit_lands_as_clean_update() {
        let server = MockServer::start().await;

        // The pull phase (run after push) lists peer changes since our cursor;
        // there are none.
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/collections/c1/objects"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "objects": []
            })))
            .mount(&server)
            .await;
        // The clean update: PUT onto the EXISTING object o9 succeeds at v5.
        Mock::given(wm_method("PUT"))
            .and(wm_path("/api/collections/c1/blob-objects/o9"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "object": {
                    "id": "o9", "version": 5, "change_seq": 8,
                    "updated_at": "2026-07-12T00:00:00.000Z",
                    "blob_key": "bk-o9-v5", "deleted": false
                },
                "collectionVersion": 8
            })))
            .expect(1)
            .mount(&server)
            .await;

        let root = temp_root();
        // The pre-port state file: object map tagged with the collection the
        // vault synced to, plus a stale hash so the offline edit reads dirty.
        std::fs::write(
            root.join(".app-state.json"),
            r#"{
                "e2eeCollectionId": "c1",
                "e2eeMaxVersion": 7,
                "e2eeObjectMap": {
                    "note.md": {"objectId":"o9","version":4,"blobKey":"bk-o9-v4","hash":"stale-pre-edit-hash","mtimeMs":1700000000000,"sizeBytes":5}
                }
            }"#,
        )
        .unwrap();
        // The offline edit on disk (content differs from the recorded hash).
        std::fs::write(root.join("note.md"), "edited while offline before the port\n").unwrap();

        // Exactly what connect/resume do: load the persisted map for the
        // collection we're connecting to.
        let loaded = state::load_for_collection(&root, "c1");
        assert!(
            loaded.object_map.contains_key("note.md"),
            "precondition: the legacy import must survive load_for_collection",
        );
        let state = ConnectedState {
            base_url: server.uri(),
            token: "test-token".into(),
            user_id: "u1".into(),
            collection_id: "c1".into(),
            vault_key: TEST_VAULT_KEY,
            object_map: loaded.object_map,
            max_version: loaded.max_version,
            pull_cursor: loaded.pull_cursor,
            oversize_skip: HashMap::new(),
        };

        let (summary, next) = run_sync(&state, &root, &no_prog, &no_pre)
            .await
            .expect("first connect+sync");

        assert_eq!(summary.uploaded, 1, "the offline edit uploads exactly once");
        assert_eq!(summary.conflicts, 0, "a clean update must not park a conflict copy");
        assert!(summary.failures.is_empty(), "no push/pull failures: {:?}", summary.failures);

        // Same object, next version — no fork.
        let entry = next
            .object_map
            .get("note.md")
            .expect("note.md must map to the existing object after a clean update");
        assert_eq!(entry.object_id, "o9", "must update the EXISTING object, not mint a new one");
        assert_eq!(entry.version, 5, "PUT advanced the object to v5");

        // No conflict copy was written to disk.
        let has_conflict_copy = std::fs::read_dir(&root)
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| e.file_name().to_string_lossy().contains("(conflict"));
        assert!(!has_conflict_copy, "no `(conflict …)` copy must be created");

        std::fs::remove_dir_all(&root).ok();
    }

    // F1 diverged branch: the note was edited on this device while it was
    // disconnected, then a peer deleted it. The local edit must be PRESERVED as
    // a conflict copy (re-uploaded as a new object), not silently deleted.
    #[tokio::test]
    async fn reconcile_parks_local_edit_when_tombstoned_object_diverged() {
        let server = MockServer::start().await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/collections/c1/objects"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "objects": [{
                    "id": "o1",
                    "collection_id": "c1",
                    "version": 2,
                    "change_seq": 5,
                    "deleted": true,
                    "blob_key": null,
                    "size_bytes": null,
                    "created_at": "2026-07-10T00:00:00.000Z",
                    "updated_at": "2026-07-10T00:00:00.000Z"
                }]
            })))
            .mount(&server)
            .await;

        let root = temp_root();
        // Ancestry hash is the ORIGINAL; the on-disk file now diverges.
        seed_ancestry(&root, "notes.md", "o1", "# Original");
        std::fs::write(root.join("notes.md"), "# Original\n\nedited offline").unwrap();

        let state = connected_state(&server);
        let (summary, next) = reconcile_empty_map(&state, &root, &no_prog, &no_pre)
            .await
            .expect("reconcile");

        let copy = collision_conflict_filename("notes.md", "o1");
        assert!(
            !root.join("notes.md").exists(),
            "the tombstoned original name is removed",
        );
        assert_eq!(
            std::fs::read_to_string(root.join(&copy)).unwrap(),
            "# Original\n\nedited offline",
            "the divergent local edit is preserved in the conflict copy",
        );
        assert!(
            !next.object_map.contains_key(&copy),
            "the copy has no map entry so run_push uploads it as its own new object",
        );
        assert_eq!(summary.deleted, 1, "the original name delete is surfaced");
    }

    // F1: a tombstone for an object this device has NO ancestry for (fresh
    // install, or a note it never synced) leaves the local file alone — we
    // can't prove it's the same note, so deleting it would be unsafe.
    #[tokio::test]
    async fn reconcile_leaves_tombstoned_file_without_ancestry_alone() {
        let server = MockServer::start().await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/collections/c1/objects"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "objects": [{
                    "id": "o-unknown",
                    "collection_id": "c1",
                    "version": 2,
                    "change_seq": 5,
                    "deleted": true,
                    "blob_key": null,
                    "size_bytes": null,
                    "created_at": "2026-07-10T00:00:00.000Z",
                    "updated_at": "2026-07-10T00:00:00.000Z"
                }]
            })))
            .mount(&server)
            .await;

        let root = temp_root();
        // A local note, but NO ancestry entry linking it to o-unknown.
        std::fs::write(root.join("keep.md"), "# Keep").unwrap();

        let state = connected_state(&server);
        let (summary, _next) = reconcile_empty_map(&state, &root, &no_prog, &no_pre)
            .await
            .expect("reconcile");

        assert!(
            root.join("keep.md").exists(),
            "a tombstone with no ancestry link must not delete an unrelated local file",
        );
        assert_eq!(summary.deleted, 0);
    }

    // S2/S5 at the reconcile level: an UNVERIFIABLE tombstone (transient read
    // error, file still present) must surface a failure, must NOT advance the
    // cursor past its change_seq, and must retain the ancestry file for a retry
    // — instead of silently skipping, jumping the cursor, and consuming ancestry.
    #[cfg(unix)]
    #[tokio::test]
    async fn reconcile_unverifiable_tombstone_fails_caps_cursor_retains_ancestry() {
        use std::os::unix::fs::PermissionsExt;
        let server = MockServer::start().await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/collections/c1/objects"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "objects": [{
                    "id": "o1",
                    "collection_id": "c1",
                    "version": 2,
                    "change_seq": 5,
                    "deleted": true,
                    "blob_key": null,
                    "size_bytes": null,
                    "created_at": "2026-07-11T00:00:00.000Z",
                    "updated_at": "2026-07-11T00:00:00.000Z"
                }]
            })))
            .mount(&server)
            .await;

        let root = temp_root();
        let note = root.join("unreadable.md");
        std::fs::write(&note, "# Whatever").unwrap();
        seed_ancestry(&root, "unreadable.md", "o1", "# Whatever");
        // Present in the vault walk (metadata still works) but unreadable, so the
        // reconcile cannot verify the delete → transient, not file-gone.
        std::fs::set_permissions(&note, std::fs::Permissions::from_mode(0o000)).unwrap();

        // Skip the permission-dependent assertions where the environment does
        // not enforce them (root/CAP_DAC_OVERRIDE, common in CI containers):
        // there the read below succeeds, the delete converges, and the failure
        // this test asserts never happens. The test stays meaningful for any
        // non-root runner (local dev, unprivileged CI).
        if !permission_restriction_bites(&note) {
            let _ = std::fs::set_permissions(&note, std::fs::Permissions::from_mode(0o644));
            eprintln!(
                "SKIP reconcile_unverifiable_tombstone_fails_caps_cursor_retains_ancestry: \
                 environment does not enforce file read permissions (running as root?)"
            );
            return;
        }

        let state = connected_state(&server);
        let result = reconcile_empty_map(&state, &root, &no_prog, &no_pre).await;
        // Restore perms so the temp file is cleanable regardless of outcome.
        let _ = std::fs::set_permissions(&note, std::fs::Permissions::from_mode(0o644));
        let (summary, next) = result.expect("reconcile");

        assert_eq!(summary.failures.len(), 1, "the unverifiable delete is a failure");
        assert_eq!(summary.failures[0].kind, FailureKind::Delete);
        assert_eq!(summary.deleted, 0, "nothing was verifiably deleted");
        assert!(
            next.max_version < 5,
            "cursor must stay below the failed tombstone's change_seq (got {})",
            next.max_version,
        );
        assert!(
            state::ancestry_file_path(&root).exists(),
            "ancestry must be retained for the retry",
        );
        assert!(note.exists(), "the target is left untouched");
    }

    /// Some CI containers run the test binary as ROOT, whose CAP_DAC_OVERRIDE
    /// bypasses the DAC permission bits the `#[cfg(unix)]` tests below use to
    /// synthesize an EACCES — so the blocked operation converges normally and
    /// the assertions (which expect a failure) fire falsely. Probe whether the
    /// restriction on `blocked` ACTUALLY bites by attempting the blocked read:
    /// only a SUCCESS means the environment does not enforce it (root), so the
    /// caller must skip its permission-dependent assertions. Any error (EACCES
    /// for a normal user, or anything else) ⇒ run the test. Dependency-free.
    #[cfg(unix)]
    fn permission_restriction_bites(blocked: &Path) -> bool {
        std::fs::read(blocked).is_err()
    }

    /// Count leftover `.sf-tomb-*` claim files in `dir` — must always be 0
    /// (claims are cleaned up on every exit path, P1-a).
    fn orphan_claims(dir: &Path) -> usize {
        std::fs::read_dir(dir)
            .map(|it| {
                it.flatten()
                    .filter(|e| {
                        e.file_name().to_string_lossy().starts_with(".sf-tomb-")
                    })
                    .count()
            })
            .unwrap_or(0)
    }

    // S1/P1-a (claim-and-delete-or-park): a tombstone is deleted ONLY when the
    // claimed bytes still hash to the last-synced hash. A file that no longer
    // matches is preserved in a conflict copy (from the CLAIMED bytes), never
    // blindly deleted. A file already gone is a converged no-op. No claim
    // dotfile is ever left behind.
    #[test]
    fn apply_tombstone_reconcile_deletes_only_on_hash_match() {
        let root = temp_root();
        std::fs::write(root.join("unchanged.md"), "# Unchanged").unwrap();
        std::fs::write(root.join("edited.md"), "# Edited since last sync").unwrap();
        let targets = vec![
            TombstoneTarget {
                filename: "unchanged.md".into(),
                object_id: "o1".into(),
                expected_hash: hash_sha256("# Unchanged"),
                change_seq: 5,
            },
            TombstoneTarget {
                filename: "edited.md".into(),
                object_id: "o2".into(),
                // The file was edited after the last sync, so its current bytes
                // differ from what the peer's delete targeted.
                expected_hash: hash_sha256("# Original before the edit"),
                change_seq: 6,
            },
            TombstoneTarget {
                filename: "gone.md".into(),
                object_id: "o3".into(),
                expected_hash: hash_sha256("whatever"),
                change_seq: 7,
            },
        ];

        let res = apply_tombstone_reconcile(&root, &no_pre, &targets);

        // Unchanged → peer delete wins.
        assert!(!root.join("unchanged.md").exists());
        assert!(res.deleted.contains(&"unchanged.md".to_owned()));
        // Edited → NOT blindly deleted; claimed bytes preserved in the copy.
        assert!(!root.join("edited.md").exists(), "tombstoned name dropped");
        let copy = collision_conflict_filename("edited.md", "o2");
        assert_eq!(
            std::fs::read_to_string(root.join(&copy)).unwrap(),
            "# Edited since last sync",
            "the edit must be preserved, not lost to a stale-hash delete",
        );
        // Already gone → converged, no failure.
        assert!(res.failed.is_empty(), "no failures for match/diverge/gone");
        // The single diverged park is a local disk write, counted for the F2
        // reload signal (folds into SyncSummary::local_writes_applied).
        assert_eq!(res.parked, 1, "one diverged conflict copy written");
        assert_eq!(orphan_claims(&root), 0, "no claim dotfile left behind");
    }

    // T2/P2 (F2): if the conflict-copy WRITE succeeds but the claim cleanup then
    // FAILS, the copy is on disk and MUST still be counted (parked) so the shell
    // rescans and the new copy becomes visible — even though the tombstone
    // becomes a FAILED (retried) delete. The note lives in a subdir so the copy
    // write (in sub/) and the claim removal (a dotfile at the vault ROOT) touch
    // different directories; the pre_write hook fires exactly at the copy write
    // and drops the root's write bit, failing ONLY the subsequent claim removal.
    // Red against the pre-fix code, which incremented `parked` after the claim
    // cleanup (this path never reached it → parked==0, copy invisible).
    #[cfg(unix)]
    #[test]
    fn apply_tombstone_reconcile_counts_park_even_when_claim_cleanup_fails() {
        use std::os::unix::fs::PermissionsExt;
        let root = temp_root();

        // Skip under CI-root / CAP_DAC_OVERRIDE, where a read-only dir does not
        // block writes (the claim removal would succeed and this race can't
        // occur). Probe with a throwaway dir.
        let probe = root.join("perm-probe");
        std::fs::create_dir(&probe).unwrap();
        std::fs::set_permissions(&probe, std::fs::Permissions::from_mode(0o555)).unwrap();
        let write_blocked = std::fs::write(probe.join("x"), b"x").is_err();
        let _ = std::fs::set_permissions(&probe, std::fs::Permissions::from_mode(0o755));
        let _ = std::fs::remove_dir_all(&probe);
        if !write_blocked {
            eprintln!(
                "SKIP apply_tombstone_reconcile_counts_park_even_when_claim_cleanup_fails: \
                 environment does not enforce directory write permissions (running as root?)"
            );
            return;
        }

        std::fs::create_dir(root.join("sub")).unwrap();
        std::fs::write(root.join("sub/note.md"), "edited since last sync").unwrap();
        let targets = vec![TombstoneTarget {
            filename: "sub/note.md".into(),
            object_id: "o2".into(),
            // Diverged: on-disk bytes differ from the delete's expected hash.
            expected_hash: hash_sha256("original before the edit"),
            change_seq: 6,
        }];

        // Fail ONLY the claim removal: strip the vault root's write bit at the
        // moment the copy (in sub/) is written. The claim dotfile lives at root,
        // so the following remove_file(root/.claim) fails with EACCES.
        let pre: Box<PreWriteFn> = {
            let root = root.clone();
            Box::new(move |f: &str| {
                if f.contains("(conflict ") {
                    let _ = std::fs::set_permissions(
                        &root,
                        std::fs::Permissions::from_mode(0o555),
                    );
                }
            })
        };

        let res = apply_tombstone_reconcile(&root, pre.as_ref(), &targets);

        // Restore write perms so the temp tree is inspectable + cleanable.
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o755)).unwrap();

        // The park write happened → counted, regardless of the cleanup failure.
        assert_eq!(res.parked, 1, "the on-disk conflict copy must be counted (F2)");
        // The tombstone delete was NOT verified (claim survived) → a retry.
        assert!(res.deleted.is_empty(), "delete not confirmed when claim cleanup fails");
        assert_eq!(res.failed.len(), 1, "unverified tombstone is a failure/retry");
        // The conflict copy is really on disk.
        let copy = collision_conflict_filename("sub/note.md", "o2");
        assert_eq!(
            std::fs::read_to_string(root.join(&copy)).unwrap(),
            "edited since last sync",
        );
    }

    // P1-b (non-NotFound error ≠ convergence): a target the reconcile cannot
    // even CLAIM because of a permission/metadata error (not because it is gone)
    // must be a failure (retry), never treated as "already deleted". The parent
    // directory is stripped of the execute (search) bit, so path resolution —
    // and thus the claim `rename` — fails with EACCES, not NotFound. Red against
    // the prior `Path::exists()` check, which returns false on this metadata
    // error and wrongly "converged" (dropping the tombstone + ancestry). The
    // file is left untouched and no claim is orphaned.
    #[cfg(unix)]
    #[test]
    fn apply_tombstone_reconcile_non_notfound_error_is_failure_not_convergence() {
        use std::os::unix::fs::PermissionsExt;
        let root = temp_root();
        std::fs::create_dir(root.join("locked")).unwrap();
        std::fs::write(root.join("locked/note.md"), "# Unchanged").unwrap();
        // r-- (no execute/search): resolving `locked/note.md` fails with EACCES,
        // and `Path::exists()` returns false even though the file is there.
        std::fs::set_permissions(root.join("locked"), std::fs::Permissions::from_mode(0o400))
            .unwrap();

        // Skip where the environment does not enforce the directory search bit
        // (root/CAP_DAC_OVERRIDE, common in CI containers): there resolution
        // succeeds, the claim rename converges, and the failure this test
        // asserts never happens. Meaningful for any non-root runner.
        if !permission_restriction_bites(&root.join("locked/note.md")) {
            let _ = std::fs::set_permissions(
                root.join("locked"),
                std::fs::Permissions::from_mode(0o755),
            );
            eprintln!(
                "SKIP apply_tombstone_reconcile_non_notfound_error_is_failure_not_convergence: \
                 environment does not enforce directory search permissions (running as root?)"
            );
            return;
        }

        let targets = vec![TombstoneTarget {
            filename: "locked/note.md".into(),
            object_id: "o1".into(),
            // Hash MATCHES: a broken existence check would happily "converge"
            // and drop it — prove the permission error blocks that.
            expected_hash: hash_sha256("# Unchanged"),
            change_seq: 9,
        }];

        let res = apply_tombstone_reconcile(&root, &no_pre, &targets);
        // Restore write perms so the temp tree is cleanable.
        let _ = std::fs::set_permissions(
            root.join("locked"),
            std::fs::Permissions::from_mode(0o755),
        );

        assert!(res.deleted.is_empty(), "a permission error must not delete/converge");
        assert_eq!(res.failed.len(), 1);
        assert_eq!(
            res.failed[0].change_seq, 9,
            "the failure carries the change_seq so the cursor caps below it",
        );
        assert!(root.join("locked/note.md").exists(), "target left untouched");
        assert_eq!(orphan_claims(&root.join("locked")), 0, "no claim orphaned");
    }

    // P1-1 encoding: a short path uses the self-describing hex form (no sidecar)
    // and round-trips through claim_decode (incl. subdirs / spaces / unicode).
    #[test]
    fn claim_name_round_trips_original_filename() {
        for rel in ["note.md", "sub/deep/a note.md", "caf\u{00E9}.md", ".sf-tomb-lookalike.md"] {
            let (name, sidecar) = claim_names_for(rel);
            assert!(sidecar.is_none(), "short paths use the hex form, no sidecar");
            assert!(name.starts_with(CLAIM_PREFIX));
            assert!(name.len() <= MAX_CLAIM_NAME_BYTES);
            assert!(
                !name[CLAIM_PREFIX.len()..].contains('/'),
                "no path separators leak into the dotfile name",
            );
            assert_eq!(claim_decode(&name).as_deref(), Some(rel));
        }
        // A non-claim name (or a garbled one) decodes to None.
        assert_eq!(claim_decode("note.md"), None);
        assert_eq!(claim_decode(".sf-tomb-zz"), None, "non-hex payload");
        assert_eq!(claim_decode(".sf-tomb-abc"), None, "odd-length payload");
    }

    // P1-1 NAME_MAX bound: a path too long for the hex form falls back to the
    // fixed-size hashed name + a sidecar; both stay well under NAME_MAX, the
    // hashed name is NOT hex-decodable (so the sweep routes it to the sidecar),
    // and the sidecar name is the claim name + ".path".
    #[test]
    fn claim_name_overflow_uses_bounded_hashed_form_plus_sidecar() {
        let rel = format!("{}.md", "x".repeat(200)); // 203 bytes → hex would be 415
        let (name, sidecar) = claim_names_for(&rel);
        assert!(name.len() <= MAX_CLAIM_NAME_BYTES, "claim name must be bounded");
        assert!(name.starts_with(&format!("{CLAIM_PREFIX}{CLAIM_HASH_MARKER}")));
        assert_eq!(claim_decode(&name), None, "hashed form is not hex-decodable");
        let sidecar = sidecar.expect("overflow path must carry a sidecar");
        assert_eq!(sidecar, format!("{name}{CLAIM_SIDECAR_SUFFIX}"));
        assert!(sidecar.len() <= MAX_CLAIM_NAME_BYTES);
    }

    // P1-1 recovery sweep: a claim orphaned by a crash inside a prior
    // apply_tombstone_reconcile (the note's ONLY copy is the dotfile) is
    // restored to its original name on the next run. Wired at the START of
    // apply_tombstone_reconcile, so an empty-targets call still recovers it.
    #[test]
    fn recover_sweep_restores_orphaned_claim() {
        let root = temp_root();
        std::fs::create_dir_all(root.join("sub")).unwrap();
        // Simulate the crash aftermath: the note lives only as a root dotfile
        // whose name encodes "sub/note.md"; the original path is absent.
        let claim = root.join(claim_names_for("sub/note.md").0);
        std::fs::write(&claim, "# The only copy").unwrap();
        assert!(!root.join("sub/note.md").exists());

        let res = apply_tombstone_reconcile(&root, &no_pre, &[]);

        assert!(res.deleted.is_empty());
        assert!(res.failed.is_empty());
        assert_eq!(
            std::fs::read_to_string(root.join("sub/note.md")).unwrap(),
            "# The only copy",
            "the orphaned note must be restored to its original name",
        );
        assert_eq!(orphan_claims(&root), 0, "the stale claim is consumed by the restore");
    }

    // P1-1 sweep, recreated-file case: if the original name already exists (a
    // save/pull re-created it while the claim was orphaned), the recreated file
    // WINS and the stale claim is dropped — never clobbering newer content.
    #[test]
    fn recover_sweep_drops_claim_when_original_recreated() {
        let root = temp_root();
        std::fs::write(root.join("note.md"), "# Recreated newer content").unwrap();
        let claim = root.join(claim_names_for("note.md").0);
        std::fs::write(&claim, "# Stale claimed bytes").unwrap();

        apply_tombstone_reconcile(&root, &no_pre, &[]);

        assert_eq!(
            std::fs::read_to_string(root.join("note.md")).unwrap(),
            "# Recreated newer content",
            "the recreated file wins; the stale claim never clobbers it",
        );
        assert_eq!(orphan_claims(&root), 0, "the stale claim is dropped");
    }

    // Item 2: on the no-replacement path, a FAILED restore must LEAVE the claim
    // (the sweep recovers it next cycle) — NEVER delete the note's only copy.
    // A plain FILE stands where the restore target's parent directory should be,
    // so both create_dir_all and the restore `rename` fail (ENOTDIR); and
    // symlink_metadata(orig) is Err (no positive replacement confirmation). The
    // prior code's `else if rename().is_err() { remove }` would have destroyed
    // the only copy — this is red against it.
    #[test]
    fn restore_or_discard_leaves_claim_when_restore_fails_no_replacement() {
        let root = temp_root();
        let claim = root.join(claim_names_for("blocker/note.md").0);
        std::fs::write(&claim, "# The only copy").unwrap();
        // A file occupies "blocker" → "blocker/note.md" is unreachable.
        std::fs::write(root.join("blocker"), "not a directory").unwrap();
        let orig = root.join("blocker/note.md");

        restore_or_discard_claim(&claim, &orig, None);

        assert!(claim.exists(), "the only copy must survive a failed restore");
        assert!(!orig.exists());
    }

    // Round-4 (NAME_MAX blocker): a legal 200-char title's hex claim name would
    // be 400+ bytes > NAME_MAX, so the old unbounded encoder failed the claim
    // rename with ENAMETOOLONG → the tombstone was left FAILED → the empty-map
    // push re-POSTed the still-on-disk unmapped note (F1 resurrection). The
    // bounded form must apply the delete cleanly, leaving no dotfile behind.
    // RED on current HEAD (the rename errors, the file is not deleted).
    #[test]
    fn apply_tombstone_reconcile_deletes_overflow_length_title() {
        let root = temp_root();
        let name = format!("{}.md", "t".repeat(200));
        std::fs::write(root.join(&name), "# body").unwrap();
        let targets = vec![TombstoneTarget {
            filename: name.clone(),
            object_id: "o1".into(),
            expected_hash: hash_sha256("# body"),
            change_seq: 5,
        }];

        let res = apply_tombstone_reconcile(&root, &no_pre, &targets);

        assert!(res.failed.is_empty(), "a long-title tombstone must not fail (ENAMETOOLONG)");
        assert!(res.deleted.contains(&name), "the delete is applied");
        assert!(!root.join(&name).exists(), "the tombstoned file is gone");
        assert_eq!(orphan_claims(&root), 0, "no claim/sidecar dotfile left behind");
    }

    // Round-4 deep-path equivalent: the overflow comes from path DEPTH, not a
    // single long component. Same requirement — clean delete, no orphan.
    #[test]
    fn apply_tombstone_reconcile_deletes_overflow_deep_path() {
        let root = temp_root();
        let rel = format!("{}note.md", "sub/".repeat(40)); // 167 bytes → hex overflows
        let full = root.join(&rel);
        std::fs::create_dir_all(full.parent().unwrap()).unwrap();
        std::fs::write(&full, "# deep").unwrap();
        let targets = vec![TombstoneTarget {
            filename: rel.clone(),
            object_id: "o1".into(),
            expected_hash: hash_sha256("# deep"),
            change_seq: 9,
        }];

        let res = apply_tombstone_reconcile(&root, &no_pre, &targets);

        assert!(res.failed.is_empty(), "a deep-path tombstone must not fail (ENAMETOOLONG)");
        assert!(res.deleted.contains(&rel));
        assert!(!full.exists());
        assert_eq!(orphan_claims(&root), 0, "no claim/sidecar dotfile left behind");
    }

    // Round-4 sweep recovery for the overflow (hashed) shape: a crash left the
    // hashed claim (the only bytes) + its sidecar (the path). The sweep reads
    // the sidecar, restores the note to its original path, and cleans up both.
    #[test]
    fn recover_sweep_restores_overflow_claim_via_sidecar() {
        let root = temp_root();
        let rel = format!("{}.md", "z".repeat(200));
        let (claim_name, sidecar_name) = claim_names_for(&rel);
        let sidecar_name = sidecar_name.expect("overflow form has a sidecar");
        std::fs::write(root.join(&claim_name), "# only copy").unwrap();
        std::fs::write(root.join(&sidecar_name), &rel).unwrap();

        let res = apply_tombstone_reconcile(&root, &no_pre, &[]);

        assert!(res.failed.is_empty());
        assert_eq!(
            std::fs::read_to_string(root.join(&rel)).unwrap(),
            "# only copy",
            "the overflow claim is restored to its original path via the sidecar",
        );
        assert_eq!(orphan_claims(&root), 0, "claim + sidecar both cleaned up");
    }

    // Round-4 fail-safe orphans: a sidecar with no claim is harmless leftover →
    // deleted; a hashed claim with no sidecar has an UNRECOVERABLE path → it is
    // LEFT untouched (bytes preserved verbatim), never deleted or misplaced.
    #[test]
    fn recover_sweep_orphan_sidecar_deleted_orphan_hashed_claim_left() {
        let root = temp_root();
        // Orphan sidecar (no matching claim) → deleted.
        let (_claim_a, sidecar_a) = claim_names_for(&format!("{}.md", "a".repeat(200)));
        let sidecar_a = sidecar_a.unwrap();
        std::fs::write(root.join(&sidecar_a), "irrelevant path").unwrap();
        // Orphan hashed claim (no sidecar) → unrecoverable → LEFT.
        let (claim_b, _) = claim_names_for(&format!("{}.md", "b".repeat(200)));
        std::fs::write(root.join(&claim_b), "# stranded bytes").unwrap();

        apply_tombstone_reconcile(&root, &no_pre, &[]);

        assert!(!root.join(&sidecar_a).exists(), "orphan sidecar is cleaned up");
        assert!(
            root.join(&claim_b).exists(),
            "orphan hashed claim (unrecoverable path) is LEFT, never deleted",
        );
        assert_eq!(
            std::fs::read_to_string(root.join(&claim_b)).unwrap(),
            "# stranded bytes",
            "the stranded bytes are preserved verbatim",
        );
    }

    // Conflict-copy POST path: the merge base is unavailable (404), so
    // resolution falls through to a conflict-copy POST. The server rejects
    // that POST with 413 → must surface as TooLarge, NOT a generic Err.
    #[tokio::test]
    async fn resolve_update_conflict_post_413_surfaces_too_large() {
        let server = MockServer::start().await;
        let filename = "huge.md";
        let remote_ct = enc(filename, "remote body\n").await;

        // get_blob(current/remote) → the peer's new content (decryptable).
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/blobs/bk-remote"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(remote_ct))
            .mount(&server)
            .await;
        // get_blob(base) → 404, forcing the conflict-copy fallback.
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/blobs/bk-base"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;
        // The conflict-copy POST is rejected as oversize.
        Mock::given(wm_method("POST"))
            .and(wm_path("/api/collections/c1/blob-objects"))
            .respond_with(ResponseTemplate::new(413).set_body_json(serde_json::json!({
                "error": "blob too large"
            })))
            .mount(&server)
            .await;

        let http = test_client(&server);
        let vault_key = Arc::new(TEST_VAULT_KEY);
        let existing = map_entry_for("o1", 3, "bk-base");
        let conflict = ConflictResponse {
            error: "conflict".into(),
            current_version: 4,
            current_blob_key: Some("bk-remote".into()),
        };

        let outcome = resolve_update_conflict(
            http,
            vault_key,
            "c1",
            filename,
            "local body\n".to_owned(),
            hash_sha256("local body\n"),
            existing,
            conflict,
            HashSet::new(),
            false,
            12345,
        )
        .await
        .expect("413 must be a non-fatal TooLarge, not a hard error");

        match outcome {
            PushOutcome::TooLarge { mtime_ms, .. } => {
                assert_eq!(mtime_ms, 12345, "must carry the on-disk mtime for the skip mark");
            }
            other => panic!("expected PushOutcome::TooLarge, got {other:?}"),
        }
    }

    // Identical-content 409: the base blob is GC'd (404, so the clean-merge
    // branch is skipped) but our local bytes already equal the remote we
    // fetched. This is NOT a conflict — resolution must adopt the remote
    // object (MergedClean, same object_id) and must NOT POST a conflict copy.
    // Regression for the July 2026 combinatorial blow-up, whose engine was a
    // byte-identical conflict copy minted as a new object every cycle.
    #[tokio::test]
    async fn resolve_update_conflict_identical_content_adopts_remote_no_copy() {
        let server = MockServer::start().await;
        let filename = "futo notes top priorities.md";
        let content = "same bytes on both sides\n";
        let remote_ct = enc(filename, content).await;

        // remote blob → the peer's content, byte-identical to ours.
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/blobs/bk-remote"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(remote_ct))
            .mount(&server)
            .await;
        // base blob GC'd → 404, so the clean-merge branch is skipped and we
        // reach the identical-content guard.
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/blobs/bk-base"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;
        // A conflict-copy POST must NEVER fire on identical content. wiremock
        // verifies expect(0) when the server drops at end of scope.
        Mock::given(wm_method("POST"))
            .and(wm_path("/api/collections/c1/blob-objects"))
            .respond_with(ResponseTemplate::new(201))
            .expect(0)
            .mount(&server)
            .await;

        let http = test_client(&server);
        let vault_key = Arc::new(TEST_VAULT_KEY);
        let existing = map_entry_for("o1", 3, "bk-base");
        let conflict = ConflictResponse {
            error: "conflict".into(),
            current_version: 9,
            current_blob_key: Some("bk-remote".into()),
        };

        let outcome = resolve_update_conflict(
            http,
            vault_key,
            "c1",
            filename,
            content.to_owned(),
            hash_sha256(content),
            existing,
            conflict,
            HashSet::new(),
            false,
            12345,
        )
        .await
        .expect("identical content must resolve, not error");

        match outcome {
            PushOutcome::MergedClean { filename: f, entry, previous_filename, .. } => {
                assert_eq!(f, filename, "adopts the note at its own filename");
                assert_eq!(entry.object_id, "o1", "same object — no new object minted");
                assert_eq!(entry.version, 9, "adopts the server's current version");
                assert!(previous_filename.is_none(), "no peer rename here");
            }
            other => panic!("expected MergedClean (adopt remote), got {other:?}"),
        }
        // `.expect(0)` on the POST mock is asserted here when `server` drops.
    }

    // F3: peer deleted the object while we held a dirty local edit → the PUT
    // 409 carries `current_blob_key: None`. The edit must be PRESERVED by
    // re-POSTing it as a FRESH object (Wrote), not dropped as an
    // UnresolvedConflict — which wrote nothing and let the pull's
    // immediate-delete erase the file, silently losing the edit.
    #[tokio::test]
    async fn resolve_update_conflict_peer_delete_preserves_edit_as_fresh_object() {
        let server = MockServer::start().await;
        // The re-POST of the local edit → a brand-new object. Exactly one POST.
        Mock::given(wm_method("POST"))
            .and(wm_path("/api/collections/c1/blob-objects"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "object": {
                    "id": "o-fresh",
                    "version": 1,
                    "change_seq": 42,
                    "updated_at": "2026-07-10T00:00:00.000Z",
                    "blob_key": "bk-fresh"
                },
                "collectionVersion": 42
            })))
            .expect(1)
            .mount(&server)
            .await;

        let http = test_client(&server);
        let vault_key = Arc::new(TEST_VAULT_KEY);
        let existing = map_entry_for("o-gone", 3, "bk-old");
        // Tombstoned object: 409 with no current blob to merge against.
        let conflict = ConflictResponse {
            error: "conflict".into(),
            current_version: 4,
            current_blob_key: None,
        };
        let local = "# original\n\nedited locally while the peer deleted it\n";

        let outcome = resolve_update_conflict(
            http,
            vault_key,
            "c1",
            "contested.md",
            local.to_owned(),
            hash_sha256(local),
            existing,
            conflict,
            HashSet::new(),
            false,
            12345,
        )
        .await
        .expect("edit-vs-delete must preserve the edit, not error");

        match outcome {
            PushOutcome::Wrote { filename, entry, peer_resolved, .. } => {
                assert_eq!(filename, "contested.md", "edit stays at its own filename");
                assert_eq!(entry.object_id, "o-fresh", "re-POSTed as a fresh object");
                assert_eq!(
                    entry.hash.as_deref(),
                    Some(hash_sha256(local).as_str()),
                    "the fresh object carries the local edit's content hash",
                );
                assert!(!peer_resolved, "this is our own upload, not a peer download");
            }
            other => panic!("expected Wrote (edit preserved as fresh object), got {other:?}"),
        }
    }

    // F3 real-server edit-vs-delete, S9: the peer EDITED the note (bumping its
    // blob) and then DELETED it. The server's DELETE keeps the blob_key + bumps
    // the version, so our 409 carries the peer's edited blob to merge against
    // (NOT None) and the 3-way merge re-PUT SUCCEEDS — but the row is still
    // `deleted: true` (PUT doesn't un-delete). The merged content incorporates
    // BOTH the peer's edit and ours, so it differs from the local bytes on disk;
    // it must be re-POSTed onto a FRESH live object AND written locally
    // (MergedClean, not a bare Wrote — a Wrote never writes, so the next cycle
    // would re-upload the stale local bytes and erase the peer's contribution).
    #[tokio::test]
    async fn resolve_update_conflict_merge_onto_tombstone_reposts_fresh() {
        let server = MockServer::start().await;
        let filename = "contested.md";
        // Non-overlapping edits with unchanged context so diffy merges cleanly;
        // base (our last sync) differs from remote (the peer's pre-delete edit).
        let base = "line 1\nline 2\nline 3\nline 4\nline 5\n";
        let remote = "LINE ONE\nline 2\nline 3\nline 4\nline 5\n"; // peer edited line 1
        let local = "line 1\nline 2\nline 3\nline 4\nLINE FIVE\n"; // we edited line 5
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/blobs/bk-base"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(enc(filename, base).await))
            .mount(&server)
            .await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/blobs/bk-remote"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(enc(filename, remote).await))
            .mount(&server)
            .await;
        // The merge re-PUT succeeds but the object is STILL a tombstone.
        Mock::given(wm_method("PUT"))
            .and(wm_path("/api/collections/c1/blob-objects/o-orig"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "object": {
                    "id": "o-orig", "version": 6, "change_seq": 6,
                    "updated_at": "2026-07-11T00:00:00.000Z",
                    "blob_key": "bk-zombie", "deleted": true
                },
                "collectionVersion": 6
            })))
            .mount(&server)
            .await;
        // The recovery re-POST → a fresh, live object. Must fire exactly once.
        Mock::given(wm_method("POST"))
            .and(wm_path("/api/collections/c1/blob-objects"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "object": {
                    "id": "o-fresh", "version": 1, "change_seq": 7,
                    "updated_at": "2026-07-11T00:00:00.000Z",
                    "blob_key": "bk-fresh", "deleted": false
                },
                "collectionVersion": 7
            })))
            .expect(1)
            .mount(&server)
            .await;

        let http = test_client(&server);
        let vault_key = Arc::new(TEST_VAULT_KEY);
        let existing = map_entry_for("o-orig", 4, "bk-base");
        let conflict = ConflictResponse {
            error: "conflict".into(),
            current_version: 5, // the peer's edit + delete bumped the version
            current_blob_key: Some("bk-remote".into()), // the peer's edited blob
        };

        let outcome = resolve_update_conflict(
            http,
            vault_key,
            "c1",
            filename,
            local.to_owned(),
            hash_sha256(local),
            existing,
            conflict,
            HashSet::new(),
            false,
            999,
        )
        .await
        .expect("edit-vs-delete must resolve, not error");

        let expected_merge = "LINE ONE\nline 2\nline 3\nline 4\nLINE FIVE\n";
        match outcome {
            PushOutcome::MergedClean { filename: f, merged_content, entry, .. } => {
                assert_eq!(f, filename, "the merge stays at its own filename");
                assert_eq!(
                    entry.object_id, "o-fresh",
                    "the merge is re-POSTed onto a fresh LIVE object, not the tombstone",
                );
                // The peer's edit (LINE ONE) MUST be in the content written to
                // disk — a bare Wrote would carry no content and lose it (S9).
                assert_eq!(
                    merged_content, expected_merge,
                    "MergedClean must carry the full 3-way merge for the local write",
                );
                assert_eq!(entry.hash.as_deref(), Some(hash_sha256(expected_merge).as_str()));
            }
            other => panic!("expected MergedClean (fresh live object + local write), got {other:?}"),
        }
    }

    // F2 source-level guard for the push-side count
    // (`local_writes_applied = updates.len() + conflict_writes.len()`): a full
    // run_push producing a MergedClean must report the local write via
    // `local_writes_applied` WITHOUT bumping `downloaded`/`deleted` — the exact
    // signal native shells reload on. Without it a stale open editor never
    // reloads and its next autosave clobbers the merged-in peer edit.
    #[tokio::test]
    async fn run_push_merged_clean_counts_local_write_not_download() {
        let server = MockServer::start().await;
        let filename = "note.md";
        // Local bytes already equal the remote the peer advanced to (a spurious
        // 409); the merge base is GC'd (404), so resolution adopts the remote
        // as a MergedClean that writes the note to local disk.
        let shared = "shared content\n";
        Mock::given(wm_method("PUT"))
            .and(wm_path("/api/collections/c1/blob-objects/o1"))
            .respond_with(ResponseTemplate::new(409).set_body_json(serde_json::json!({
                "error": "conflict",
                "currentVersion": 9,
                "currentBlobKey": "bk-remote"
            })))
            .mount(&server)
            .await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/blobs/bk-remote"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(enc(filename, shared).await))
            .mount(&server)
            .await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/blobs/bk-base"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;

        let root = temp_root();
        std::fs::write(root.join(filename), shared).unwrap();
        let mut state = connected_state(&server);
        state
            .object_map
            .insert(filename.to_owned(), map_entry_for("o1", 3, "bk-base"));

        let (summary, _next) = run_push(&state, &root, &no_prog, &no_pre)
            .await
            .expect("push");

        assert_eq!(summary.local_writes_applied, 1, "the adopt/merge wrote note.md locally");
        assert_eq!(summary.downloaded, 0, "a push-side merge is not a pull download");
        assert_eq!(summary.deleted, 0);
        assert_eq!(summary.uploaded, 1);
    }

    // F2 source-level guard, conflict-copy arm: a ConflictCopy writes the
    // remote to the canonical name AND parks the local edit in a copy file —
    // TWO local writes (updates + conflict_writes). Pins that BOTH terms of the
    // count are live (dropping `conflict_writes.len()` would report 1, not 2).
    #[tokio::test]
    async fn run_push_conflict_copy_counts_both_local_writes() {
        let server = MockServer::start().await;
        let filename = "note.md";
        let local = "local edit\n";
        let remote = "remote edit\n";
        Mock::given(wm_method("PUT"))
            .and(wm_path("/api/collections/c1/blob-objects/o1"))
            .respond_with(ResponseTemplate::new(409).set_body_json(serde_json::json!({
                "error": "conflict",
                "currentVersion": 9,
                "currentBlobKey": "bk-remote"
            })))
            .mount(&server)
            .await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/blobs/bk-remote"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(enc(filename, remote).await))
            .mount(&server)
            .await;
        // Base GC'd → clean-merge branch skipped; local != remote → conflict copy.
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/blobs/bk-base"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;
        Mock::given(wm_method("POST"))
            .and(wm_path("/api/collections/c1/blob-objects"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "object": {
                    "id": "o-copy", "version": 1, "change_seq": 10,
                    "updated_at": "2026-07-11T00:00:00.000Z",
                    "blob_key": "bk-copy", "deleted": false
                },
                "collectionVersion": 10
            })))
            .mount(&server)
            .await;

        let root = temp_root();
        std::fs::write(root.join(filename), local).unwrap();
        let mut state = connected_state(&server);
        state
            .object_map
            .insert(filename.to_owned(), map_entry_for("o1", 3, "bk-base"));

        let (summary, _next) = run_push(&state, &root, &no_prog, &no_pre)
            .await
            .expect("push");

        assert_eq!(
            summary.local_writes_applied, 2,
            "remote→note.md + local→copy file = two local writes"
        );
        assert_eq!(summary.downloaded, 0);
        assert_eq!(summary.deleted, 0);
        assert_eq!(summary.conflicts, 1);
    }

    // Clean-merge re-PUT path: base + remote are both available and merge
    // cleanly, so resolution re-PUTs the merged content. The server rejects
    // that PUT with 413 → must surface as TooLarge, NOT a generic Err.
    #[tokio::test]
    async fn resolve_update_conflict_put_413_surfaces_too_large() {
        let server = MockServer::start().await;
        let filename = "huge.md";
        // Non-overlapping edits with unchanged context between them so diffy
        // produces a Clean merge (mirrors e2ee::tests::merge_clean_non_overlapping).
        let base = "line 1\nline 2\nline 3\nline 4\nline 5\n";
        let remote = "LINE ONE\nline 2\nline 3\nline 4\nline 5\n";
        let local = "line 1\nline 2\nline 3\nline 4\nLINE FIVE\n";
        let base_ct = enc(filename, base).await;
        let remote_ct = enc(filename, remote).await;

        Mock::given(wm_method("GET"))
            .and(wm_path("/api/blobs/bk-remote"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(remote_ct))
            .mount(&server)
            .await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/blobs/bk-base"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(base_ct))
            .mount(&server)
            .await;
        // The merged re-PUT is rejected as oversize.
        Mock::given(wm_method("PUT"))
            .and(wm_path("/api/collections/c1/blob-objects/o1"))
            .respond_with(ResponseTemplate::new(413).set_body_json(serde_json::json!({
                "error": "blob too large"
            })))
            .mount(&server)
            .await;

        let http = test_client(&server);
        let vault_key = Arc::new(TEST_VAULT_KEY);
        let existing = map_entry_for("o1", 3, "bk-base");
        let conflict = ConflictResponse {
            error: "conflict".into(),
            current_version: 4,
            current_blob_key: Some("bk-remote".into()),
        };

        let outcome = resolve_update_conflict(
            http,
            vault_key,
            "c1",
            filename,
            local.to_owned(),
            hash_sha256(local),
            existing,
            conflict,
            HashSet::new(),
            false,
            67890,
        )
        .await
        .expect("413 must be a non-fatal TooLarge, not a hard error");

        match outcome {
            PushOutcome::TooLarge { filename: f, mtime_ms } => {
                assert_eq!(f, filename, "the merged target filename is surfaced");
                assert_eq!(mtime_ms, 67890, "must carry the on-disk mtime for the skip mark");
            }
            other => panic!("expected PushOutcome::TooLarge, got {other:?}"),
        }
    }

    // ── Upload failure channel (work-item #10) ───────────────────────────
    //
    // A non-413 upload failure (HTTP 5xx — the 2026-06-29 EACCES incident
    // class — 403, network) used to return a bare `PushOutcome::Error` that
    // the aggregator dropped: not counted, not surfaced. It must now carry
    // the filename + status so `run_push` can fold it into
    // `SyncSummary.failures` and the UI can surface it.

    #[tokio::test]
    async fn push_one_file_post_500_surfaces_error_with_status() {
        let server = MockServer::start().await;
        Mock::given(wm_method("POST"))
            .and(wm_path("/api/collections/c1/blob-objects"))
            .respond_with(ResponseTemplate::new(500).set_body_json(serde_json::json!({
                "error": "internal server error"
            })))
            .mount(&server)
            .await;

        let root = temp_root();
        std::fs::write(root.join("err.md"), "body\n").unwrap();

        let outcome = push_one_file(
            root,
            test_client(&server),
            Arc::new(TEST_VAULT_KEY),
            "c1".to_owned(),
            local("err.md", 111, 5),
            None, // no prior entry → POST create
            HashSet::new(),
            false,
            None,
        )
        .await
        .expect("a 5xx upload is non-fatal, not a hard cycle error");

        match outcome {
            PushOutcome::Error { filename, status_code } => {
                assert_eq!(filename, "err.md");
                assert_eq!(status_code, Some(500), "status must be carried for the tooltip");
            }
            other => panic!("expected PushOutcome::Error, got {other:?}"),
        }
    }

    // Channel separation: a 413 on the SAME push path stays TooLarge (the
    // oversize/conflict channel) and must NOT leak into the generic
    // Error/`failed` channel.
    #[tokio::test]
    async fn push_one_file_post_413_stays_too_large_not_error() {
        let server = MockServer::start().await;
        Mock::given(wm_method("POST"))
            .and(wm_path("/api/collections/c1/blob-objects"))
            .respond_with(ResponseTemplate::new(413).set_body_json(serde_json::json!({
                "error": "blob too large"
            })))
            .mount(&server)
            .await;

        let root = temp_root();
        std::fs::write(root.join("big.md"), "body\n").unwrap();

        let outcome = push_one_file(
            root,
            test_client(&server),
            Arc::new(TEST_VAULT_KEY),
            "c1".to_owned(),
            local("big.md", 222, 5),
            None,
            HashSet::new(),
            false,
            None,
        )
        .await
        .expect("413 is non-fatal");

        assert!(
            matches!(outcome, PushOutcome::TooLarge { .. }),
            "413 must stay TooLarge, got {outcome:?}",
        );
    }

    // Item 5 (direct-PUT-onto-tombstone, silent-loss half): a peer DELETED this
    // object while we were disconnected. The server's DELETE bumped the version,
    // so our expected_version (recorded + 1) MATCHED the post-delete version and
    // the direct PUT SUCCEEDS with NO 409 — but the row is still `deleted: true`
    // (PUT does not un-delete). push_one_file must NOT map the note to this
    // tombstone (the same cycle's pull would apply it and delete our edited file
    // — silent loss); it re-POSTs the content as a FRESH live object. `content`
    // is the verbatim on-disk bytes, so a Wrote-shaped outcome (no local write)
    // is correct. Red before the fix: the PUT-Ok arm ignored `deleted` and
    // returned a Wrote onto the tombstone object, so the POST never fired.
    #[tokio::test]
    async fn push_one_file_direct_put_onto_tombstone_reposts_fresh() {
        let server = MockServer::start().await;
        // The direct PUT succeeds but the row stays a tombstone.
        Mock::given(wm_method("PUT"))
            .and(wm_path("/api/collections/c1/blob-objects/o-orig"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "object": {
                    "id": "o-orig", "version": 6, "change_seq": 6,
                    "updated_at": "2026-07-11T00:00:00.000Z",
                    "blob_key": "bk-zombie", "deleted": true
                },
                "collectionVersion": 6
            })))
            .mount(&server)
            .await;
        // The recovery re-POST → a fresh, live object. Must fire exactly once.
        Mock::given(wm_method("POST"))
            .and(wm_path("/api/collections/c1/blob-objects"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "object": {
                    "id": "o-fresh", "version": 1, "change_seq": 7,
                    "updated_at": "2026-07-11T00:00:00.000Z",
                    "blob_key": "bk-fresh", "deleted": false
                },
                "collectionVersion": 7
            })))
            .expect(1)
            .mount(&server)
            .await;
        // A server DELETE here would be a bug — the edit is preserved, not deleted.
        Mock::given(wm_method("DELETE"))
            .respond_with(ResponseTemplate::new(200))
            .expect(0)
            .mount(&server)
            .await;

        let root = temp_root();
        std::fs::write(root.join("edited.md"), "my local edit\n").unwrap();

        let outcome = push_one_file(
            root.clone(),
            test_client(&server),
            Arc::new(TEST_VAULT_KEY),
            "c1".to_owned(),
            local("edited.md", 111, 14),
            // A recorded entry (hash None ⇒ no StampOnly short-circuit) → PUT path.
            Some(map_entry_for("o-orig", 3, "bk-base")),
            HashSet::new(),
            false,
            None,
        )
        .await
        .expect("edit-vs-delete on a direct PUT must resolve, not error");

        match outcome {
            PushOutcome::Wrote { filename, entry, peer_resolved, .. } => {
                assert_eq!(filename, "edited.md");
                assert_eq!(
                    entry.object_id, "o-fresh",
                    "the edit is re-POSTed onto a FRESH live object, not the tombstone",
                );
                assert_eq!(
                    entry.hash.as_deref(),
                    Some(hash_sha256("my local edit\n").as_str()),
                    "the fresh object carries the local edit's content hash",
                );
                assert!(!peer_resolved, "this is our own upload, not a peer download");
            }
            other => panic!("expected Wrote (edit preserved on a fresh object), got {other:?}"),
        }
        // The edited note must remain on disk — push_one_file never deletes it,
        // and the Wrote outcome carries no local write that could erase it.
        assert_eq!(
            std::fs::read_to_string(root.join("edited.md")).unwrap(),
            "my local edit\n",
            "the edited note must remain on disk (no silent loss)",
        );
    }

    // S3: a dedup loser shares the winner's object_id (F9 groups by identity),
    // so its takedown is LOCAL only — remove its file + map entry. It must NOT
    // issue a server DELETE, which would delete the shared object and tombstone
    // the winner. The winner's map entry survives, so a subsequent pull keeps
    // the object.
    #[tokio::test]
    async fn dedup_loser_takedown_is_local_only_and_winner_survives() {
        let server = MockServer::start().await;
        // ANY server DELETE would tombstone the shared object → forbidden.
        Mock::given(wm_method("DELETE"))
            .respond_with(ResponseTemplate::new(200))
            .expect(0)
            .mount(&server)
            .await;

        let root = temp_root();
        std::fs::create_dir_all(root.join("Aaa")).unwrap();
        std::fs::create_dir_all(root.join("Bbb")).unwrap();
        std::fs::write(root.join("Aaa/contested.md"), "same").unwrap(); // winner
        std::fs::write(root.join("Bbb/contested.md"), "same").unwrap(); // loser

        // Winner and loser are the SAME object o1 surfacing under two names.
        let mut state = connected_state(&server);
        state
            .object_map
            .insert("Aaa/contested.md".into(), map_entry_for("o1", 3, "bk-o1"));
        state
            .object_map
            .insert("Bbb/contested.md".into(), map_entry_for("o1", 3, "bk-o1"));

        // A same-content, same-basename delete in this cycle triggers the dedup.
        let deleted = HashMap::from([("h".to_owned(), "old/contested.md".to_owned())]);
        let mut push_h2f = HashMap::new();
        push_h2f.insert(
            "h".to_owned(),
            vec![
                h2f_oid("Aaa/contested.md", 5, "o1"), // winner (higher change_seq)
                h2f_oid("Bbb/contested.md", 3, "o1"), // loser
            ],
        );

        let pre = no_pre_write();
        let res = resolve_concurrent_move_duplicates(
            &mut state,
            &root,
            pre.as_ref(),
            &deleted,
            &push_h2f,
            &HashMap::new(),
        )
        .await
        .expect("dedup");

        assert_eq!(res.deleted_ids, vec!["Bbb/contested".to_owned()], "loser id surfaced");
        assert!(!root.join("Bbb/contested.md").exists(), "loser file removed");
        assert!(root.join("Aaa/contested.md").exists(), "winner file survives");
        assert!(
            state.object_map.contains_key("Aaa/contested.md"),
            "winner stays mapped to the shared object",
        );
        assert!(!state.object_map.contains_key("Bbb/contested.md"), "loser unmapped");
        assert_eq!(state.object_map["Aaa/contested.md"].object_id, "o1");
        // `.expect(0)` on the DELETE mock is asserted here when `server` drops.
    }

    // PKT-16 regression (F32): a crash between run_push's state persist and the
    // pull phase must NOT permanently hide a peer change that was un-pulled
    // before the crash. run_push folds the pushed blobs' change_seqs into the
    // persisted cursor mid-push (the interim checkpoint, the tail flush, and the
    // final persist); if the process dies before the pull completes, the restart
    // must still derive a pull `since` low enough to re-list the un-pulled peer
    // object. The in-process `pre_push_max` guard only protects one run_sync
    // call — across a crash the persisted cursor is all that survives, so
    // persisting only the elevated push watermark defeats it.
    //
    // Setup: a peer object at change_seq 3 sits un-pulled on the server (our
    // cursor is 0). We push 55 local notes (> PUSH_CHECKPOINT_EVERY = 50) which
    // the server stamps at change_seq 100 — firing the interim checkpoint — then
    // CRASH before pulling. On restart, a full run_sync must still deliver the
    // peer object.
    #[tokio::test]
    async fn crash_between_push_persist_and_pull_still_delivers_peer_change() {
        let server = MockServer::start().await;

        // Every pushed object is stamped change_seq 100 — well above the peer's 3.
        Mock::given(wm_method("POST"))
            .and(wm_path("/api/collections/c1/blob-objects"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "object": {
                    "id": "pushed", "version": 1, "change_seq": 100,
                    "blob_key": "bk-pushed", "deleted": false,
                    "updated_at": "2026-05-13T00:00:00.000Z"
                },
                "collectionVersion": 100
            })))
            .mount(&server)
            .await;
        // The un-pulled peer object (change_seq 3): visible from since=0,
        // invisible from the crash-elevated since=100.
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/collections/c1/objects"))
            .and(query_param("sinceVersion", "0"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "objects": [wire_object("peer", 3, None)]
            })))
            .mount(&server)
            .await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/collections/c1/objects"))
            .and(query_param("sinceVersion", "100"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "objects": []
            })))
            .mount(&server)
            .await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/blobs/bk-peer"))
            .respond_with(
                ResponseTemplate::new(200).set_body_bytes(enc("peer.md", "peer body\n").await),
            )
            .mount(&server)
            .await;

        let root = temp_root();
        for i in 0..55 {
            std::fs::write(root.join(format!("note{i:02}.md")), format!("body {i}\n")).unwrap();
        }

        // Phase 1: push, then CRASH — discard the returned in-memory state, so
        // the pre_push_max guard dies with the process exactly as it would on a
        // real crash. Only what run_push persisted to disk survives.
        let (_summary, _after_push) = run_push(&connected_state(&server), &root, &no_prog, &no_pre)
            .await
            .expect("push");

        // Phase 2: RESTART — reload the persisted state exactly as connect/resume
        // do, then run a full sync. The populated map means the restart does NOT
        // take the empty-map reconcile path; it must still deliver the peer edit.
        let loaded = state::load(&root);
        assert!(
            !loaded.object_map.is_empty(),
            "restart avoids the empty-map reconcile path"
        );
        let restart = ConnectedState {
            base_url: server.uri(),
            token: "test-token".into(),
            user_id: "u1".into(),
            collection_id: "c1".into(),
            vault_key: TEST_VAULT_KEY,
            object_map: loaded.object_map,
            max_version: loaded.max_version,
            pull_cursor: loaded.pull_cursor,
            oversize_skip: HashMap::new(),
        };
        run_sync(&restart, &root, &no_prog, &no_pre)
            .await
            .expect("restart sync");

        assert!(
            root.join("peer.md").exists(),
            "peer object (change_seq 3) was un-pulled before the crash and must \
             still be delivered on the restart sync"
        );
    }

    // PKT-16 migration (F32 retroactive heal): an install upgrading from a
    // pre-fix build may carry a `.e2ee-state.json` with NO `pull_cursor` field
    // and a `max_version` already elevated by a pre-fix mid-push crash — hiding
    // un-pulled peer changes. The first post-upgrade sync must HEAL this by
    // re-listing from 0 and delivering the hidden peer object, WITHOUT churning
    // (no re-downloads / conflict copies) the already-synced objects. This
    // reproduces a realistic pre-field file by pushing notes (which writes a
    // proper state file), stripping the `pull_cursor` key, then syncing.
    #[tokio::test]
    async fn pre_field_state_first_sync_heals_hidden_peer_no_churn() {
        let server = MockServer::start().await;

        Mock::given(wm_method("POST"))
            .and(wm_path("/api/collections/c1/blob-objects"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "object": {
                    "id": "pushed", "version": 1, "change_seq": 100,
                    "blob_key": "bk-pushed", "deleted": false,
                    "updated_at": "2026-05-13T00:00:00.000Z"
                },
                "collectionVersion": 100
            })))
            .mount(&server)
            .await;
        // Post-upgrade heal pull (since=0) lists only the hidden peer object.
        // The already-pushed objects are NOT re-listed here, so any attempt to
        // re-download them would 404 (no blob mock) and surface as a failure —
        // the assertions below therefore also prove "no churn".
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/collections/c1/objects"))
            .and(query_param("sinceVersion", "0"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "objects": [wire_object("peer", 3, None)]
            })))
            .mount(&server)
            .await;
        // The pre-fix (buggy) path would pull from the elevated cursor (100) and
        // find nothing — this mock makes that path observable as a RED failure.
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/collections/c1/objects"))
            .and(query_param("sinceVersion", "100"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "objects": []
            })))
            .mount(&server)
            .await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/blobs/bk-peer"))
            .respond_with(
                ResponseTemplate::new(200).set_body_bytes(enc("peer.md", "peer body\n").await),
            )
            .mount(&server)
            .await;

        let root = temp_root();
        for i in 0..3 {
            std::fs::write(root.join(format!("note{i}.md")), format!("body {i}\n")).unwrap();
        }
        // Write a realistic state file (correct hashes/mtimes, elevated
        // max_version=100) by pushing.
        run_push(&connected_state(&server), &root, &no_prog, &no_pre)
            .await
            .expect("seed push");

        // Downgrade the file to a PRE-FIELD one: strip the pull_cursor key so
        // load() treats it as untrusted. Assert the max_version really is
        // elevated (the F32 hazard) before we strip.
        let path = state::state_file_path(&root);
        let raw = std::fs::read_to_string(&path).unwrap();
        let mut json: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert!(json.get("pull_cursor").is_some(), "push wrote a pull_cursor");
        assert_eq!(json["max_version"].as_u64(), Some(100), "cursor elevated by push");
        json.as_object_mut().unwrap().remove("pull_cursor");
        std::fs::write(&path, serde_json::to_string(&json).unwrap()).unwrap();

        // First post-upgrade sync (load exactly as connect/resume do).
        let loaded = state::load(&root);
        assert_eq!(loaded.max_version, 100, "elevated max survives load");
        assert_eq!(loaded.pull_cursor, 0, "absent pull_cursor is distrusted → 0");
        let state = ConnectedState {
            base_url: server.uri(),
            token: "test-token".into(),
            user_id: "u1".into(),
            collection_id: "c1".into(),
            vault_key: TEST_VAULT_KEY,
            object_map: loaded.object_map,
            max_version: loaded.max_version,
            pull_cursor: loaded.pull_cursor,
            oversize_skip: HashMap::new(),
        };
        let (summary, _after) = run_sync(&state, &root, &no_prog, &no_pre)
            .await
            .expect("heal sync");

        // The hidden peer edit is delivered.
        assert!(root.join("peer.md").exists(), "F32 heal: hidden peer object delivered");
        // No churn: only the peer downloaded, no failures, no conflict copies.
        assert_eq!(summary.downloaded, 1, "only the hidden peer is downloaded, not the synced notes");
        assert!(summary.failures.is_empty(), "no re-download failures: {:?}", summary.failures);
        assert_eq!(summary.conflicts, 0, "no conflict copies minted for already-synced notes");
        let md_files: Vec<_> = std::fs::read_dir(&root)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("md"))
            .collect();
        assert_eq!(md_files.len(), 4, "3 synced notes + peer.md, no conflict copies: {md_files:?}");
    }
}
