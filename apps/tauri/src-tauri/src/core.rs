use notify::{
    event::ModifyKind, Config as NotifyConfig, Event, EventKind, RecommendedWatcher, RecursiveMode,
    Watcher,
};
use rayon::prelude::*;
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;
use stonefruit_core::files::{ensure_safe_note_id, file_mtime_ms, set_file_mtime_ms};
use stonefruit_core::hash::hash_sha256;
#[cfg(test)]
use stonefruit_core::hash::hash_sha256_bytes;
use tauri::{AppHandle, Emitter, Manager, State};

pub(crate) use stonefruit_core::files::{now_ms, write_atomic_text};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupersearchMeta {
    artifact_version: String,
    artifact_hash: String,
    downloaded_at: i64,
    model: String,
    dims: usize,
    chunk_count: usize,
}

#[derive(Default)]
pub struct CoreState {
    watcher: Arc<Mutex<Option<RecommendedWatcher>>>,
    suppressed_watcher_events: Arc<Mutex<HashMap<String, i64>>>,
    sync_writes_until: Arc<AtomicI64>,
    pub(crate) vectors: Arc<RwLock<Option<Arc<VectorArtifacts>>>>,
}

const WATCHER_SUPPRESSION_MS: i64 = 5_000;

const NOTES_DIR_OVERRIDE_FILE: &str = "notes-dir-override.json";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct NotesDirOverride {
    notes_dir: Option<String>,
}

/// Returns the custom data directory set via STONEFRUIT_DATA_DIR env var, if present.
/// Used to redirect app data to a per-worktree isolated directory during development.
fn env_data_dir() -> Option<PathBuf> {
    std::env::var("STONEFRUIT_DATA_DIR").ok().map(PathBuf::from)
}

fn override_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(data_dir) = env_data_dir() {
        return Ok(data_dir.join(NOTES_DIR_OVERRIDE_FILE));
    }
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(data_dir.join(NOTES_DIR_OVERRIDE_FILE))
}

fn load_notes_dir_override(app: &AppHandle) -> Option<PathBuf> {
    let path = override_file_path(app).ok()?;
    let raw = fs::read_to_string(path).ok()?;
    let over: NotesDirOverride = serde_json::from_str(&raw).ok()?;
    over.notes_dir.map(PathBuf::from)
}

fn save_notes_dir_override(app: &AppHandle, dir: Option<&str>) -> Result<(), String> {
    let path = override_file_path(app)?;
    let over = NotesDirOverride {
        notes_dir: dir.map(String::from),
    };
    let serialized = serde_json::to_string_pretty(&over).map_err(|e| e.to_string())?;
    write_atomic_text(&path, &serialized)
}

