//! E2EE sync orchestrator + Tauri command surface.
//!
//! Steps 5–6: connect / resume / status / disconnect commands plus the
//! pull side of `e2ee_sync_run`. Push + conflict resolution land in step 7.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::sync::Arc;

use futo_notes_core::e2ee::{self, conflict_filename, KeyMaterial, MergeResult, KEY_BYTES};
use futo_notes_core::files::{safe_note_path, write_atomic_text};
use futo_notes_core::hash::hash_sha256;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use crate::core::{
    apply_sync_delta_v2_impl, fs_list_notes_with_meta_impl, notes_root, task_join_err, CoreState,
    NoteFileMeta, V2IncomingConflict, V2IncomingUpdate, V2SyncApplyInput,
};
use crate::e2ee_client::{
    parse_iso_ms, AuthMode, ConflictResponse, DeleteResult, E2eeClient, E2eeHttpError, PutResult,
    ServerObject,
};
use crate::sync_state::{
    delete_state_file, load_or_migrate, ConnectedState, E2eeObjectMapEntry, SyncState,
};

const PULL_CONCURRENCY: usize = 8;
const PUSH_CONCURRENCY: usize = 8;
const PROGRESS_COALESCE_MS: i64 = 50;

// ── Progress emitter ────────────────────────────────────────────────────

/// Emit `sync:progress` events with a 50ms throttle so a 2000-file vault
/// doesn't slam the IPC bridge. Final `current == total` emit always
/// fires so the UI sees a clean completion frame.
struct ProgressEmitter {
    app: AppHandle,
    phase: String,
    total: usize,
    current: AtomicUsize,
    last_emit_ms: AtomicI64,
}

impl ProgressEmitter {
    fn new(app: AppHandle, phase: &'static str, total: usize) -> Self {
        let me = Self {
            app,
            phase: phase.to_owned(),
            total,
            current: AtomicUsize::new(0),
            last_emit_ms: AtomicI64::new(0),
        };
        me.emit_force(0);
        me
    }

    fn bump(&self) {
        let n = self.current.fetch_add(1, Ordering::Relaxed) + 1;
        let now = futo_notes_core::files::now_ms();
        let last = self.last_emit_ms.load(Ordering::Relaxed);
        if n == self.total || now - last > PROGRESS_COALESCE_MS {
            self.last_emit_ms.store(now, Ordering::Relaxed);
            self.emit_force(n);
        }
    }

    fn emit_force(&self, current: usize) {
        let _ = self.app.emit(
            "sync:progress",
            serde_json::json!({
                "phase": self.phase,
                "current": current,
                "total": self.total,
            }),
        );
    }
}

