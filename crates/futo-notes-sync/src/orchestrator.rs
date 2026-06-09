//! Tauri-free E2EE sync orchestrator.
//!
//! This is the FULL orchestrator relocated verbatim from the desktop's
//! `apps/tauri/src-tauri/src/sync.rs` so the crate is the single source of
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
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Instant;

use futo_notes_core::e2ee::{
    self, collision_conflict_filename, collision_key, conflict_filename, KeyMaterial, MergeResult,
    KEY_BYTES,
};
use futo_notes_core::files::{
    file_mtime_ms, now_ms, safe_note_path, set_file_mtime_ms, write_atomic_text,
};
use futo_notes_core::hash::hash_sha256;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use crate::client::{
    parse_iso_ms, AuthMode, ConflictResponse, DeleteResult, E2eeClient, PutResult, ServerObject,
};
use crate::state::{self, ConnectedState, E2eeObjectMapEntry};

const PULL_CONCURRENCY: usize = 8;
const PUSH_CONCURRENCY: usize = 8;
const PROGRESS_COALESCE_MS: i64 = 50;

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

/// One-shot recursive readdir+stat for `.md` files. Skips hidden dirs/files
/// (`.git`, `.obsidian`, `.e2ee-state.json`, etc.) so sync state and VCS
/// metadata never enter the object map.
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
        } else if file_type.is_file() && name.ends_with(".md") {
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
/// absolute roots, no `..` traversal, no empty components, must end in
/// `.md`. Returns the validated joined path.
fn safe_relative_md_path(base: &Path, rel: &str) -> Result<PathBuf, String> {
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
    if !normalized.ends_with(".md") {
        return Err("path must end in .md".into());
    }
    Ok(path)
}

/// Apply a batch of sync writes/deletes/conflict-copies to disk.
///
/// Relocated from `core.rs::apply_sync_delta_v2_impl` with Rule 2 applied:
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
        let path = match safe_relative_md_path(notes_root, filename) {
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
        let path = safe_relative_md_path(notes_root, &update.filename)?;
        // write_atomic_text already calls fs::create_dir_all on the parent.
        write_atomic_text(&path, &update.content)?;

        // 0 means "no timestamp from server" — keep the filesystem's own mtime
        if update.modified_at > 0 {
            let _ = set_file_mtime_ms(&path, update.modified_at);
        }

        updated_filenames.push(update.filename.clone());
    }

    // Write conflict copies
    for conflict in &input.conflicts {
        pre_write(&conflict.filename);
        let path = safe_relative_md_path(notes_root, &conflict.filename)?;
        write_atomic_text(&path, &conflict.content)?;
        conflict_filenames.push(conflict.filename.clone());
    }

    // Correct local file mtimes from server-authoritative timestamps.
    // This fixes files that were already up-to-date (same hash) but had wrong mtimes.
    for (filename, server_mtime) in &input.timestamps {
        if *server_mtime > 0 {
            let path = match safe_relative_md_path(notes_root, filename) {
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
            let (vk, fresh) =
                wrap_blocking(password.to_owned()).await.map_err(SyncErrorKind::crypto)?;
            http.put_key_material(&collection_id, &fresh)
                .await
                .map_err(SyncErrorKind::http)?;
            vk
        }
    };

    let loaded = state::load(notes_root).reset_if_collection_changed(&collection_id);
    let connected = ConnectedState {
        base_url: server_url.to_owned(),
        token: login.token.clone(),
        user_id: login.user_id.clone(),
        collection_id: collection_id.clone(),
        vault_key,
        object_map: loaded.object_map,
        max_version: loaded.max_version,
    };

    // Persist right away so a crash mid-sync recovers the loaded map.
    state::persist(
        notes_root,
        &connected.object_map,
        connected.max_version,
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

    let material = http
        .get_key_material(collection_id)
        .await
        .map_err(SyncErrorKind::http)?
        .ok_or_else(|| SyncErrorKind::Crypto("vault key material missing on server".to_owned()))?;

    let vault_key = unwrap_blocking(password.to_owned(), material)
        .await
        .map_err(SyncErrorKind::crypto)?;

    let loaded = state::load(notes_root).reset_if_collection_changed(collection_id);
    Ok(ConnectedState {
        base_url: server_url.to_owned(),
        token: token.to_owned(),
        user_id: user_id.to_owned(),
        collection_id: collection_id.to_owned(),
        vault_key,
        object_map: loaded.object_map,
        max_version: loaded.max_version,
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

    pub(crate) deleted_hashes: HashMap<String, String>,
    pub(crate) created_hashes: HashMap<String, String>,
    /// hash → all (filename, change_seq) pairs this phase wrote with that
    /// hash. Used by `resolve_concurrent_move_duplicates` to spot two
    /// clients moving the same content to two different paths in the same
    /// cycle. Internal-only.
    pub(crate) hash_to_filenames: HashMap<String, Vec<HashFilenameEntry>>,
}

#[derive(Debug, Clone)]
pub struct HashFilenameEntry {
    pub filename: String,
    pub change_seq: u64,
}

/// Bare per-cycle counts, used only as the live-loop's callback transport
/// (`live.rs`'s `LiveHandle`). The rich orchestrator results are `SyncSummary`;
/// this is the thin projection the SSE loop hands to `on_synced`.
#[derive(Debug, Default, Clone)]
pub struct SyncCounts {
    pub uploaded: u32,
    pub downloaded: u32,
    pub deleted: u32,
    pub conflicts: u32,
}

impl SyncCounts {
    pub fn add(&mut self, other: &SyncCounts) {
        self.uploaded += other.uploaded;
        self.downloaded += other.downloaded;
        self.deleted += other.deleted;
        self.conflicts += other.conflicts;
    }
}

impl From<&SyncSummary> for SyncCounts {
    fn from(s: &SyncSummary) -> Self {
        SyncCounts {
            uploaded: s.uploaded,
            downloaded: s.downloaded,
            deleted: s.deleted,
            conflicts: s.conflicts,
        }
    }
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
) {
    map.entry(hash)
        .or_default()
        .push(HashFilenameEntry { filename, change_seq });
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

async fn download_and_decrypt(
    http: Arc<E2eeClient>,
    vault_key: Arc<[u8; KEY_BYTES]>,
    obj: ServerObject,
) -> Result<DownloadedNote, String> {
    let blob_key = obj.blob_key.clone().ok_or("server object has no blob_key")?;
    let ciphertext = http.get_blob(&blob_key).await.map_err(http_err_to_string)?;
    // Decrypt + unpack are CPU work; keep them inline — fast enough that
    // spawn_blocking overhead would dominate for typical 5KB notes.
    let plaintext = e2ee::aes_gcm_decrypt(&vault_key, &ciphertext).map_err(e2ee_err_to_string)?;
    let note = e2ee::unpack_note(&plaintext).map_err(e2ee_err_to_string)?;
    let hash = hash_sha256(&note.content);
    let modified_at_ms = parse_iso_ms(&obj.updated_at).unwrap_or_else(now_ms);
    Ok(DownloadedNote {
        object_id: obj.id,
        version: obj.version,
        change_seq: obj.change_seq,
        blob_key,
        filename: note.path,
        content: note.content,
        hash,
        modified_at_ms,
    })
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
        for loser in &members[1..] {
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
        .map_err(SyncErrorKind::http)?;

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

    // Spawn one task per object, gated by a semaphore. JoinSet collects
    // results as they finish so the await loop below is order-independent.
    let total_to_download = to_download.len();
    let progress_emitter = ProgressEmitter::new(progress, "pulling", total_to_download);
    let semaphore = Arc::new(Semaphore::new(PULL_CONCURRENCY));
    let mut set: JoinSet<Result<DownloadedNote, String>> = JoinSet::new();
    for obj in to_download {
        let permit_sem = semaphore.clone();
        let http = http.clone();
        let vault_key = vault_key.clone();
        set.spawn(async move {
            // The permit drops at the end of the task scope, freeing a slot.
            let _permit = permit_sem.acquire_owned().await.expect("semaphore closed");
            download_and_decrypt(http, vault_key, obj).await
        });
    }

    let mut downloaded: Vec<DownloadedNote> = Vec::new();
    while let Some(joined) = set.join_next().await {
        match joined {
            Ok(Ok(note)) => {
                downloaded.push(note);
                progress_emitter.bump();
            }
            Ok(Err(e)) => {
                eprintln!("[e2ee] blob download failed: {e}");
                progress_emitter.bump();
            }
            Err(e) => {
                eprintln!("[e2ee] task panicked: {e}");
                progress_emitter.bump();
            }
        }
    }

    // Build apply-delta input. Renames-in-place: same objectId now points
    // at a different filename — drop the old one as a delete here so the
    // map stays consistent with disk.
    let mut updates: Vec<V2IncomingUpdate> = Vec::with_capacity(downloaded.len());
    let mut deletes: HashSet<String> = immediate_deletes.iter().cloned().collect();
    let mut updated_ids: Vec<String> = Vec::with_capacity(downloaded.len());
    let mut deleted_ids: Vec<String> = immediate_deletes.iter().map(|f| filename_to_id(f)).collect();

    // F4/F5: resolve filename collisions across the UNION of this pull's
    // downloads AND the persisted object_map BEFORE materializing anything, so
    // a freshly-pulled object can never overwrite a same-key object that is
    // already on disk (case variant, or NFC-vs-NFD). The plan tells us which
    // downloads must be parked at a conflict name and which already-on-disk
    // map entries must be moved aside. Tombstoned files (immediate deletes +
    // in-place rename sources) are excluded from the collision set.
    let mut tombstoned: HashSet<String> = immediate_deletes.iter().cloned().collect();
    for note in &downloaded {
        if let Some(prev) = filename_by_object_id.get(&note.object_id) {
            if prev != &note.filename {
                tombstoned.insert(prev.clone());
            }
        }
    }
    let collision_plan =
        resolve_pull_collisions(&downloaded, &state_cell.object_map, &tombstoned);

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
        let path = match safe_relative_md_path(notes_root_path, &mv.old_filename) {
            Ok(p) => p,
            Err(_) => continue,
        };
        let content = tokio::task::spawn_blocking(move || std::fs::read_to_string(&path).ok())
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

    // The apply path writes files atomically + records watcher suppressions
    // (via pre_write). Runs synchronously; pure disk work.
    if !apply_input.update.is_empty() || !apply_input.delete.is_empty() {
        apply_delta(notes_root_path, pre_write, apply_input)?;
    }

    // Update the working copy's map + max_version, then persist.
    let downloaded_count = downloaded.len();
    let deletes_count = deletes.len();
    let new_max = new_max_version;
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
    next.max_version = next.max_version.max(new_max);
    state::persist(notes_root_path, &next.object_map, next.max_version, &next.collection_id)
        .map_err(SyncErrorKind::Io)?;

    Ok((
        SyncSummary {
            downloaded: downloaded_count as u32,
            deleted: deletes_count as u32,
            updated_ids: updated_ids.clone(),
            deleted_ids: deleted_ids.clone(),
            peer_updated_ids: updated_ids,
            peer_deleted_ids: deleted_ids,
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
    /// Tried to resolve but couldn't (e.g. merge-base GC'd AND inline
    /// retry failed). Counted toward `conflicts` so the UI can surface it.
    UnresolvedConflict { filename: String },
    /// HTTP error logged; not surfaced as a hard fail so one bad file
    /// doesn't abort the whole sync.
    Error,
}

async fn read_local_note(notes_root: &Path, filename: &str) -> Result<String, String> {
    // filename is "<id>.md"; safe_note_path expects the id only.
    let id = match filename.strip_suffix(".md") {
        Some(i) => i,
        None => return Err(format!("local file lacks .md suffix: {filename}")),
    };
    let path = safe_note_path(notes_root, id)?;
    tokio::task::spawn_blocking(move || std::fs::read_to_string(&path).map_err(|e| e.to_string()))
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
) -> Result<PushOutcome, String> {
    let current_blob_key = match conflict.current_blob_key.clone() {
        Some(k) => k,
        None => return Ok(PushOutcome::UnresolvedConflict { filename: filename.to_owned() }),
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
    let base_content: Option<String> = match http.get_blob(&existing.blob_key).await {
        Ok(ct) => e2ee::aes_gcm_decrypt(&vault_key, &ct)
            .ok()
            .and_then(|p| e2ee::unpack_note(&p).ok())
            .map(|n| n.content),
        Err(_) => None,
    };

    if let Some(base) = base_content {
        if let MergeResult::Clean(merged) = e2ee::three_way_merge_text(&base, &remote.content, &local_content) {
            let merged_hash = hash_sha256(&merged);
            let merged_size = merged.as_bytes().len() as u64;
            let merged_ct = encrypt_note(&vault_key, &target_filename, &merged).await?;
            match http
                .put_blob_object(collection_id, &existing.object_id, conflict.current_version + 1, merged_ct)
                .await
                .map_err(http_err_to_string)?
            {
                PutResult::Ok(resp) => {
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

    // Conflict-copy path: keep the remote on the target filename and
    // park the user's local edits in `note (conflict YYYY-MM-DD).md`.
    let date = current_date_yyyy_mm_dd();
    let copy_filename = conflict_filename(&target_filename, &date, &namespace);
    let copy_ct = encrypt_note(&vault_key, &copy_filename, &local_content).await?;
    let created = http
        .post_blob_object(collection_id, copy_ct)
        .await
        .map_err(http_err_to_string)?;

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
) -> Result<PushOutcome, String> {
    let filename = file.name.clone();
    let content = match read_local_note(&notes_root, &filename).await {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[e2ee] could not read {filename}: {e}");
            return Ok(PushOutcome::Error);
        }
    };
    let hash = hash_sha256(&content);
    let size = content.as_bytes().len() as u64;

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

    let ciphertext = encrypt_note(&vault_key, &filename, &content).await?;

    // No prior entry → POST as a new object.
    if existing.is_none() {
        let created = match http.post_blob_object(&collection_id, ciphertext).await {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[e2ee] failed to create {filename}: {e}");
                return Ok(PushOutcome::Error);
            }
        };
        let entry = E2eeObjectMapEntry {
            object_id: created.object_id,
            version: created.version,
            blob_key: created.blob_key,
            hash: Some(hash),
            mtime_ms: Some(created.updated_at),
            size_bytes: Some(size),
        };
        return Ok(PushOutcome::Wrote {
            filename,
            entry,
            modified_at: created.updated_at,
            change_seq: created.change_seq,
            peer_resolved: false,
        });
    }

    // Update path: PUT with expected_version; 409 → resolve.
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
            )
            .await
        }
        Err(e) => {
            eprintln!("[e2ee] failed to update {filename}: {e}");
            Ok(PushOutcome::Error)
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
    // Drop non-`.md` rows just in case (`list_notes_with_meta`
    // already filters, but defense-in-depth keeps push logic local).
    let local_files: Vec<NoteFileMeta> = local_files
        .into_iter()
        .filter(|f| f.name.ends_with(".md"))
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
                    if let Err(e) =
                        state::persist(notes_root_path, &next.object_map, next.max_version, &next.collection_id)
                    {
                        eprintln!("[e2ee] push checkpoint persist failed: {e}");
                    }
                    since_ckpt = 0;
                }
            }
            Ok(Err(e)) => {
                eprintln!("[e2ee] push task errored: {e}");
                progress_emitter.bump();
            }
            Err(e) => {
                eprintln!("[e2ee] push task panicked: {e}");
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
        if let Err(e) = state::persist(notes_root_path, &next.object_map, next.max_version, &next.collection_id) {
            eprintln!("[e2ee] push final checkpoint persist failed: {e}");
        }
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
                    }
                    Err(e) => {
                        eprintln!("[e2ee] delete-conflict restore failed for {filename}: {e}");
                    }
                }
            }
            Err(e) => {
                eprintln!("[e2ee] delete failed for {filename}: {e}");
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
                upserts.push((filename.clone(), entry.clone()));
                if let Some(ts) = entry.mtime_ms {
                    timestamps.insert(filename.clone(), ts);
                }
            }
            PushOutcome::Wrote { filename, entry, modified_at, change_seq, peer_resolved } => {
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
                    add_hash_filename(&mut hash_to_filenames, h, filename.clone(), change_seq);
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
            PushOutcome::UnresolvedConflict { filename } => {
                conflicts += 1;
                eprintln!("[e2ee] unresolved conflict on {filename}");
            }
            PushOutcome::Error => {}
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
                // Remove the old (deleted-locally) entry and write the
                // restored blob in its place. If the restore landed on a
                // different filename (server-renamed during the race) the
                // old filename gets dropped from the map too.
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
                // The peer's content was just written back to disk via the
                // edit-wins restore. This is a real peer download — count it
                // so totals are honest. The subsequent run_pull sees this
                // object already at the restored version and skips it, so
                // there's no double-counting.
                downloaded += 1;
            }
        }
    }

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
    state::persist(notes_root_path, &next.object_map, next.max_version, &next.collection_id)
        .map_err(SyncErrorKind::Io)?;

    Ok((
        SyncSummary {
            uploaded,
            downloaded,
            deleted: removes.len() as u32,
            conflicts,
            updated_ids,
            deleted_ids,
            peer_updated_ids,
            peer_deleted_ids,
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

/// Result of a duplicate-move resolution pass. `deleted_ids` are the
/// note ids whose synced filename we just took down (locally + on the
/// server); `conflicts` matches the legacy TS counter for the user-
/// facing "N conflicts resolved" badge.
#[derive(Debug, Default)]
struct DuplicateResolution {
    conflicts: u32,
    deleted_ids: Vec<String>,
}

/// Concurrent-move convergence: when two clients in the same cycle move
/// the same content to two different paths, both creations land on the
/// server side-by-side and pull happily writes both locally. Mirrors
/// `resolveConcurrentMoveDuplicates` from the deleted TS implementation.
///
/// For each hash that was deleted somewhere in this cycle (push or pull
/// side), pull the union of pushed + pulled creates with that same hash
/// whose filename differs from the deleted one AND shares its basename.
/// If two or more distinct filenames qualify, the highest-`change_seq`
/// wins (server-side last-write-wins) and the losers are deleted on
/// both server and local disk.
///
/// Rule 3: mutates the caller's owned working `state` in place (and
/// persists), since `delete_synced_filename` re-reads + advances it.
async fn resolve_concurrent_move_duplicates(
    state: &mut ConnectedState,
    notes_root_path: &Path,
    pre_write: &PreWriteFn,
    deleted_hashes: &HashMap<String, String>,
    push_h2f: &HashMap<String, Vec<HashFilenameEntry>>,
    pull_h2f: &HashMap<String, Vec<HashFilenameEntry>>,
) -> Result<DuplicateResolution, SyncErrorKind> {
    let mut out = DuplicateResolution::default();

    let http = Arc::new(build_client(state)?);

    for (hash, from_filename) in deleted_hashes {
        let losers = pick_duplicate_move_losers(from_filename, hash, push_h2f, pull_h2f);
        for loser in losers {
            if delete_synced_filename(&http, state, notes_root_path, pre_write, &loser.filename)
                .await?
            {
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
fn pick_duplicate_move_losers(
    from_filename: &str,
    hash: &str,
    push_h2f: &HashMap<String, Vec<HashFilenameEntry>>,
    pull_h2f: &HashMap<String, Vec<HashFilenameEntry>>,
) -> Vec<HashFilenameEntry> {
    let from_base = filename_basename(from_filename);
    let mut unique: HashMap<String, HashFilenameEntry> = HashMap::new();
    for src in [push_h2f.get(hash), pull_h2f.get(hash)].into_iter().flatten() {
        for cand in src {
            if cand.filename == from_filename {
                continue;
            }
            if filename_basename(&cand.filename) != from_base {
                continue;
            }
            unique.insert(cand.filename.clone(), cand.clone());
        }
    }
    if unique.len() <= 1 {
        return Vec::new();
    }
    let mut sorted: Vec<HashFilenameEntry> = unique.into_values().collect();
    // Highest change_seq wins; lexicographic filename order breaks ties
    // (matches `localeCompare` close enough for ASCII paths).
    sorted.sort_by(|a, b| {
        b.change_seq
            .cmp(&a.change_seq)
            .then_with(|| a.filename.cmp(&b.filename))
    });
    sorted.into_iter().skip(1).collect()
}

/// Delete a single synced file on both the server and locally, updating
/// the working object map (and persisting it). Returns true if the delete
/// went through; false if there was nothing to delete or the server
/// refused. Mirrors the legacy TS `deleteSyncedFilename`.
///
/// Rule 3: mutates the caller's owned working `state` in place where the
/// desktop did `state.with_map_mut` + `state.persist`.
async fn delete_synced_filename(
    http: &Arc<E2eeClient>,
    state: &mut ConnectedState,
    notes_root_path: &Path,
    pre_write: &PreWriteFn,
    filename: &str,
) -> Result<bool, SyncErrorKind> {
    let (collection_id, entry) = match state.object_map.get(filename).cloned() {
        Some(e) => (state.collection_id.clone(), e),
        None => return Ok(false),
    };

    let change_seq = match http
        .delete_object(&collection_id, &entry.object_id, entry.version)
        .await
    {
        Ok(DeleteResult::Ok(ok)) => ok.change_seq,
        Ok(DeleteResult::Conflict(_)) => {
            eprintln!(
                "[e2ee] duplicate-move delete refused (409) for {filename}; leaving alone"
            );
            return Ok(false);
        }
        Err(e) => {
            eprintln!(
                "[e2ee] duplicate-move delete failed for {filename}: {}",
                http_err_to_string(e)
            );
            return Ok(false);
        }
    };

    let apply_input = V2SyncApplyInput {
        update: Vec::new(),
        delete: vec![filename.to_owned()],
        conflicts: Vec::new(),
        timestamps: HashMap::new(),
    };
    apply_delta(notes_root_path, pre_write, apply_input)?;

    state.object_map.remove(filename);
    if change_seq > state.max_version {
        state.max_version = change_seq;
    }
    state::persist(notes_root_path, &state.object_map, state.max_version, &state.collection_id)
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
        .map_err(SyncErrorKind::http)?;

    // Live objects only (deleted tombstones contribute no blob to reconcile).
    let live: Vec<ServerObject> = server_objects
        .into_iter()
        .filter(|o| !o.deleted && o.blob_key.is_some())
        .collect();
    if live.is_empty() {
        return Ok((SyncSummary::default(), state_cell.clone()));
    }

    // Index local files by name so we can compare without re-walking
    // disk per object. list_notes_with_meta already filters to
    // `.md` and skips dotfile dirs.
    let root_for_walk = notes_root_path.to_path_buf();
    let local_files = tokio::task::spawn_blocking(move || list_notes_with_meta(&root_for_walk))
        .await
        .map_err(task_join_err)?;
    let local_by_name: HashMap<String, (i64, u64)> = local_files
        .iter()
        .filter(|f| f.name.ends_with(".md"))
        .map(|f| (f.name.clone(), (f.mtime_ms, f.size_bytes)))
        .collect();

    let total = live.len();
    let progress_emitter = ProgressEmitter::new(progress, "reconciling", total);
    let semaphore = Arc::new(Semaphore::new(PULL_CONCURRENCY));
    let mut set: JoinSet<Result<DownloadedNote, String>> = JoinSet::new();
    for obj in live {
        let http = http.clone();
        let vault_key = vault_key.clone();
        let permit_sem = semaphore.clone();
        set.spawn(async move {
            let _permit = permit_sem.acquire_owned().await.expect("semaphore closed");
            download_and_decrypt(http, vault_key, obj).await
        });
    }

    let mut downloaded: Vec<DownloadedNote> = Vec::with_capacity(total);
    while let Some(joined) = set.join_next().await {
        match joined {
            Ok(Ok(d)) => {
                downloaded.push(d);
                progress_emitter.bump();
            }
            Ok(Err(e)) => {
                eprintln!("[e2ee] reconcile: download failed: {e}");
                progress_emitter.bump();
            }
            Err(e) => {
                eprintln!("[e2ee] reconcile: task panicked: {e}");
                progress_emitter.bump();
            }
        }
    }

    // F4/F5: two distinct server objects can carry names that collide on a
    // case/normalization-insensitive FS (same name from two clients; NFC vs
    // NFD). On a fresh empty-map reconcile they would BOTH adopt the same
    // on-disk path and the second write would clobber the first — one note
    // lost. Resolve collisions over the download set first: the smallest
    // object_id keeps the canonical name; the rest are parked at deterministic
    // conflict copies. (The map is empty here, so only download_overrides can
    // be produced.)
    let collision_plan =
        resolve_pull_collisions(&downloaded, &state_cell.object_map, &HashSet::new());

    // For each remote note: compare to local (if any) and decide
    // whether to write, skip, or omit mtime/size to flag divergence.
    let mut updates: Vec<V2IncomingUpdate> = Vec::new();
    let mut timestamps: HashMap<String, i64> = HashMap::new();
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
                // Local file present — read its content to compare.
                let path = notes_root_path.join(&target_name);
                let local_content = tokio::task::spawn_blocking(move || {
                    std::fs::read_to_string(&path).ok()
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
                        let local_hash = hash_sha256(&content);
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

    // Apply file writes for remote-only adoptions — plus mtime corrections
    // for identical-content matches — via the shared apply path so watcher
    // suppressions are recorded.
    if !updates.is_empty() || !timestamps.is_empty() {
        let apply_input = V2SyncApplyInput {
            update: updates,
            delete: Vec::new(),
            conflicts: Vec::new(),
            timestamps,
        };
        apply_delta(notes_root_path, pre_write, apply_input)?;
    }

    // Populate the map and advance max_version, then persist.
    let mut next = state_cell.clone();
    for (filename, entry) in upserts {
        next.object_map.insert(filename, entry);
    }
    next.max_version = next.max_version.max(new_max_version);
    state::persist(notes_root_path, &next.object_map, next.max_version, &next.collection_id)
        .map_err(SyncErrorKind::Io)?;

    // Surface adoptions as real downloads. Without this the empty-map
    // reconcile path writes peer content to disk but contributes nothing
    // to the SyncSummary, so the TS rescan gate (`hasPeerNoteChanges`)
    // never fires and the sidebar misses the new note.
    let adopted_ids: Vec<String> = adopted.iter().map(|f| filename_to_id(f)).collect();
    let summary = SyncSummary {
        downloaded: adopted.len() as u32,
        updated_ids: adopted_ids.clone(),
        peer_updated_ids: adopted_ids,
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

    // Capture the pre-push cursor BEFORE push runs. Push advances
    // `max_version` for our own writes; using the post-push value for
    // `since` would silently drop any peer changes whose `change_seq`
    // landed in the interval. (Mirrors `prePushMaxVersion` in TS.)
    let pre_push_max = working.max_version;

    let (push_summary, after_push) =
        run_push(&working, notes_root_path, progress, pre_write).await?;
    let (pull_summary, after_pull) =
        run_pull(&after_push, notes_root_path, pre_push_max, progress, pre_write).await?;
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
fn fold_reconcile_summary(mut combined: SyncSummary, reconcile: SyncSummary) -> SyncSummary {
    if reconcile.downloaded == 0 {
        return combined;
    }
    combined.downloaded += reconcile.downloaded;
    for id in reconcile.updated_ids {
        if !combined.updated_ids.iter().any(|x| x == &id) {
            combined.updated_ids.push(id);
        }
    }
    for id in reconcile.peer_updated_ids {
        if !combined.peer_updated_ids.iter().any(|x| x == &id) {
            combined.peer_updated_ids.push(id);
        }
    }
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
            | SyncErrorKind::Auth(s) => s.clone(),
            SyncErrorKind::NotConnected => "not connected".to_owned(),
        }
    }
}

/// `String` errors come from the filesystem helpers (`apply_delta`,
/// `read_local_note`, `safe_relative_md_path`); they're all I/O failures.
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
    // Migrated unchanged from apps/tauri/src-tauri/src/sync.rs's test module
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
        HashFilenameEntry {
            filename: filename.to_owned(),
            change_seq,
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
        // A moves contested → FolderA at change_seq=3, B moves it →
        // FolderB at change_seq=5. B wins; FolderA must lose.
        let mut push = HashMap::new();
        push.insert("hX".to_owned(), vec![h2f("FolderB/contested.md", 5)]);
        let mut pull = HashMap::new();
        pull.insert("hX".to_owned(), vec![h2f("FolderA/contested.md", 3)]);
        let losers = pick_duplicate_move_losers("contested.md", "hX", &push, &pull);
        assert_eq!(losers.len(), 1);
        assert_eq!(losers[0].filename, "FolderA/contested.md");
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
        // Both creates at the same change_seq → tie-break by filename
        // (Aaa wins, Bbb loses) so the result is deterministic across
        // clients.
        let mut push = HashMap::new();
        push.insert(
            "hX".to_owned(),
            vec![h2f("Bbb/contested.md", 7), h2f("Aaa/contested.md", 7)],
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
    fn safe_relative_md_path_rejects_traversal() {
        let base = Path::new("/tmp/x");
        assert!(safe_relative_md_path(base, "../escape.md").is_err());
        assert!(safe_relative_md_path(base, "/abs.md").is_err());
        assert!(safe_relative_md_path(base, "no-ext").is_err());
        assert!(safe_relative_md_path(base, "ok.md").is_ok());
        assert!(safe_relative_md_path(base, "Specs/ok.md").is_ok());
    }

    #[test]
    fn list_notes_skips_hidden_and_finds_md() {
        let root = temp_root();
        std::fs::write(root.join("a.md"), "alpha").unwrap();
        std::fs::create_dir_all(root.join("Specs")).unwrap();
        std::fs::write(root.join("Specs/b.md"), "beta").unwrap();
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
        assert!(!names.contains("ignore.txt"));
        assert!(!names.iter().any(|n| n.contains(".git")));
        assert_eq!(names.len(), 2);
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

    fn dnote(object_id: &str, filename: &str) -> DownloadedNote {
        DownloadedNote {
            object_id: object_id.to_owned(),
            version: 1,
            change_seq: 1,
            blob_key: "bk".to_owned(),
            filename: filename.to_owned(),
            content: "x".to_owned(),
            hash: "h".to_owned(),
            modified_at_ms: 1,
        }
    }

    fn map_entry_oid(object_id: &str) -> E2eeObjectMapEntry {
        E2eeObjectMapEntry {
            object_id: object_id.to_owned(),
            version: 1,
            blob_key: "bk".to_owned(),
            hash: Some("h".to_owned()),
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
}