#[derive(Clone)]
pub(crate) struct VectorArtifacts {
    pub(crate) dims: usize,
    pub(crate) chunks: Vec<ManifestChunk>,
    pub(crate) vectors: Vec<f32>,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct ManifestChunk {
    pub(crate) chunk_id: i64,
    pub(crate) uuid: String,
    pub(crate) chunk_text: String,
    pub(crate) start_offset: i64,
    pub(crate) end_offset: i64,
}

#[derive(Serialize, Deserialize)]
pub(crate) struct ManifestPayload {
    pub(crate) dims: usize,
    pub(crate) chunk_count: usize,
    pub(crate) chunks: Vec<ManifestChunk>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirFileEntry {
    pub name: String,
    pub size: u64,
    pub mtime: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HashCacheEntry {
    pub modified_at: i64,
    pub hash: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupersearchResultPayload {
    pub chunk_id: i64,
    pub uuid: String,
    pub chunk_text: String,
    pub start_offset: i64,
    pub end_offset: i64,
    pub score: f32,
}

pub(crate) fn io_err_to_string(err: io::Error) -> String {
    err.to_string()
}

pub(crate) fn task_join_err<E: std::fmt::Display>(err: E) -> String {
    format!("background task failed: {err}")
}

fn default_notes_root(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(data_dir) = env_data_dir() {
        return Ok(data_dir.join("notes"));
    }
    let docs = app
        .path()
        .document_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(|e| e.to_string())?;
    Ok(docs.join("stonefruit"))
}

pub(crate) fn notes_root(app: &AppHandle) -> Result<PathBuf, String> {
    let root = if let Some(custom) = load_notes_dir_override(app) {
        custom
    } else {
        default_notes_root(app)?
    };
    fs::create_dir_all(&root).map_err(io_err_to_string)?;
    Ok(root)
}


/// One-way migration: convert .txt files to .md in the notes directory.
/// If a collision exists (same name with .md already present), renames to `name (imported).md`.
fn convert_txt_to_md(base: &Path) {
    let entries = match fs::read_dir(base) {
        Ok(entries) => entries.filter_map(|e| e.ok()).collect::<Vec<_>>(),
        Err(_) => return,
    };

    let md_set: std::collections::HashSet<String> = entries
        .iter()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if name.ends_with(".md") {
                Some(name.to_lowercase())
            } else {
                None
            }
        })
        .collect();

    for entry in &entries {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.to_lowercase().ends_with(".txt") {
            continue;
        }
        let txt_base = &name[..name.len() - 4]; // strip .txt
        let md_name = format!("{txt_base}.md");

        let target = if md_set.contains(&md_name.to_lowercase()) {
            // Collision: both name.txt and name.md exist
            let mut candidate = format!("{txt_base} (imported).md");
            let mut counter = 2;
            while md_set.contains(&candidate.to_lowercase()) || base.join(&candidate).exists() {
                candidate = format!("{txt_base} (imported {counter}).md");
                counter += 1;
            }
            candidate
        } else {
            md_name
        };

        let _ = fs::rename(base.join(&name), base.join(&target));
    }
}

fn load_vector_artifacts_from_disk(base: &Path) -> Result<VectorArtifacts, String> {
    let manifest_path = base.join(".supersearch-manifest.json");
    let bin_path = base.join(".supersearch-vectors.bin");
    let manifest_raw = fs::read_to_string(&manifest_path).map_err(io_err_to_string)?;
    let manifest: ManifestPayload =
        serde_json::from_str(&manifest_raw).map_err(|err| err.to_string())?;

    if manifest.dims == 0 {
        return Err("invalid supersearch manifest: dims must be > 0".to_string());
    }

    let bytes = fs::read(&bin_path).map_err(io_err_to_string)?;
    if bytes.len() % 4 != 0 {
        return Err("invalid supersearch vectors: byte length must be a multiple of 4".to_string());
    }

    let expected_values = manifest
        .chunks
        .len()
        .checked_mul(manifest.dims)
        .ok_or_else(|| "invalid supersearch manifest size".to_string())?;

    if bytes.len() / 4 != expected_values {
        return Err("supersearch manifest/vector size mismatch".to_string());
    }

    let vectors = bytes
        .chunks_exact(4)
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect::<Vec<_>>();

    Ok(VectorArtifacts {
        dims: manifest.dims,
        chunks: manifest.chunks,
        vectors,
    })
}

pub(crate) fn ensure_vectors_loaded(
    base: &Path,
    cache: &Arc<RwLock<Option<Arc<VectorArtifacts>>>>,
) -> Result<Arc<VectorArtifacts>, String> {
    {
        let read = cache
            .read()
            .map_err(|_| "vector cache lock poisoned".to_string())?;
        if let Some(artifacts) = read.as_ref() {
            return Ok(Arc::clone(artifacts));
        }
    }

    let loaded = Arc::new(load_vector_artifacts_from_disk(base)?);
    let mut write = cache
        .write()
        .map_err(|_| "vector cache lock poisoned".to_string())?;
    if let Some(existing) = write.as_ref() {
        return Ok(Arc::clone(existing));
    }
    *write = Some(Arc::clone(&loaded));
    Ok(loaded)
}


// ── V2 Sync (filename-based, no UUIDs) ─────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct V2SyncState {
    pub device_id: String,
    pub last_server_version: u64,
    pub file_hashes: HashMap<String, String>,
    pub hash_cache: Option<HashMap<String, HashCacheEntry>>,
    /// Dirty journal: filenames that have been upserted locally since last sync.
    #[serde(default)]
    pub dirty_upserts: HashSet<String>,
    /// Dirty journal: filenames that have been deleted locally since last sync.
    #[serde(default)]
    pub dirty_deletes: HashSet<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V2SyncPrepareInput {
    pub state: V2SyncState,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct V2SyncPrepareOutput {
    pub state: V2SyncState,
    /// `None` = dirty-only upload (no full vault walk). `Some` = full inventory.
    pub inventory: Option<Vec<V2InventoryItem>>,
    pub changed: Vec<V2ChangedNote>,
    pub new: Vec<V2NewNote>,
    pub deleted: Vec<String>,
    pub last_version: Option<u64>,
    /// Baseline hashes for deleted files (filename → last-synced hash).
    pub deleted_baselines: HashMap<String, String>,
    pub elapsed_ms: u128,
}

#[derive(Debug, Clone, Serialize)]
pub struct V2InventoryItem {
    pub filename: String,
    pub hash: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct V2ChangedNote {
    pub filename: String,
    pub content: String,
    pub hash: String,
    pub modified_at: i64,
    /// Hash from last successful sync — third input for conflict detection.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub baseline_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct V2NewNote {
    pub filename: String,
    pub content: String,
    pub hash: String,
    pub modified_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V2SyncApplyInput {
    pub update: Vec<V2IncomingUpdate>,
    pub delete: Vec<String>,
    pub conflicts: Vec<V2IncomingConflict>,
    #[serde(default)]
    pub timestamps: HashMap<String, i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct V2IncomingUpdate {
    pub filename: String,
    pub content: String,
    pub hash: String,
    pub modified_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct V2IncomingConflict {
    pub filename: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct V2SyncApplyOutput {
    pub updated_filenames: Vec<String>,
    pub deleted_filenames: Vec<String>,
    pub conflict_filenames: Vec<String>,
    pub elapsed_ms: u128,
}

/// Dirty-only sync prep: read only files in the dirty journal, skip full vault walk.
/// Sends no inventory (None), includes baseline hashes and deleted_baselines.
fn prepare_dirty_only(
    base: &Path,
    state: V2SyncState,
    started: Instant,
) -> Result<V2SyncPrepareOutput, String> {
    let mut changed = Vec::new();
    let mut new_notes = Vec::new();

    // Process dirty upserts — read only these files
    for filename in &state.dirty_upserts {
        let path = base.join(filename);
        if !path.is_file() {
            continue; // File was deleted after being marked dirty — skip
        }
        let content = fs::read_to_string(&path).map_err(io_err_to_string)?;
        let hash = hash_sha256(&content);
        let mtime = path
            .metadata()
            .ok()
            .map(|m| file_mtime_ms(&m))
            .unwrap_or(0);

        let last_sync_hash = state.file_hashes.get(filename);
        match last_sync_hash {
            None => {
                new_notes.push(V2NewNote {
                    filename: filename.clone(),
                    content,
                    hash,
                    modified_at: mtime,
                });
            }
            Some(last_hash) if last_hash != &hash => {
                changed.push(V2ChangedNote {
                    filename: filename.clone(),
                    content,
                    hash,
                    modified_at: mtime,
                    baseline_hash: Some(last_hash.clone()),
                });
            }
            _ => {
                // Hash unchanged despite being in dirty journal — skip
            }
        }
    }

    // Process dirty deletes
    let deleted: Vec<String> = state.dirty_deletes.iter().cloned().collect();
    let deleted_baselines: HashMap<String, String> = deleted
        .iter()
        .filter_map(|f| state.file_hashes.get(f).map(|h| (f.clone(), h.clone())))
        .collect();

    let last_version = if state.last_server_version > 0 {
        Some(state.last_server_version)
    } else {
        None
    };

    // Don't clear dirty journal here — it's cleared after successful sync
    // by the TypeScript layer (only accepted entries are cleared)

    Ok(V2SyncPrepareOutput {
        state,
        inventory: None, // No full vault walk
        changed,
        new: new_notes,
        deleted,
        last_version,
        deleted_baselines,
        elapsed_ms: started.elapsed().as_millis(),
    })
}

fn prepare_sync_payload_v2_impl(
    base: &Path,
    input: V2SyncPrepareInput,
) -> Result<V2SyncPrepareOutput, String> {
    let started = Instant::now();
    convert_txt_to_md(base);
    let mut state = input.state;

    // ── Dirty-only fast path ──────────────────────────────────
    // When the dirty journal is non-empty, skip full vault walk.
    // Read only the dirty files and send them with baseline hashes.
    if !state.dirty_upserts.is_empty() || !state.dirty_deletes.is_empty() {
        return prepare_dirty_only(base, state, started);
    }

    // ── Full vault walk (fallback/startup/recovery) ───────────
    let hash_cache = state.hash_cache.clone().unwrap_or_default();

    // Scan all .md files
    let files: Vec<(String, PathBuf, i64)> = fs::read_dir(base)
        .map_err(io_err_to_string)?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(".md") {
                return None;
            }
            let meta = entry.metadata().ok()?;
            if !meta.is_file() {
                return None;
            }
            Some((name, entry.path(), file_mtime_ms(&meta)))
        })
        .collect();

    // Parallel hash computation with mtime cache
    let file_hashes_snapshot = state.file_hashes.clone();

    let computed: Vec<(String, String, Option<String>, i64)> = files
        .par_iter()
        .map(|(filename, path, mtime)| {
            let cached = hash_cache.get(filename);
            let mut content: Option<String> = None;

            let hash = if cached.map(|e| e.modified_at) == Some(*mtime) {
                cached.map(|e| e.hash.clone()).unwrap_or_default()
            } else {
                let body = fs::read_to_string(path).map_err(io_err_to_string)?;
                let computed = hash_sha256(&body);
                content = Some(body);
                computed
            };

            let last_sync_hash = file_hashes_snapshot.get(filename).cloned();
            let needs_content = last_sync_hash.as_deref() != Some(&hash);
            if needs_content && content.is_none() {
                content = Some(fs::read_to_string(path).map_err(io_err_to_string)?);
            }

            Ok::<(String, String, Option<String>, i64), String>((
                filename.clone(),
                hash,
                if needs_content { content } else { None },
                *mtime,
            ))
        })
        .collect::<Result<Vec<_>, String>>()?;

    let mut inventory = Vec::new();
    let mut changed = Vec::new();
    let mut new_notes = Vec::new();
    let mut new_hash_cache = HashMap::new();
    let active_filenames: HashSet<String> = computed.iter().map(|(f, _, _, _)| f.clone()).collect();

    for (filename, hash, content, mtime) in computed {
        inventory.push(V2InventoryItem {
            filename: filename.clone(),
            hash: hash.clone(),
        });

        new_hash_cache.insert(
            filename.clone(),
            HashCacheEntry {
                modified_at: mtime,
                hash: hash.clone(),
            },
        );

        let last_sync_hash = state.file_hashes.get(&filename);
        match last_sync_hash {
            None => {
                // New file
                if let Some(content) = content {
                    new_notes.push(V2NewNote {
                        filename: filename.clone(),
                        content,
                        hash: hash.clone(),
                        modified_at: mtime,
                    });
                }
            }
            Some(last_hash) if last_hash != &hash => {
                // Changed file — include baseline_hash from last sync
                if let Some(content) = content {
                    changed.push(V2ChangedNote {
                        filename: filename.clone(),
                        content,
                        hash: hash.clone(),
                        modified_at: mtime,
                        baseline_hash: Some(last_hash.clone()),
                    });
                }
            }
            _ => {
                // Unchanged
            }
        }
    }

    // Detect deletions: files in file_hashes that no longer exist on disk
    let deleted: Vec<String> = state
        .file_hashes
        .keys()
        .filter(|f| !active_filenames.contains(*f))
        .cloned()
        .collect();

    // Build deleted_baselines from file_hashes for delete-vs-edit detection
    let deleted_baselines: HashMap<String, String> = deleted
        .iter()
        .filter_map(|f| state.file_hashes.get(f).map(|h| (f.clone(), h.clone())))
        .collect();

    // Determine last_version for changelog-based download
    let last_version = if state.last_server_version > 0 {
        Some(state.last_server_version)
    } else {
        None
    };

    state.hash_cache = Some(new_hash_cache);
    // Clear dirty journal — it was consumed by the full vault scan
    state.dirty_upserts.clear();
    state.dirty_deletes.clear();

    Ok(V2SyncPrepareOutput {
        state,
        inventory: Some(inventory),
        changed,
        new: new_notes,
        deleted,
        last_version,
        deleted_baselines,
        elapsed_ms: started.elapsed().as_millis(),
    })
}

fn apply_sync_delta_v2_impl(
    base: &Path,
    suppressed_watcher_events: &Arc<Mutex<HashMap<String, i64>>>,
    sync_writes_until: &Arc<AtomicI64>,
    input: V2SyncApplyInput,
) -> Result<V2SyncApplyOutput, String> {
    let started = Instant::now();
    sync_writes_until.store(now_ms() + WATCHER_SUPPRESSION_MS, Ordering::Release);

    let mut updated_filenames = Vec::new();
    let mut deleted_filenames = Vec::new();
    let mut conflict_filenames = Vec::new();

    let suppress_filename = |filename: &str| {
        if let Ok(mut map) = suppressed_watcher_events.lock() {
            let expires_at = now_ms() + WATCHER_SUPPRESSION_MS;
            map.insert(filename.to_string(), expires_at);
            map.retain(|_, expiry| *expiry > now_ms());
        }
    };

    // Delete files
    for filename in &input.delete {
        suppress_filename(filename);
        let path = base.join(filename);
        let _ = fs::remove_file(&path);
        deleted_filenames.push(filename.clone());
    }

    // Write updates
    for update in &input.update {
        suppress_filename(&update.filename);
        let path = base.join(&update.filename);
        write_atomic_text(&path, &update.content)?;

        // 0 means "no timestamp from server" — keep the filesystem's own mtime
        if update.modified_at > 0 {
            let _ = set_file_mtime_ms(&path, update.modified_at);
        }

        updated_filenames.push(update.filename.clone());
    }

    // Write conflict copies
    for conflict in &input.conflicts {
        suppress_filename(&conflict.filename);
        let path = base.join(&conflict.filename);
        write_atomic_text(&path, &conflict.content)?;
        conflict_filenames.push(conflict.filename.clone());
    }

    // Correct local file mtimes from server-authoritative timestamps.
    // This fixes files that were already up-to-date (same hash) but had wrong mtimes.
    for (filename, server_mtime) in &input.timestamps {
        if *server_mtime > 0 {
            let path = base.join(filename);
            if let Ok(meta) = fs::metadata(&path) {
                if file_mtime_ms(&meta) != *server_mtime {
                    suppress_filename(filename);
                    let _ = set_file_mtime_ms(&path, *server_mtime);
                }
            }
        }
    }

    sync_writes_until.store(now_ms() + WATCHER_SUPPRESSION_MS, Ordering::Release);

    Ok(V2SyncApplyOutput {
        updated_filenames,
        deleted_filenames,
        conflict_filenames,
        elapsed_ms: started.elapsed().as_millis(),
    })
}

#[tauri::command]
pub async fn core_prepare_sync_payload_v2(
    app: AppHandle,
    input: V2SyncPrepareInput,
) -> Result<V2SyncPrepareOutput, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        prepare_sync_payload_v2_impl(&base, input)
    })
    .await
    .map_err(task_join_err)?
}

#[tauri::command]
pub async fn core_apply_sync_delta_v2(
    app: AppHandle,
    state: State<'_, CoreState>,
    input: V2SyncApplyInput,
) -> Result<V2SyncApplyOutput, String> {
    let suppressed = state.suppressed_watcher_events.clone();
    let sync_until = state.sync_writes_until.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        apply_sync_delta_v2_impl(&base, &suppressed, &sync_until, input)
    })
    .await
    .map_err(task_join_err)?
}

#[derive(Clone, Copy, Debug)]
struct ScoredChunk {
    idx: usize,
    score: f32,
}

impl PartialEq for ScoredChunk {
    fn eq(&self, other: &Self) -> bool {
        self.idx == other.idx && self.score == other.score
    }
}

impl Eq for ScoredChunk {}

impl PartialOrd for ScoredChunk {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for ScoredChunk {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.score
            .partial_cmp(&other.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| self.idx.cmp(&other.idx))
    }
}

fn dot_product_unrolled(query: &[f32], candidate: &[f32]) -> f32 {
    let len = query.len();
    let unrolled_end = len - (len % 8);
    let mut i = 0usize;
    let mut sum0 = 0.0f32;
    let mut sum1 = 0.0f32;
    let mut sum2 = 0.0f32;
    let mut sum3 = 0.0f32;
    let mut sum4 = 0.0f32;
    let mut sum5 = 0.0f32;
    let mut sum6 = 0.0f32;
    let mut sum7 = 0.0f32;

    while i < unrolled_end {
        sum0 += query[i] * candidate[i];
        sum1 += query[i + 1] * candidate[i + 1];
        sum2 += query[i + 2] * candidate[i + 2];
        sum3 += query[i + 3] * candidate[i + 3];
        sum4 += query[i + 4] * candidate[i + 4];
        sum5 += query[i + 5] * candidate[i + 5];
        sum6 += query[i + 6] * candidate[i + 6];
        sum7 += query[i + 7] * candidate[i + 7];
        i += 8;
    }

    let mut dot = sum0 + sum1 + sum2 + sum3 + sum4 + sum5 + sum6 + sum7;
    while i < len {
        dot += query[i] * candidate[i];
        i += 1;
    }
    dot
}

fn should_replace_min_score(min_hit: ScoredChunk, candidate: ScoredChunk) -> bool {
    candidate.score > min_hit.score
        || (candidate.score == min_hit.score && candidate.idx < min_hit.idx)
}

fn push_top_score(heap: &mut BinaryHeap<Reverse<ScoredChunk>>, hit: ScoredChunk, limit: usize) {
    if heap.len() < limit {
        heap.push(Reverse(hit));
        return;
    }
    if let Some(min_hit) = heap.peek() {
        if should_replace_min_score(min_hit.0, hit) {
            heap.pop();
            heap.push(Reverse(hit));
        }
    }
}

pub(crate) fn vector_search_impl(
    query_vector: &[f32],
    artifacts: &VectorArtifacts,
    top_k: usize,
) -> Result<Vec<SupersearchResultPayload>, String> {
    if query_vector.len() != artifacts.dims {
        return Err(format!(
            "query vector dims mismatch: expected {}, got {}",
            artifacts.dims,
            query_vector.len()
        ));
    }

    if artifacts.chunks.is_empty() || top_k == 0 {
        return Ok(Vec::new());
    }

    let limit = top_k.min(artifacts.chunks.len());
    let top_scores = artifacts
        .vectors
        .par_chunks_exact(artifacts.dims)
        .enumerate()
        .fold(
            || BinaryHeap::with_capacity(limit),
            |mut local_top, (idx, chunk_vector)| {
                let hit = ScoredChunk {
                    idx,
                    score: dot_product_unrolled(query_vector, chunk_vector),
                };
                push_top_score(&mut local_top, hit, limit);
                local_top
            },
        )
        .reduce(
            || BinaryHeap::with_capacity(limit),
            |mut merged, local| {
                for Reverse(hit) in local {
                    push_top_score(&mut merged, hit, limit);
                }
                merged
            },
        );

    let mut ranked = top_scores
        .into_iter()
        .map(|Reverse(hit)| hit)
        .collect::<Vec<_>>();
    ranked.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.idx.cmp(&b.idx))
    });

    Ok(ranked
        .into_iter()
        .map(|hit| {
            let chunk = &artifacts.chunks[hit.idx];
            SupersearchResultPayload {
                chunk_id: chunk.chunk_id,
                uuid: chunk.uuid.clone(),
                chunk_text: chunk.chunk_text.clone(),
                start_offset: chunk.start_offset,
                end_offset: chunk.end_offset,
                score: hit.score,
            }
        })
        .collect())
}