// ── Inputs / outputs ─────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct E2eeConnectInput {
    pub server_url: String,
    pub password: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct E2eeConnectOutput {
    pub user_id: String,
    pub collection_id: String,
    /// Bearer token; JS persists this so `e2ee_resume` can skip login on
    /// app restart. If it expires, `e2ee_resume` will surface the 401 and
    /// JS should fall back to `e2ee_connect`.
    pub token: String,
    /// Whether the server identified itself as `password` or `dev` mode.
    /// JS uses this to gate the UI affordances around the stored password.
    pub auth_mode: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct E2eeResumeInput {
    pub server_url: String,
    pub token: String,
    pub user_id: String,
    pub collection_id: String,
    pub password: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct E2eeStatusOutput {
    pub connected: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collection_id: Option<String>,
    pub max_version: u64,
    pub object_count: usize,
    pub migrated_legacy: bool,
}

// ── Helpers ──────────────────────────────────────────────────────────────

fn auth_mode_str(mode: AuthMode) -> &'static str {
    match mode {
        AuthMode::Password => "password",
        AuthMode::Dev => "dev",
    }
}

fn http_err_to_string(e: E2eeHttpError) -> String {
    format!("{e}")
}

fn e2ee_err_to_string(e: e2ee::E2eeError) -> String {
    format!("{e}")
}

/// Derive the password-wrapping key off the executor thread. PBKDF2 with
/// 100k iterations is ~50–300ms depending on CPU; we don't want to block
/// the async runtime.
async fn derive_key_async(password: String, salt: Vec<u8>, iterations: u32) -> [u8; KEY_BYTES] {
    tauri::async_runtime::spawn_blocking(move || {
        e2ee::derive_password_key(&password, &salt, iterations)
    })
    .await
    .expect("PBKDF2 task panicked")
}

async fn unwrap_async(
    password: String,
    material: KeyMaterial,
) -> Result<[u8; KEY_BYTES], e2ee::E2eeError> {
    tauri::async_runtime::spawn_blocking(move || e2ee::unwrap_vault_key(&password, &material))
        .await
        .expect("unwrap_vault_key task panicked")
}

async fn wrap_async(password: String) -> Result<([u8; KEY_BYTES], KeyMaterial), e2ee::E2eeError> {
    tauri::async_runtime::spawn_blocking(move || e2ee::wrap_vault_key(&password))
        .await
        .expect("wrap_vault_key task panicked")
}

fn root_for(app: &AppHandle) -> Result<PathBuf, String> {
    notes_root(app)
}

// ── Commands ─────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn e2ee_connect(
    app: AppHandle,
    state: State<'_, SyncState>,
    input: E2eeConnectInput,
) -> Result<E2eeConnectOutput, String> {
    let mut http = E2eeClient::new(&input.server_url).map_err(http_err_to_string)?;

    let mode = http.probe_auth_mode().await;

    let login = match mode {
        AuthMode::Dev => http
            .login_dev("local@futo-notes.local", "FUTO Notes")
            .await
            .map_err(http_err_to_string)?,
        AuthMode::Password => http
            .login_password(&input.password)
            .await
            .map_err(http_err_to_string)?,
    };
    http.set_token(&login.token);

    // Pick the first collection or create one. The protocol is single-vault
    // today; if a user has multiple collections we just take the first ID
    // and trust the server's ordering.
    let collection_id = {
        let existing = http.list_collections().await.map_err(http_err_to_string)?;
        match existing.into_iter().next() {
            Some(id) => id,
            None => http.create_collection().await.map_err(http_err_to_string)?,
        }
    };

    // Fetch existing key material or mint a fresh one. The wrapping key is
    // derived from `input.password` against the server-stored salt; if no
    // material is present we generate both salt + vault key and persist
    // them via PUT.
    let key_material = http
        .get_key_material(&collection_id)
        .await
        .map_err(http_err_to_string)?;

    let vault_key = match key_material {
        Some(material) => unwrap_async(input.password.clone(), material)
            .await
            .map_err(e2ee_err_to_string)?,
        None => {
            let (vk, fresh_material) =
                wrap_async(input.password.clone()).await.map_err(e2ee_err_to_string)?;
            http.put_key_material(&collection_id, &fresh_material)
                .await
                .map_err(http_err_to_string)?;
            vk
        }
    };

    let root = root_for(&app)?;
    let loaded = tauri::async_runtime::spawn_blocking(move || load_or_migrate(&root))
        .await
        .map_err(task_join_err)?;

    let connected = ConnectedState {
        base_url: input.server_url.clone(),
        token: login.token.clone(),
        user_id: login.user_id.clone(),
        collection_id: collection_id.clone(),
        vault_key,
        object_map: loaded.object_map,
        max_version: loaded.max_version,
    };
    state.set_connected(connected);

    // Persist the new state file right away so a crash mid-sync still
    // recovers the (already-valid) map we just loaded or migrated.
    let root = root_for(&app)?;
    state.persist(&root).await?;

    Ok(E2eeConnectOutput {
        user_id: login.user_id,
        collection_id,
        token: login.token,
        auth_mode: auth_mode_str(mode).to_owned(),
    })
}

#[tauri::command]
pub async fn e2ee_resume(
    app: AppHandle,
    state: State<'_, SyncState>,
    input: E2eeResumeInput,
) -> Result<(), String> {
    let mut http = E2eeClient::new(&input.server_url).map_err(http_err_to_string)?;
    http.set_token(&input.token);

    let material = http
        .get_key_material(&input.collection_id)
        .await
        .map_err(http_err_to_string)?
        .ok_or_else(|| "vault key material missing on server".to_owned())?;

    let vault_key = unwrap_async(input.password.clone(), material)
        .await
        .map_err(e2ee_err_to_string)?;

    let root = root_for(&app)?;
    let loaded = tauri::async_runtime::spawn_blocking(move || load_or_migrate(&root))
        .await
        .map_err(task_join_err)?;

    let connected = ConnectedState {
        base_url: input.server_url,
        token: input.token,
        user_id: input.user_id,
        collection_id: input.collection_id,
        vault_key,
        object_map: loaded.object_map,
        max_version: loaded.max_version,
    };
    state.set_connected(connected);
    Ok(())
}