fn map_notify_event(event: &Event) -> Option<&'static str> {
    match event.kind {
        EventKind::Create(_) => Some("add"),
        // Ignore metadata-only changes (atime, permissions) — they don't affect
        // note content and on iOS/macOS kqueue fires these spuriously.
        EventKind::Modify(ModifyKind::Metadata(_)) => None,
        EventKind::Modify(_) => Some("change"),
        EventKind::Remove(_) => Some("unlink"),
        _ => None,
    }
}

/// List all regular files in the notes root directory with name, size, and mtime.
#[tauri::command]
pub async fn fs_list_dir_files(app: AppHandle) -> Result<Vec<DirFileEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        let entries = fs::read_dir(&base)
            .map_err(io_err_to_string)?
            .filter_map(|entry| entry.ok())
            .filter_map(|entry| {
                let name = entry.file_name().to_string_lossy().to_string();
                let meta = entry.metadata().ok()?;
                if !meta.is_file() {
                    return None;
                }
                Some(DirFileEntry {
                    name,
                    size: meta.len(),
                    mtime: file_mtime_ms(&meta),
                })
            })
            .collect();
        Ok(entries)
    })
    .await
    .map_err(task_join_err)?
}

/// Delete a file by name from the notes root. Rejects traversal characters.
#[tauri::command]
pub async fn fs_delete_file(app: AppHandle, filename: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if filename.contains("..") || filename.contains('/') || filename.contains('\\') {
            return Err("invalid filename".to_string());
        }
        let base = notes_root(&app)?;
        let path = base.join(&filename);
        fs::remove_file(&path).map_err(io_err_to_string)
    })
    .await
    .map_err(task_join_err)?
}

/// Thin command to set file mtime — plugin-fs does not support setting mtime,
/// so this remains a Rust command used by writeNote and sync.
#[tauri::command]
pub async fn fs_set_mtime(app: AppHandle, path: String, mtime_ms: i64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        let target = std::path::Path::new(&path);
        // Ensure the target path is under the notes root to prevent arbitrary mtime writes.
        let canonical_base = base.canonicalize().map_err(io_err_to_string)?;
        let canonical_target = target.canonicalize().map_err(io_err_to_string)?;
        if !canonical_target.starts_with(&canonical_base) {
            return Err("path outside notes directory".to_string());
        }
        set_file_mtime_ms(target, mtime_ms)
    })
    .await
    .map_err(task_join_err)?
}

#[tauri::command]
pub async fn supersearch_has_artifacts(app: AppHandle) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        let manifest = base.join(".supersearch-manifest.json");
        let vectors = base.join(".supersearch-vectors.bin");
        Ok(manifest.exists() && vectors.exists())
    })
    .await
    .map_err(task_join_err)?
}

#[tauri::command]
pub async fn supersearch_download(
    app: AppHandle,
    state: State<'_, CoreState>,
    server_url: String,
    token: String,
    meta: Option<SupersearchMeta>,
) -> Result<(), String> {
    let vectors_state = state.vectors.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        let normalized_base = server_url.trim_end_matches('/');
        let client = Client::new();

        let manifest_resp = client
            .get(format!("{normalized_base}/search/index?format=manifest"))
            .bearer_auth(&token)
            .send()
            .map_err(|err| err.to_string())?
            .error_for_status()
            .map_err(|err| err.to_string())?;
        let manifest = manifest_resp.text().map_err(|err| err.to_string())?;

        let vectors_resp = client
            .get(format!("{normalized_base}/search/index?format=bin"))
            .bearer_auth(&token)
            .send()
            .map_err(|err| err.to_string())?
            .error_for_status()
            .map_err(|err| err.to_string())?;
        let vectors = vectors_resp.bytes().map_err(|err| err.to_string())?;

        write_atomic_text(&base.join(".supersearch-manifest.json"), &manifest)?;
        fs::write(base.join(".supersearch-vectors.bin"), &vectors).map_err(io_err_to_string)?;

        let mut write = vectors_state
            .write()
            .map_err(|_| "vector cache lock poisoned".to_string())?;
        *write = None;

        if let Some(meta) = meta {
            let meta_json = serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?;
            write_atomic_text(&base.join(".supersearch-state.json"), &meta_json)?;
        }

        Ok(())
    })
    .await
    .map_err(task_join_err)?
}