#[tauri::command]
pub async fn e2ee_disconnect(
    app: AppHandle,
    state: State<'_, SyncState>,
) -> Result<(), String> {
    state.clear();
    let root = root_for(&app)?;
    tauri::async_runtime::spawn_blocking(move || delete_state_file(&root))
        .await
        .map_err(task_join_err)??;
    Ok(())
}

// ── Pull / reconcile orchestrator ────────────────────────────────────────

/// Result of a single pull (or reconcile) phase. Shape mirrors today's TS
/// `SyncSummary` fields so the JS side keeps the existing UI wiring once
/// step 8 chains push + pull together.
///
/// `deleted_hashes` / `created_hashes` are internal-only bookkeeping used
/// by `derive_renames` after both phases finish; they're `#[serde(skip)]`
/// so they never reach the JS side.
#[derive(Debug, Default, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyncSummary {
    pub uploaded: usize,
    pub downloaded: usize,
    pub deleted: usize,
    pub conflicts: usize,
    pub updated_ids: Vec<String>,
    pub deleted_ids: Vec<String>,
    pub peer_updated_ids: Vec<String>,
    pub peer_deleted_ids: Vec<String>,
    pub renamed: Vec<RenamePair>,

    #[serde(skip)]
    pub deleted_hashes: HashMap<String, String>,
    #[serde(skip)]
    pub created_hashes: HashMap<String, String>,
    /// hash → all (filename, change_seq) pairs this phase wrote with that
    /// hash. Used by `resolve_concurrent_move_duplicates` to spot two
    /// clients moving the same content to two different paths in the same
    /// cycle. Internal-only — never reaches the JS side.
    #[serde(skip)]
    pub hash_to_filenames: HashMap<String, Vec<HashFilenameEntry>>,
}