#[derive(Clone, Serialize)]
pub struct NoteVectorEntry {
    pub uuid: String,
    pub vector: Vec<f32>,
}

#[tauri::command]
pub async fn supersearch_all_note_vectors(
    app: AppHandle,
    state: State<'_, CoreState>,
) -> Result<Vec<NoteVectorEntry>, String> {
    let vectors_state = state.vectors.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        let artifacts = ensure_vectors_loaded(&base, &vectors_state)?;
        let dims = artifacts.dims;

        // Group chunk indices by UUID
        let mut by_uuid: HashMap<&str, Vec<usize>> = HashMap::new();
        for (i, chunk) in artifacts.chunks.iter().enumerate() {
            by_uuid.entry(&chunk.uuid).or_default().push(i);
        }

        // Average + normalize per note (same logic as supersearch_note_vector)
        let mut result = Vec::with_capacity(by_uuid.len());
        for (uuid, indices) in &by_uuid {
            let mut avg = vec![0.0f32; dims];
            for &idx in indices {
                let offset = idx * dims;
                for (j, val) in avg.iter_mut().enumerate() {
                    *val += artifacts.vectors[offset + j];
                }
            }
            let count = indices.len() as f32;
            for val in avg.iter_mut() {
                *val /= count;
            }
            let norm: f32 = avg.iter().map(|v| v * v).sum::<f32>().sqrt();
            if norm > 0.0 {
                for val in avg.iter_mut() {
                    *val /= norm;
                }
            }
            result.push(NoteVectorEntry {
                uuid: uuid.to_string(),
                vector: avg,
            });
        }

        Ok(result)
    })
    .await
    .map_err(task_join_err)?
}

#[tauri::command]
pub async fn supersearch_note_vector(
    app: AppHandle,
    state: State<'_, CoreState>,
    uuid: String,
) -> Result<Vec<f32>, String> {
    let vectors_state = state.vectors.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        let artifacts = ensure_vectors_loaded(&base, &vectors_state)?;
        let dims = artifacts.dims;

        // Collect indices of chunks belonging to this UUID
        let indices: Vec<usize> = artifacts
            .chunks
            .iter()
            .enumerate()
            .filter(|(_, c)| c.uuid == uuid)
            .map(|(i, _)| i)
            .collect();

        if indices.is_empty() {
            return Err(format!("no chunks found for uuid {}", uuid));
        }

        // Average the vectors element-wise
        let mut avg = vec![0.0f32; dims];
        for &idx in &indices {
            let offset = idx * dims;
            for (j, val) in avg.iter_mut().enumerate() {
                *val += artifacts.vectors[offset + j];
            }
        }
        let count = indices.len() as f32;
        for val in avg.iter_mut() {
            *val /= count;
        }
        // Re-normalize so dot-product == cosine similarity
        let norm: f32 = avg.iter().map(|v| v * v).sum::<f32>().sqrt();
        if norm > 0.0 {
            for val in avg.iter_mut() {
                *val /= norm;
            }
        }

        Ok(avg)
    })
    .await
    .map_err(task_join_err)?
}

#[tauri::command]
pub async fn supersearch_query(
    app: AppHandle,
    state: State<'_, CoreState>,
    query_vector: Vec<f32>,
    top_k: usize,
) -> Result<Vec<SupersearchResultPayload>, String> {
    let vectors_state = state.vectors.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        let artifacts = ensure_vectors_loaded(&base, &vectors_state)?;
        vector_search_impl(&query_vector, artifacts.as_ref(), top_k)
    })
    .await
    .map_err(task_join_err)?
}

const ALLOWED_IMAGE_EXTS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico", "avif", "heic",
];

fn validate_image_ext(ext: &str) -> Result<String, String> {
    if ext.len() > 10 {
        return Err("image extension too long".to_string());
    }
    if ext.contains('/') || ext.contains('\\') || ext.contains("..") || ext.contains('\0') {
        return Err("image extension contains invalid characters".to_string());
    }
    let lower = ext.to_lowercase();
    if !ALLOWED_IMAGE_EXTS.contains(&lower.as_str()) {
        return Err(format!("disallowed image extension: {lower}"));
    }
    Ok(lower)
}

fn write_image_to_notes(base: &Path, data: &[u8], ext: &str) -> Result<String, String> {
    let ext = validate_image_ext(ext)?;
    let filename = format!("{}-{}.{}", now_ms(), rand_suffix(), ext);
    let dest = base.join(&filename);
    fs::write(dest, data).map_err(io_err_to_string)?;
    Ok(filename)
}

#[tauri::command]
pub async fn fs_save_image(app: AppHandle, source_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        let source = PathBuf::from(&source_path);
        let ext = source.extension().and_then(|s| s.to_str()).unwrap_or("jpg");
        let ext = validate_image_ext(ext)?;
        let data = fs::read(&source).map_err(io_err_to_string)?;
        write_image_to_notes(&base, &data, &ext)
    })
    .await
    .map_err(task_join_err)?
}

#[tauri::command]
pub async fn fs_save_image_bytes(
    app: AppHandle,
    data: Vec<u8>,
    ext: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        write_image_to_notes(&base, &data, &ext)
    })
    .await
    .map_err(task_join_err)?
}

/// Read an image from the native clipboard and save as PNG.
/// Used on Linux/Wayland where WebKitGTK gives empty clipboardData to JS.
#[tauri::command]
pub async fn fs_paste_clipboard_image(app: AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_clipboard_manager::ClipboardExt;
        let image = app.clipboard().read_image().map_err(|e| format!("Clipboard read failed: {e}"))?;
        let (width, height) = (image.width(), image.height());
        if width == 0 || height == 0 {
            return Err("No image in clipboard".to_string());
        }
        let mut png_buf = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut png_buf, width, height);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder
                .write_header()
                .map_err(|e| format!("PNG header error: {e}"))?;
            writer
                .write_image_data(image.rgba())
                .map_err(|e| format!("PNG write error: {e}"))?;
        }
        let base = notes_root(&app)?;
        write_image_to_notes(&base, &png_buf, "png")
    })
    .await
    .map_err(task_join_err)?
}

#[tauri::command]
pub async fn fs_get_image_path(app: AppHandle, filename: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        ensure_safe_note_id(&filename.replace('.', ""))?;
        let path = base.join(filename);
        Ok(path.to_string_lossy().to_string())
    })
    .await
    .map_err(task_join_err)?
}