#[derive(Debug, Clone)]
pub struct HashFilenameEntry {
    pub filename: String,
    pub change_seq: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
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
fn pair_local_moved_objects(
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

fn build_client(snapshot: &ConnectedState) -> Result<E2eeClient, String> {
    let mut c = E2eeClient::new(&snapshot.base_url).map_err(http_err_to_string)?;
    c.set_token(&snapshot.token);
    Ok(c)
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
    let modified_at_ms = parse_iso_ms(&obj.updated_at).unwrap_or_else(futo_notes_core::files::now_ms);
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

/// Run the pull side of a sync from a specific `since` cursor. The
/// orchestrator captures `pre_push_max_version` BEFORE push and feeds it
/// here so peer changes whose `change_seq` lands between our last sync
/// and our just-completed push don't get skipped.
async fn run_pull(
    app: &AppHandle,
    state: &SyncState,
    notes_root_path: &Path,
    since: u64,
) -> Result<SyncSummary, String> {
    let snapshot = state.snapshot().ok_or("E2EE not connected")?;
    let http = Arc::new(build_client(&snapshot)?);
    let vault_key = Arc::new(snapshot.vault_key);
    let server_objects = http
        .list_objects(&snapshot.collection_id, since)
        .await
        .map_err(http_err_to_string)?;

    let filename_by_object_id = build_filename_by_object_id(&snapshot.object_map);
    let FirstPass {
        to_download,
        immediate_deletes,
        new_max_version,
    } = first_pass(
        server_objects,
        &snapshot.object_map,
        &filename_by_object_id,
        snapshot.max_version,
    );

    // Spawn one task per object, gated by a semaphore. JoinSet collects
    // results as they finish so the await loop below is order-independent.
    let total_to_download = to_download.len();
    let progress = Arc::new(ProgressEmitter::new(app.clone(), "pulling", total_to_download));
    let semaphore = Arc::new(Semaphore::new(PULL_CONCURRENCY));
    let mut set: JoinSet<Result<DownloadedNote, String>> = JoinSet::new();
    for obj in to_download {
        let permit_sem = semaphore.clone();
        let http = http.clone();
        let vault_key = vault_key.clone();
        let progress = progress.clone();
        set.spawn(async move {
            // The permit drops at the end of the task scope, freeing a slot.
            let _permit = permit_sem.acquire_owned().await.expect("semaphore closed");
            let r = download_and_decrypt(http, vault_key, obj).await;
            progress.bump();
            r
        });
    }

    let mut downloaded: Vec<DownloadedNote> = Vec::new();
    while let Some(joined) = set.join_next().await {
        match joined {
            Ok(Ok(note)) => downloaded.push(note),
            Ok(Err(e)) => eprintln!("[e2ee] blob download failed: {e}"),
            Err(e) => eprintln!("[e2ee] task panicked: {e}"),
        }
    }

    // Build apply-delta input. Renames-in-place: same objectId now points
    // at a different filename — drop the old one as a delete here so the
    // map stays consistent with disk.
    let mut updates: Vec<V2IncomingUpdate> = Vec::with_capacity(downloaded.len());
    let mut deletes: HashSet<String> = immediate_deletes.iter().cloned().collect();
    let mut updated_ids: Vec<String> = Vec::with_capacity(downloaded.len());
    let mut deleted_ids: Vec<String> = immediate_deletes.iter().map(|f| filename_to_id(f)).collect();

    // Rename detection for the pull side. `deleted_hashes` covers
    // tombstones we just observed (look up the soon-to-be-removed map
    // entry's hash) and `created_hashes` covers everything we just
    // downloaded — if any pull-deleted hash matches a pull-or-push
    // create hash, `derive_renames` pairs them.
    let mut deleted_hashes: HashMap<String, String> = HashMap::new();
    for filename in &immediate_deletes {
        if let Some(entry) = snapshot.object_map.get(filename) {
            if let Some(h) = entry.hash.clone() {
                deleted_hashes.insert(h, filename.clone());
            }
        }
    }
    let mut created_hashes: HashMap<String, String> = HashMap::new();
    let mut hash_to_filenames: HashMap<String, Vec<HashFilenameEntry>> = HashMap::new();

    for note in &downloaded {
        let previous_filename = filename_by_object_id.get(&note.object_id);
        if let Some(prev) = previous_filename {
            if prev != &note.filename {
                deletes.insert(prev.clone());
                deleted_ids.push(filename_to_id(prev));
                // In-place rename (same objectId, new filename): record
                // the previous filename's hash as the rename source.
                if let Some(entry) = snapshot.object_map.get(prev) {
                    if let Some(h) = entry.hash.clone() {
                        deleted_hashes.insert(h, prev.clone());
                    }
                }
            }
        }
        updates.push(V2IncomingUpdate {
            filename: note.filename.clone(),
            content: note.content.clone(),
            hash: note.hash.clone(),
            modified_at: note.modified_at_ms,
        });
        updated_ids.push(filename_to_id(&note.filename));
        created_hashes.insert(note.hash.clone(), note.filename.clone());
        add_hash_filename(
            &mut hash_to_filenames,
            note.hash.clone(),
            note.filename.clone(),
            note.change_seq,
        );
    }

    let apply_input = V2SyncApplyInput {
        update: updates,
        delete: deletes.iter().cloned().collect(),
        conflicts: Vec::new(),
        timestamps: HashMap::new(),
    };

    // The apply path writes files atomically + records watcher suppressions.
    // Run on the blocking pool so we don't stall the async runtime on disk I/O.
    if !apply_input.update.is_empty() || !apply_input.delete.is_empty() {
        let core_state = app.state::<CoreState>();
        let suppressed = core_state.suppressed_watcher_events.clone();
        let base = notes_root_path.to_path_buf();
        tauri::async_runtime::spawn_blocking(move || {
            apply_sync_delta_v2_impl(&base, &suppressed, apply_input)
        })
        .await
        .map_err(task_join_err)??;
    }

    // Update SyncState's map + max_version, then persist.
    let downloaded_count = downloaded.len();
    let deletes_count = deletes.len();
    let new_max = new_max_version;
    state.with_map_mut(|map, ver| {
        for filename in &deletes {
            map.remove(filename);
        }
        for note in &downloaded {
            // Sweep stale rename source from the map too.
            if let Some(prev) = filename_by_object_id.get(&note.object_id) {
                if prev != &note.filename {
                    map.remove(prev);
                }
            }
            map.insert(
                note.filename.clone(),
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
        *ver = (*ver).max(new_max);
    });
    state.persist(notes_root_path).await?;

    Ok(SyncSummary {
        downloaded: downloaded_count,
        deleted: deletes_count,
        updated_ids: updated_ids.clone(),
        deleted_ids: deleted_ids.clone(),
        peer_updated_ids: updated_ids,
        peer_deleted_ids: deleted_ids,
        deleted_hashes,
        created_hashes,
        hash_to_filenames,
        ..Default::default()
    })
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
    tauri::async_runtime::spawn_blocking(move || std::fs::read_to_string(&path).map_err(|e| e.to_string()))
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
    // mtime/size fast-path miss. Stamp the new mtime/size so next push
    // skips this file entirely. Skip this short-circuit for local moves:
    // the path changed, so even though the content didn't, the encrypted
    // blob's packed `path` field needs to update.
    if !is_local_move {
        if let Some(e) = &existing {
            if e.hash.as_deref() == Some(hash.as_str()) {
                let entry = E2eeObjectMapEntry {
                    object_id: e.object_id.clone(),
                    version: e.version,
                    blob_key: e.blob_key.clone(),
                    hash: Some(hash),
                    mtime_ms: Some(file.mtime_ms),
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
    let modified_at = futo_notes_core::files::now_ms();
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
async fn run_push(
    app: &AppHandle,
    state: &SyncState,
    notes_root_path: &Path,
) -> Result<SyncSummary, String> {
    let snapshot = state.snapshot().ok_or("E2EE not connected")?;
    let http = Arc::new(build_client(&snapshot)?);
    let vault_key = Arc::new(snapshot.vault_key);

    let root_for_walk = notes_root_path.to_path_buf();
    let local_files = tauri::async_runtime::spawn_blocking(move || {
        fs_list_notes_with_meta_impl(&root_for_walk)
    })
    .await
    .map_err(task_join_err)??;
    // Drop non-`.md` rows just in case (`fs_list_notes_with_meta_impl`
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
    let local_move_pairings = pair_local_moved_objects(&local_files, &snapshot.object_map);
    let mut effective_map = snapshot.object_map.clone();
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
    let progress = Arc::new(ProgressEmitter::new(app.clone(), "pushing", total_candidates));
    let semaphore = Arc::new(Semaphore::new(PUSH_CONCURRENCY));
    let mut set: JoinSet<Result<PushOutcome, String>> = JoinSet::new();
    for file in plan.candidates {
        let existing = effective_map.get(&file.name).cloned();
        let is_local_move = local_move_sources.contains(&file.name);
        let http = http.clone();
        let vault_key = vault_key.clone();
        let cid = snapshot.collection_id.clone();
        let ns = namespace.clone();
        let root = notes_root_path.to_path_buf();
        let permit_sem = semaphore.clone();
        let progress = progress.clone();
        set.spawn(async move {
            let _permit = permit_sem.acquire_owned().await.expect("semaphore closed");
            let r = push_one_file(
                root,
                http,
                vault_key,
                cid,
                file,
                existing,
                ns,
                is_local_move,
            )
            .await;
            progress.bump();
            r
        });
    }

    let mut outcomes: Vec<PushOutcome> = Vec::new();
    while let Some(joined) = set.join_next().await {
        match joined {
            Ok(Ok(out)) => outcomes.push(out),
            Ok(Err(e)) => eprintln!("[e2ee] push task errored: {e}"),
            Err(e) => eprintln!("[e2ee] push task panicked: {e}"),
        }
    }

    // Push deletes serially. The TS code does the same — delete volume is
    // typically tiny and serial keeps the 409 → restore path simple.
    let mut delete_results: Vec<(String, DeletePushResult)> = Vec::new();
    for (filename, entry) in plan.deletes {
        let res = http
            .delete_object(&snapshot.collection_id, &entry.object_id, entry.version)
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

    let mut uploaded = 0usize;
    let mut conflicts = 0usize;
    let mut updated_ids: Vec<String> = Vec::new();
    let mut deleted_ids: Vec<String> = Vec::new();
    let mut peer_updated_ids: Vec<String> = Vec::new();
    let mut peer_deleted_ids: Vec<String> = Vec::new();
    let mut new_max_version = snapshot.max_version;
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
                if !snapshot.object_map.contains_key(&filename) {
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
                    modified_at: futo_notes_core::files::now_ms(),
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
                if let Some(entry) = snapshot.object_map.get(&filename) {
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
        let core_state = app.state::<CoreState>();
        let suppressed = core_state.suppressed_watcher_events.clone();
        let base = notes_root_path.to_path_buf();
        tauri::async_runtime::spawn_blocking(move || {
            apply_sync_delta_v2_impl(&base, &suppressed, apply_input)
        })
        .await
        .map_err(task_join_err)??;
    }

    // Update the in-memory map + max version, then persist.
    let new_max = new_max_version;
    state.with_map_mut(|map, ver| {
        for filename in &removes {
            map.remove(filename);
        }
        for (filename, entry) in &upserts {
            map.insert(filename.clone(), entry.clone());
        }
        *ver = (*ver).max(new_max);
    });
    state.persist(notes_root_path).await?;

    Ok(SyncSummary {
        uploaded,
        deleted: removes.len(),
        conflicts,
        updated_ids,
        deleted_ids,
        peer_updated_ids,
        peer_deleted_ids,
        deleted_hashes,
        created_hashes,
        hash_to_filenames,
        ..Default::default()
    })
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

// Suppress warning that `write_atomic_text` isn't used in this module yet.
// Push uses it indirectly via apply_sync_delta_v2_impl, but in case future
// steps need direct invocation we keep the import alive.
#[allow(dead_code)]
fn _keep_write_atomic_import(path: &Path, s: &str) -> Result<(), String> {
    write_atomic_text(path, s)
}

/// Result of a duplicate-move resolution pass. `deleted_ids` are the
/// note ids whose synced filename we just took down (locally + on the
/// server); `conflicts` matches the legacy TS counter for the user-
/// facing "N conflicts resolved" badge.
#[derive(Debug, Default)]
struct DuplicateResolution {
    conflicts: usize,
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
async fn resolve_concurrent_move_duplicates(
    app: &AppHandle,
    state: &SyncState,
    notes_root_path: &Path,
    deleted_hashes: &HashMap<String, String>,
    push_h2f: &HashMap<String, Vec<HashFilenameEntry>>,
    pull_h2f: &HashMap<String, Vec<HashFilenameEntry>>,
) -> Result<DuplicateResolution, String> {
    let mut out = DuplicateResolution::default();

    let snapshot = match state.snapshot() {
        Some(s) => s,
        None => return Ok(out),
    };
    let http = Arc::new(build_client(&snapshot)?);

    for (hash, from_filename) in deleted_hashes {
        let losers = pick_duplicate_move_losers(from_filename, hash, push_h2f, pull_h2f);
        for loser in losers {
            if delete_synced_filename(&http, app, state, notes_root_path, &loser.filename).await? {
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
/// the in-memory + persisted object map. Returns true if the delete went
/// through; false if there was nothing to delete or the server refused.
/// Mirrors the legacy TS `deleteSyncedFilename`.
async fn delete_synced_filename(
    http: &Arc<E2eeClient>,
    app: &AppHandle,
    state: &SyncState,
    notes_root_path: &Path,
    filename: &str,
) -> Result<bool, String> {
    let (collection_id, entry) = match state.snapshot() {
        Some(s) => match s.object_map.get(filename).cloned() {
            Some(e) => (s.collection_id.clone(), e),
            None => return Ok(false),
        },
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
    let core_state = app.state::<CoreState>();
    let suppressed = core_state.suppressed_watcher_events.clone();
    let base = notes_root_path.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        apply_sync_delta_v2_impl(&base, &suppressed, apply_input)
    })
    .await
    .map_err(task_join_err)??;

    let filename_owned = filename.to_owned();
    state.with_map_mut(|map, ver| {
        map.remove(&filename_owned);
        if change_seq > *ver {
            *ver = change_seq;
        }
    });
    state.persist(notes_root_path).await?;
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
    push.deleted += pull.deleted + dup.deleted_ids.len();
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

#[tauri::command]
pub async fn e2ee_sync_run(
    app: AppHandle,
    state: State<'_, SyncState>,
) -> Result<SyncSummary, String> {
    let root = root_for(&app)?;

    // Capture the pre-push cursor BEFORE push runs. Push advances
    // `max_version` for our own writes; using the post-push value for
    // `since` would silently drop any peer changes whose `change_seq`
    // landed in the interval. (Mirrors `prePushMaxVersion` in TS.)
    let pre_push_max = state.snapshot().map(|s| s.max_version).unwrap_or(0);

    let push_summary = run_push(&app, &state, &root).await?;
    let pull_summary = run_pull(&app, &state, &root, pre_push_max).await?;

    // Concurrent-move dedup runs BEFORE rename detection so any losers
    // it deletes don't get paired by `derive_renames` as a phantom rename
    // (the loser's filename would otherwise appear in `created_hashes`).
    let all_deleted_hashes = union_deleted_hashes(
        &push_summary.deleted_hashes,
        &pull_summary.deleted_hashes,
    );
    let dup_resolution = resolve_concurrent_move_duplicates(
        &app,
        &state,
        &root,
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

    Ok(combine_summaries(
        push_summary,
        pull_summary,
        renamed,
        dup_resolution,
    ))
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

#[tauri::command]
pub async fn e2ee_status(state: State<'_, SyncState>) -> Result<E2eeStatusOutput, String> {
    let snapshot = state.snapshot();
    Ok(match snapshot {
        None => E2eeStatusOutput {
            connected: false,
            server_url: None,
            user_id: None,
            collection_id: None,
            max_version: 0,
            object_count: 0,
            migrated_legacy: false,
        },
        Some(c) => E2eeStatusOutput {
            connected: true,
            server_url: Some(c.base_url),
            user_id: Some(c.user_id),
            collection_id: Some(c.collection_id),
            max_version: c.max_version,
            object_count: c.object_map.len(),
            migrated_legacy: false,
        },
    })
}

// ── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync_state::E2eeObjectMapEntry;
    use std::collections::HashMap;

    fn sample_state() -> ConnectedState {
        let mut map = HashMap::new();
        map.insert(
            "alpha.md".to_owned(),
            E2eeObjectMapEntry {
                object_id: "oA".into(),
                version: 2,
                blob_key: "bkA".into(),
                hash: None,
                mtime_ms: None,
                size_bytes: None,
            },
        );
        ConnectedState {
            base_url: "http://x".into(),
            token: "tok".into(),
            user_id: "uX".into(),
            collection_id: "cY".into(),
            vault_key: [1u8; 32],
            object_map: map,
            max_version: 12,
        }
    }

    #[test]
    fn status_when_disconnected_reports_defaults() {
        let s = SyncState::default();
        let snap = s.snapshot();
        // No tauri runtime in this test — just exercise the projection
        // logic that `e2ee_status` performs.
        let out = match snap {
            None => E2eeStatusOutput {
                connected: false,
                server_url: None,
                user_id: None,
                collection_id: None,
                max_version: 0,
                object_count: 0,
                migrated_legacy: false,
            },
            Some(c) => E2eeStatusOutput {
                connected: true,
                server_url: Some(c.base_url),
                user_id: Some(c.user_id),
                collection_id: Some(c.collection_id),
                max_version: c.max_version,
                object_count: c.object_map.len(),
                migrated_legacy: false,
            },
        };
        assert!(!out.connected);
        assert_eq!(out.max_version, 0);
        assert_eq!(out.object_count, 0);
    }

    #[test]
    fn status_when_connected_reflects_snapshot() {
        let s = SyncState::default();
        s.set_connected(sample_state());
        let snap = s.snapshot().unwrap();
        assert_eq!(snap.max_version, 12);
        assert_eq!(snap.object_map.len(), 1);
        assert_eq!(snap.collection_id, "cY");
    }

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

    #[test]
    fn input_output_serde_camel_case() {
        // e2ee_connect input: serverUrl/password
        let raw = r#"{"serverUrl":"http://x","password":"p"}"#;
        let parsed: E2eeConnectInput = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.server_url, "http://x");

        // e2ee_resume input: serverUrl/token/userId/collectionId/password
        let raw = r#"{"serverUrl":"u","token":"t","userId":"id","collectionId":"c","password":"p"}"#;
        let parsed: E2eeResumeInput = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.user_id, "id");

        // status output: camelCase keys
        let out = E2eeStatusOutput {
            connected: true,
            server_url: Some("u".into()),
            user_id: Some("uid".into()),
            collection_id: Some("cid".into()),
            max_version: 7,
            object_count: 3,
            migrated_legacy: false,
        };
        let j = serde_json::to_string(&out).unwrap();
        assert!(j.contains("\"serverUrl\""));
        assert!(j.contains("\"userId\""));
        assert!(j.contains("\"collectionId\""));
        assert!(j.contains("\"maxVersion\""));
        assert!(j.contains("\"objectCount\""));
    }
}