#[tauri::command]
pub async fn fs_start_watcher(app: AppHandle, state: State<'_, CoreState>) -> Result<(), String> {
    let watcher_state = state.watcher.clone();
    let suppressed_watcher_events = state.suppressed_watcher_events.clone();
    let sync_writes_until = state.sync_writes_until.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = watcher_state
            .lock()
            .map_err(|_| "watcher lock poisoned".to_string())?;
        if guard.is_some() {
            return Ok(());
        }

        let base = notes_root(&app)?;
        let app_handle = app.clone();
        let mut watcher = RecommendedWatcher::new(
            move |res| {
                let Ok(event) = res else {
                    return;
                };
                let Some(change_type) = map_notify_event(&event) else {
                    return;
                };
                for path in event.paths {
                    let Some(filename) = path.file_name().and_then(|p| p.to_str()) else {
                        continue;
                    };
                    let lower = filename.to_lowercase();
                    if !lower.ends_with(".md") && !lower.ends_with(".txt") {
                        continue;
                    }
                    if sync_writes_until.load(Ordering::Acquire) > now_ms() {
                        continue;
                    }
                    let should_suppress = if let Ok(mut map) = suppressed_watcher_events.lock() {
                        let now = now_ms();
                        map.retain(|_, expiry| *expiry > now);
                        map.contains_key(filename)
                    } else {
                        false
                    };
                    if should_suppress {
                        continue;
                    }
                    let _ = app_handle.emit(
                        "fs:change",
                        serde_json::json!({
                            "type": change_type,
                            "filename": filename,
                        }),
                    );
                }
            },
            NotifyConfig::default(),
        )
        .map_err(|err| err.to_string())?;

        watcher
            .watch(&base, RecursiveMode::NonRecursive)
            .map_err(|err| err.to_string())?;

        *guard = Some(watcher);
        Ok(())
    })
    .await
    .map_err(task_join_err)?
}

#[tauri::command]
pub async fn notes_dir_override_load(app: AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok(load_notes_dir_override(&app).map(|p| p.to_string_lossy().to_string()))
    })
    .await
    .map_err(task_join_err)?
}

#[tauri::command]
pub async fn notes_dir_override_save(app: AppHandle, dir: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        save_notes_dir_override(&app, dir.as_deref())
    })
    .await
    .map_err(task_join_err)?
}

#[tauri::command]
pub async fn fs_ensure_dir(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        fs::create_dir_all(&path).map_err(io_err_to_string)
    })
    .await
    .map_err(task_join_err)?
}

/// Resolves the default notes root, honoring the STONEFRUIT_DATA_DIR env var
/// used to isolate per-worktree dev and cross-platform test runs. The webview
/// cannot read process env, so the TypeScript path layer delegates here.
#[tauri::command]
pub async fn resolve_default_notes_root(app: AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = default_notes_root(&app)?;
        Ok(root.to_string_lossy().to_string())
    })
    .await
    .map_err(task_join_err)?
}

fn rand_suffix() -> String {
    let n = now_ms().unsigned_abs() % 10_000;
    format!("{n:04}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};

    fn temp_notes_dir() -> PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("futo-tauri-test-{}-{n}", now_ms()));
        fs::create_dir_all(&dir).expect("create temp test dir");
        dir
    }

    fn cleanup_temp_dir(path: &Path) {
        let _ = fs::remove_dir_all(path);
    }

    // Serialize env-var mutations to prevent flaky failures when tests run in parallel.
    static ENV_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn env_data_dir_returns_none_when_unset() {
        let _guard = ENV_MUTEX.lock().unwrap();
        std::env::remove_var("STONEFRUIT_DATA_DIR");
        assert_eq!(env_data_dir(), None);
    }

    #[test]
    fn env_data_dir_returns_path_when_set() {
        let _guard = ENV_MUTEX.lock().unwrap();
        std::env::set_var("STONEFRUIT_DATA_DIR", "/tmp/wt-test-data");
        let result = env_data_dir();
        std::env::remove_var("STONEFRUIT_DATA_DIR");
        assert_eq!(result, Some(PathBuf::from("/tmp/wt-test-data")));
    }

    #[test]
    fn override_file_resolves_to_env_data_dir() {
        let _guard = ENV_MUTEX.lock().unwrap();
        std::env::set_var("STONEFRUIT_DATA_DIR", "/tmp/wt-test-data");
        let expected = PathBuf::from("/tmp/wt-test-data").join(NOTES_DIR_OVERRIDE_FILE);
        let actual = env_data_dir().map(|d| d.join(NOTES_DIR_OVERRIDE_FILE));
        std::env::remove_var("STONEFRUIT_DATA_DIR");
        assert_eq!(actual, Some(expected));
    }

    #[test]
    fn default_notes_dir_resolves_to_env_data_dir_notes() {
        let _guard = ENV_MUTEX.lock().unwrap();
        std::env::set_var("STONEFRUIT_DATA_DIR", "/tmp/wt-test-data");
        let expected = PathBuf::from("/tmp/wt-test-data").join("notes");
        let actual = env_data_dir().map(|d| d.join("notes"));
        std::env::remove_var("STONEFRUIT_DATA_DIR");
        assert_eq!(actual, Some(expected));
    }


    #[test]
    fn sha256_matches_expected() {
        assert_eq!(
            hash_sha256("hello"),
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }

    #[test]
    fn vector_search_returns_best_dot_products() {
        let artifacts = VectorArtifacts {
            dims: 3,
            chunks: vec![
                ManifestChunk {
                    chunk_id: 1,
                    uuid: "a".to_string(),
                    chunk_text: "alpha".to_string(),
                    start_offset: 0,
                    end_offset: 5,
                },
                ManifestChunk {
                    chunk_id: 2,
                    uuid: "b".to_string(),
                    chunk_text: "beta".to_string(),
                    start_offset: 0,
                    end_offset: 4,
                },
            ],
            vectors: vec![
                1.0, 0.0, 0.0, // chunk a
                0.0, 1.0, 0.0, // chunk b
            ],
        };
        let results = vector_search_impl(&[0.9, 0.1, 0.0], &artifacts, 2).expect("vector search");
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].chunk_id, 1);
        assert!(results[0].score > results[1].score);
    }

    // V1 sync tests removed — V1 protocol is dead code.
    // See git history for original tests.

    // ── F. Rust Chaos Tests ─────────────────────────────────────────────
    // (V1-dependent chaos tests removed; non-V1 tests preserved below)

    #[test]
    fn ensure_safe_note_id_allows_whitespace_only() {
        // Documents that whitespace-only IDs pass validation (potential gap)
        let result = ensure_safe_note_id("   ");
        // Current impl allows this — documenting the behavior
        assert!(
            result.is_ok(),
            "whitespace-only ID is currently allowed (validation gap)"
        );
    }

    // ── Image extension validation ──────────────────────────────────

    #[test]
    fn validate_image_ext_accepts_allowed_extensions() {
        for ext in ALLOWED_IMAGE_EXTS {
            assert!(validate_image_ext(ext).is_ok(), "should accept {ext}");
        }
        // Case-insensitive
        assert_eq!(validate_image_ext("JPG").unwrap(), "jpg");
        assert_eq!(validate_image_ext("Png").unwrap(), "png");
    }

    #[test]
    fn validate_image_ext_rejects_non_image_extensions() {
        assert!(validate_image_ext("exe").is_err());
        assert!(validate_image_ext("sh").is_err());
        assert!(validate_image_ext("md").is_err());
        assert!(validate_image_ext("html").is_err());
        assert!(validate_image_ext("js").is_err());
    }

    #[test]
    fn validate_image_ext_rejects_path_traversal() {
        assert!(validate_image_ext("../../../etc/evil").is_err());
        assert!(validate_image_ext("..").is_err());
        assert!(validate_image_ext("jpg/../../etc/passwd").is_err());
        assert!(validate_image_ext("jpg\\..\\..\\evil").is_err());
    }

    #[test]
    fn validate_image_ext_rejects_null_bytes() {
        assert!(validate_image_ext("jpg\0exe").is_err());
        assert!(validate_image_ext("\0").is_err());
    }

    #[test]
    fn validate_image_ext_rejects_overlong() {
        assert!(validate_image_ext("abcdefghijk").is_err()); // 11 chars
    }

    #[test]
    fn write_image_to_notes_rejects_bad_ext() {
        let base = temp_notes_dir();
        let data = b"fake image bytes";
        assert!(write_image_to_notes(&base, data, "exe").is_err());
        assert!(write_image_to_notes(&base, data, "../../../etc/evil").is_err());
        // Ensure no file was written
        let files: Vec<_> = fs::read_dir(&base).unwrap().collect();
        assert!(
            files.is_empty(),
            "no files should be written for rejected extensions"
        );
        cleanup_temp_dir(&base);
    }

    #[test]
    fn write_image_to_notes_accepts_valid_ext() {
        let base = temp_notes_dir();
        let data = b"fake image bytes";
        let filename = write_image_to_notes(&base, data, "jpg").unwrap();
        assert!(filename.ends_with(".jpg"));
        assert!(base.join(&filename).exists());
        cleanup_temp_dir(&base);
    }

    #[test]
    fn hash_sha256_bytes_correct() {
        let data = b"hello world";
        let hash = hash_sha256_bytes(data);
        assert_eq!(
            hash,
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        );
    }

    // ── G. .txt → .md conversion tests ─────────────────────────────────

    #[test]
    fn convert_txt_renames_to_md() {
        let base = temp_notes_dir();
        fs::write(base.join("groceries.txt"), "milk\neggs").unwrap();

        convert_txt_to_md(&base);

        assert!(!base.join("groceries.txt").exists());
        assert!(base.join("groceries.md").exists());
        assert_eq!(
            fs::read_to_string(base.join("groceries.md")).unwrap(),
            "milk\neggs"
        );

        cleanup_temp_dir(&base);
    }

    #[test]
    fn convert_txt_handles_collision_with_existing_md() {
        let base = temp_notes_dir();
        fs::write(base.join("note.md"), "md content").unwrap();
        fs::write(base.join("note.txt"), "txt content").unwrap();

        convert_txt_to_md(&base);

        // .md should be untouched
        assert_eq!(
            fs::read_to_string(base.join("note.md")).unwrap(),
            "md content"
        );
        // .txt should become (imported).md
        assert!(!base.join("note.txt").exists());
        assert!(base.join("note (imported).md").exists());
        assert_eq!(
            fs::read_to_string(base.join("note (imported).md")).unwrap(),
            "txt content"
        );

        cleanup_temp_dir(&base);
    }

    #[test]
    fn convert_txt_ignores_non_txt_files() {
        let base = temp_notes_dir();
        fs::write(base.join("data.csv"), "a,b,c").unwrap();
        fs::write(base.join("note.md"), "content").unwrap();

        convert_txt_to_md(&base);

        // csv should not be touched
        assert!(base.join("data.csv").exists());
        assert!(base.join("note.md").exists());

        cleanup_temp_dir(&base);
    }

    #[test]
    fn convert_txt_case_insensitive() {
        let base = temp_notes_dir();
        fs::write(base.join("uppercase.TXT"), "upper").unwrap();
        fs::write(base.join("mixed.Txt"), "mixed").unwrap();

        convert_txt_to_md(&base);

        assert!(!base.join("uppercase.TXT").exists());
        assert!(base.join("uppercase.md").exists());
        assert_eq!(
            fs::read_to_string(base.join("uppercase.md")).unwrap(),
            "upper"
        );

        assert!(!base.join("mixed.Txt").exists());
        assert!(base.join("mixed.md").exists());
        assert_eq!(fs::read_to_string(base.join("mixed.md")).unwrap(), "mixed");

        cleanup_temp_dir(&base);
    }

}

