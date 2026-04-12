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
use stonefruit_core::files::{
    ensure_safe_note_id, file_mtime_ms, note_id_from_filename, safe_appdata_path, safe_note_path,
    set_file_mtime_ms,
};
use stonefruit_core::hash::hash_sha256;
#[cfg(test)]
use stonefruit_core::hash::hash_sha256_bytes;
use tauri::{AppHandle, Emitter, Manager, State};

pub(crate) use stonefruit_core::files::{now_ms, write_atomic_text};

#[derive(Default)]
struct EngagementState {
    loaded: bool,
    dirty: bool,
    data: EngagementData,
}

#[derive(Clone, Serialize, Deserialize, Default)]
struct EngagementData {
    version: u8,
    notes: HashMap<String, EngagementRecord>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngagementRecord {
    last_opened_at: i64,
    open_count: u32,
    last_edited_at: i64,
    edit_count: u32,
}

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
    index: Arc<RwLock<SearchIndexState>>,
    watcher: Arc<Mutex<Option<RecommendedWatcher>>>,
    suppressed_watcher_events: Arc<Mutex<HashMap<String, i64>>>,
    sync_writes_until: Arc<AtomicI64>,
    pub(crate) vectors: Arc<RwLock<Option<Arc<VectorArtifacts>>>>,
    engagement: Arc<RwLock<EngagementState>>,
    supersearch_meta: Arc<RwLock<Option<SupersearchMeta>>>,
}

const WATCHER_SUPPRESSION_MS: i64 = 5_000;

const APP_CONFIG_PATH: &str = ".app-config.json";
const NOTE_PREVIEW_CACHE_FILE: &str = ".note-preview-cache.json";
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

#[derive(Default)]
struct SearchIndexState {
    loaded: bool,
    bodies_loaded: bool,
    notes: HashMap<String, IndexedNote>,
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

#[derive(Clone)]
struct IndexedNote {
    id: String,
    title: String,
    body: String,
    preview: String,
    mtime: i64,
    body_lower: String,
    title_lower: String,
    headings_lower: String,
    tags: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotePreviewPayload {
    pub id: String,
    pub title: String,
    pub preview: String,
    pub modification_time: i64,
    pub tags: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct NoteFileEntry {
    pub name: String,
    pub mtime: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct AppConfigFile {
    pub sidebar_width: Option<u32>,
    pub graph_sidebar_width: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfigPayload {
    pub notes_dir: String,
    pub sidebar_width: Option<u32>,
    pub graph_sidebar_width: Option<u32>,
    pub is_custom_dir: bool,
    pub default_notes_dir: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct AppConfigUpdates {
    pub sidebar_width: Option<Option<u32>>,
    pub graph_sidebar_width: Option<Option<u32>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HashCacheEntry {
    pub modified_at: i64,
    pub hash: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImageFileEntry {
    pub filename: String,
    pub size: u64,
    pub mtime: i64,
}

#[derive(Clone, Serialize, Deserialize)]
struct CachedNoteMeta {
    mtime: i64,
    preview: String,
    tags: Vec<String>,
    headings_lower: String,
}

#[derive(Serialize, Deserialize, Default)]
struct NoteMetadataCache {
    version: u8,
    entries: HashMap<String, CachedNoteMeta>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeywordSearchInput {
    pub query: String,
    pub limit: Option<usize>,
}

#[derive(Debug, Serialize)]
pub struct SnippetSegmentPayload {
    pub text: String,
    pub highlight: bool,
}

#[derive(Debug, Serialize)]
pub struct SearchResultPayload {
    pub note: NotePreviewPayload,
    pub snippet: Option<Vec<SnippetSegmentPayload>>,
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

fn load_app_config(base: &Path) -> AppConfigFile {
    let path = base.join(APP_CONFIG_PATH);
    let Ok(raw) = fs::read_to_string(path) else {
        return AppConfigFile::default();
    };
    serde_json::from_str::<AppConfigFile>(&raw).unwrap_or_default()
}

fn save_app_config(base: &Path, cfg: &AppConfigFile) -> Result<(), String> {
    let path = base.join(APP_CONFIG_PATH);
    let serialized = serde_json::to_string_pretty(cfg).map_err(|err| err.to_string())?;
    write_atomic_text(&path, &serialized)
}

fn load_note_cache(base: &Path) -> NoteMetadataCache {
    let path = base.join(NOTE_PREVIEW_CACHE_FILE);
    let Ok(raw) = fs::read_to_string(path) else {
        return NoteMetadataCache::default();
    };
    let mut cache: NoteMetadataCache =
        serde_json::from_str(&raw).unwrap_or_default();
    if cache.version != 1 {
        cache = NoteMetadataCache::default();
    }
    cache
}

fn save_note_cache(base: &Path, cache: &NoteMetadataCache) {
    let path = base.join(NOTE_PREVIEW_CACHE_FILE);
    if let Ok(json) = serde_json::to_string(cache) {
        let _ = write_atomic_text(&path, &json);
    }
}

fn extract_headings(content: &str) -> String {
    content
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim_start();
            if !trimmed.starts_with('#') {
                return None;
            }
            let mut chars = trimmed.chars();
            let mut hash_count = 0;
            while let Some('#') = chars.next() {
                hash_count += 1;
            }
            if hash_count == 0 || hash_count > 6 {
                return None;
            }
            if !trimmed
                .chars()
                .nth(hash_count)
                .map(|c| c.is_whitespace())
                .unwrap_or(false)
            {
                return None;
            }
            Some(trimmed[hash_count..].trim().to_string())
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Extract unique hashtags from note content, excluding tags inside code fences/inline code.
/// Returns tags with the `#` prefix, deduplicated case-insensitively (first occurrence wins).
fn extract_tags(content: &str) -> Vec<String> {
    let mut tags = Vec::new();
    let mut seen = HashSet::new();
    let mut in_fence = false;
    let mut fence_char: char = '`';
    let mut fence_len: usize = 0;

    for line in content.lines() {
        let trimmed = line.trim_start();
        // Check for fenced code block boundaries
        if !in_fence {
            let fc = trimmed.chars().next().unwrap_or('\0');
            if (fc == '`' || fc == '~') && trimmed.starts_with(&fc.to_string().repeat(3)) {
                let count = trimmed.chars().take_while(|&c| c == fc).count();
                in_fence = true;
                fence_char = fc;
                fence_len = count;
                continue;
            }
        } else {
            let fc = trimmed.chars().next().unwrap_or('\0');
            if fc == fence_char {
                let count = trimmed.chars().take_while(|&c| c == fc).count();
                if count >= fence_len && trimmed[count..].trim().is_empty() {
                    in_fence = false;
                }
            }
            continue;
        }

        // Strip inline code spans from this line before scanning for tags
        let cleaned = strip_inline_code(line);
        extract_tags_from_line(&cleaned, &mut tags, &mut seen);
    }

    tags
}

/// Remove inline code spans (backtick-delimited) from a line, replacing with spaces.
fn strip_inline_code(line: &str) -> String {
    let mut result = String::with_capacity(line.len());
    let chars: Vec<char> = line.chars().collect();
    let len = chars.len();
    let mut i = 0;

    while i < len {
        if chars[i] == '`' {
            // Count opening backticks
            let start = i;
            let mut tick_count = 0;
            while i < len && chars[i] == '`' {
                tick_count += 1;
                i += 1;
            }
            // Find matching closing backticks
            let mut found = false;
            while i <= len.saturating_sub(tick_count) {
                if chars[i] == '`' {
                    let mut close_count = 0;
                    while i < len && chars[i] == '`' {
                        close_count += 1;
                        i += 1;
                    }
                    if close_count == tick_count {
                        // Replace entire span with spaces
                        for _ in start..i {
                            result.push(' ');
                        }
                        found = true;
                        break;
                    }
                } else {
                    i += 1;
                }
            }
            if !found {
                // No closing found, output the backticks literally
                for c in &chars[start..] {
                    result.push(*c);
                }
                break;
            }
        } else {
            result.push(chars[i]);
            i += 1;
        }
    }

    result
}

/// Extract tags from a single line of text (already cleaned of inline code).
fn extract_tags_from_line(line: &str, tags: &mut Vec<String>, seen: &mut HashSet<String>) {
    let chars: Vec<char> = line.chars().collect();
    let len = chars.len();
    let mut i = 0;

    while i < len {
        if chars[i] == '#' {
            // Check preceded by whitespace or start-of-line
            let at_start = i == 0 || chars[i - 1].is_whitespace();
            if !at_start {
                i += 1;
                continue;
            }
            // Must be followed by a letter
            let tag_start = i;
            i += 1; // skip #
            if i >= len || !chars[i].is_ascii_alphabetic() {
                continue;
            }
            // Consume tag body: letters, digits, hyphens, underscores
            let body_start = i;
            while i < len
                && (chars[i].is_ascii_alphanumeric() || chars[i] == '-' || chars[i] == '_')
            {
                i += 1;
            }
            let body_len = i - body_start;
            if body_len > 50 {
                continue;
            }
            // Must be followed by whitespace, end-of-line, or punctuation
            if i < len
                && !chars[i].is_whitespace()
                && !matches!(
                    chars[i],
                    '.' | ',' | ';' | ':' | '!' | '?' | ')' | '}' | ']'
                )
            {
                continue;
            }
            let tag: String = chars[tag_start..i].iter().collect();
            let lower = tag.to_lowercase();
            if !seen.contains(&lower) {
                seen.insert(lower);
                tags.push(tag);
            }
        } else {
            i += 1;
        }
    }
}

fn make_preview(content: &str) -> String {
    content
        .chars()
        .take(100)
        .collect::<String>()
        .replace('\n', " ")
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

fn floor_char_boundary(text: &str, idx: usize) -> usize {
    let mut i = idx.min(text.len());
    while i > 0 && !text.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn ceil_char_boundary(text: &str, idx: usize) -> usize {
    let mut i = idx.min(text.len());
    while i < text.len() && !text.is_char_boundary(i) {
        i += 1;
    }
    i
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

fn build_indexed_note(id: String, body: String, mtime: i64) -> IndexedNote {
    let headings = extract_headings(&body);
    let tags = extract_tags(&body);
    IndexedNote {
        title: id.clone(),
        title_lower: id.to_lowercase(),
        preview: make_preview(&body),
        body_lower: body.to_lowercase(),
        headings_lower: headings.to_lowercase(),
        body,
        mtime,
        id,
        tags,
    }
}

fn note_to_preview(note: &IndexedNote) -> NotePreviewPayload {
    NotePreviewPayload {
        id: note.id.clone(),
        title: note.title.clone(),
        preview: note.preview.clone(),
        modification_time: note.mtime,
        tags: note.tags.clone(),
    }
}

fn scan_notes(base: &Path) -> Result<HashMap<String, IndexedNote>, String> {
    convert_txt_to_md(base);
    let cache = load_note_cache(base);

    let entries: Vec<(String, PathBuf, i64)> = fs::read_dir(base)
        .map_err(io_err_to_string)?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            let id = note_id_from_filename(&name)?;
            let path = entry.path();
            let metadata = entry.metadata().ok()?;
            if !metadata.is_file() {
                return None;
            }
            Some((id, path, file_mtime_ms(&metadata)))
        })
        .collect();

    let indexed = entries
        .par_iter()
        .filter_map(|(id, path, mtime)| {
            // Use cached metadata when mtime matches — skip reading the file body
            if let Some(cached) = cache.entries.get(id.as_str()) {
                if cached.mtime == *mtime {
                    return Some(IndexedNote {
                        title: id.clone(),
                        title_lower: id.to_lowercase(),
                        preview: cached.preview.clone(),
                        body_lower: String::new(),
                        headings_lower: cached.headings_lower.clone(),
                        body: String::new(),
                        mtime: *mtime,
                        id: id.clone(),
                        tags: cached.tags.clone(),
                    });
                }
            }

            let body = fs::read_to_string(path).ok()?;
            Some(build_indexed_note(id.clone(), body, *mtime))
        })
        .collect::<Vec<_>>();

    // Build updated cache from scan results
    let new_cache = NoteMetadataCache {
        version: 1,
        entries: indexed
            .iter()
            .map(|note| {
                (
                    note.id.clone(),
                    CachedNoteMeta {
                        mtime: note.mtime,
                        preview: note.preview.clone(),
                        tags: note.tags.clone(),
                        headings_lower: note.headings_lower.clone(),
                    },
                )
            })
            .collect(),
    };
    save_note_cache(base, &new_cache);

    let mut map = HashMap::with_capacity(indexed.len());
    for note in indexed {
        map.insert(note.id.clone(), note);
    }
    Ok(map)
}

/// Load file bodies for notes that were constructed from the preview cache
/// (body left empty to speed up startup). Called lazily before keyword search.
fn backfill_bodies(base: &Path, notes: &mut HashMap<String, IndexedNote>) {
    let deferred: Vec<String> = notes
        .iter()
        .filter(|(_, note)| note.body.is_empty())
        .map(|(id, _)| id.clone())
        .collect();

    if deferred.is_empty() {
        return;
    }

    let loaded: Vec<(String, String)> = deferred
        .par_iter()
        .filter_map(|id| {
            let path = base.join(format!("{}.md", id));
            let body = fs::read_to_string(&path).ok()?;
            Some((id.clone(), body))
        })
        .collect();

    for (id, body) in loaded {
        if let Some(note) = notes.get_mut(&id) {
            note.body_lower = body.to_lowercase();
            note.body = body;
        }
    }
}

/// Fast preview-only scan: returns sorted previews without loading full file
/// bodies into the search index.  Cache-hit files (mtime unchanged) are served
/// entirely from the on-disk metadata cache — no `read_to_string` at all.
/// Cache-miss files are read once to extract preview/tags/headings, then the
/// body is dropped.  The search index (`SearchIndexState`) is NOT populated;
/// keyword search will lazily build it on first use via `ensure_index_loaded`.
fn scan_note_previews(base: &Path) -> Result<Vec<NotePreviewPayload>, String> {
    convert_txt_to_md(base);
    let cache = load_note_cache(base);

    let entries: Vec<(String, PathBuf, i64)> = fs::read_dir(base)
        .map_err(io_err_to_string)?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            let id = note_id_from_filename(&name)?;
            let path = entry.path();
            let metadata = entry.metadata().ok()?;
            if !metadata.is_file() {
                return None;
            }
            Some((id, path, file_mtime_ms(&metadata)))
        })
        .collect();

    let results: Vec<(NotePreviewPayload, Option<CachedNoteMeta>)> = entries
        .par_iter()
        .filter_map(|(id, path, mtime)| {
            // Cache hit — no file read needed
            if let Some(cached) = cache.entries.get(id.as_str()) {
                if cached.mtime == *mtime {
                    return Some((
                        NotePreviewPayload {
                            id: id.clone(),
                            title: id.clone(),
                            preview: cached.preview.clone(),
                            modification_time: *mtime,
                            tags: cached.tags.clone(),
                        },
                        None, // no cache update needed
                    ));
                }
            }

            // Cache miss — read file to extract metadata, then discard body
            let body = fs::read_to_string(path).ok()?;
            let preview = make_preview(&body);
            let tags = extract_tags(&body);
            let headings_lower = extract_headings(&body).to_lowercase();

            Some((
                NotePreviewPayload {
                    id: id.clone(),
                    title: id.clone(),
                    preview: preview.clone(),
                    modification_time: *mtime,
                    tags: tags.clone(),
                },
                Some(CachedNoteMeta {
                    mtime: *mtime,
                    preview,
                    tags,
                    headings_lower,
                }),
            ))
        })
        .collect();

    // Merge cache updates into the existing cache (keep hits, replace misses)
    let mut new_entries = HashMap::with_capacity(results.len());
    let mut previews = Vec::with_capacity(results.len());
    for (preview, maybe_new_meta) in results {
        let id = preview.id.clone();
        previews.push(preview);
        if let Some(meta) = maybe_new_meta {
            new_entries.insert(id, meta);
        } else if let Some(existing) = cache.entries.get(&id) {
            new_entries.insert(id, existing.clone());
        }
    }

    // Only re-save if there were cache misses or deletions
    if new_entries.len() != cache.entries.len()
        || new_entries.keys().any(|k| !cache.entries.contains_key(k))
    {
        save_note_cache(
            base,
            &NoteMetadataCache {
                version: 1,
                entries: new_entries,
            },
        );
    }

    previews.sort_by(|a, b| {
        b.modification_time
            .cmp(&a.modification_time)
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(previews)
}

fn ensure_index_loaded(base: &Path, state: &Arc<RwLock<SearchIndexState>>) -> Result<(), String> {
    {
        let read = state
            .read()
            .map_err(|_| "search index lock poisoned".to_string())?;
        if read.loaded {
            return Ok(());
        }
    }

    let scanned = scan_notes(base)?;
    let mut write = state
        .write()
        .map_err(|_| "search index lock poisoned".to_string())?;
    write.notes = scanned;
    write.loaded = true;
    write.bodies_loaded = false;
    Ok(())
}

fn ensure_engagement_loaded(
    base: &Path,
    state: &Arc<RwLock<EngagementState>>,
) -> Result<(), String> {
    {
        let read = state
            .read()
            .map_err(|_| "engagement lock poisoned".to_string())?;
        if read.loaded {
            return Ok(());
        }
    }

    let path = base.join(".engagement-v1.json");
    let data = if path.exists() {
        let raw = fs::read_to_string(&path).map_err(io_err_to_string)?;
        serde_json::from_str::<EngagementData>(&raw).unwrap_or_else(|_| EngagementData {
            version: 1,
            notes: HashMap::new(),
        })
    } else {
        EngagementData {
            version: 1,
            notes: HashMap::new(),
        }
    };

    let mut write = state
        .write()
        .map_err(|_| "engagement lock poisoned".to_string())?;
    if !write.loaded {
        write.data = data;
        write.loaded = true;
    }
    Ok(())
}

fn load_supersearch_meta(base: &Path) -> Option<SupersearchMeta> {
    let path = base.join(".supersearch-state.json");
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str::<SupersearchMeta>(&raw).ok()
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
    mut state: V2SyncState,
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
    index: &Arc<RwLock<SearchIndexState>>,
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

        // Update search index
        let id = filename.strip_suffix(".md").unwrap_or(filename);
        if let Ok(mut idx) = index.write() {
            if idx.loaded {
                idx.notes.remove(id);
            }
        }
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

        let id = update
            .filename
            .strip_suffix(".md")
            .unwrap_or(&update.filename);
        let actual_mtime = fs::metadata(&path)
            .map(|meta| file_mtime_ms(&meta))
            .unwrap_or(now_ms());

        if let Ok(mut idx) = index.write() {
            if idx.loaded {
                idx.notes.insert(
                    id.to_string(),
                    build_indexed_note(id.to_string(), update.content.clone(), actual_mtime),
                );
            }
        }

        updated_filenames.push(update.filename.clone());
    }

    // Write conflict copies
    for conflict in &input.conflicts {
        suppress_filename(&conflict.filename);
        let path = base.join(&conflict.filename);
        write_atomic_text(&path, &conflict.content)?;

        let id = conflict
            .filename
            .strip_suffix(".md")
            .unwrap_or(&conflict.filename);
        let actual_mtime = fs::metadata(&path)
            .map(|meta| file_mtime_ms(&meta))
            .unwrap_or(now_ms());

        if let Ok(mut idx) = index.write() {
            if idx.loaded {
                idx.notes.insert(
                    id.to_string(),
                    build_indexed_note(id.to_string(), conflict.content.clone(), actual_mtime),
                );
            }
        }

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
    let index = state.index.clone();
    let suppressed = state.suppressed_watcher_events.clone();
    let sync_until = state.sync_writes_until.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        apply_sync_delta_v2_impl(&base, &index, &suppressed, &sync_until, input)
    })
    .await
    .map_err(task_join_err)?
}

fn build_highlighted_segments(text: &str, terms: &[String]) -> Vec<SnippetSegmentPayload> {
    if terms.is_empty() {
        return vec![SnippetSegmentPayload {
            text: text.to_string(),
            highlight: false,
        }];
    }

    let lower = text.to_lowercase();
    let mut ranges: Vec<(usize, usize)> = Vec::new();

    for term in terms {
        if term.is_empty() {
            continue;
        }
        let mut start = 0;
        while start < lower.len() {
            if let Some(pos) = lower[start..].find(term) {
                let real = start + pos;
                ranges.push((real, real + term.len()));
                start = real + 1;
            } else {
                break;
            }
        }
    }

    if ranges.is_empty() {
        return vec![SnippetSegmentPayload {
            text: text.to_string(),
            highlight: false,
        }];
    }

    ranges.sort_by(|a, b| a.0.cmp(&b.0));
    let mut merged = vec![ranges[0]];
    for (start, end) in ranges.into_iter().skip(1) {
        let last = merged.last_mut().expect("merged has first element");
        if start <= last.1 {
            last.1 = last.1.max(end);
        } else {
            merged.push((start, end));
        }
    }

    let mut segments = Vec::new();
    let mut cursor = 0;
    for (start, end) in merged {
        let start = floor_char_boundary(text, start);
        let end = ceil_char_boundary(text, end);
        if cursor < start {
            segments.push(SnippetSegmentPayload {
                text: text[cursor..start].to_string(),
                highlight: false,
            });
        }
        segments.push(SnippetSegmentPayload {
            text: text[start..end].to_string(),
            highlight: true,
        });
        cursor = end;
    }
    if cursor < text.len() {
        segments.push(SnippetSegmentPayload {
            text: text[cursor..].to_string(),
            highlight: false,
        });
    }

    segments
}

fn snippet_for_note(note: &IndexedNote, terms: &[String]) -> Vec<SnippetSegmentPayload> {
    if terms.is_empty() {
        return vec![SnippetSegmentPayload {
            text: note.preview.clone(),
            highlight: false,
        }];
    }

    let body = note.body.replace('\n', " ");
    let body_lower = body.to_lowercase();

    let mut best_pos: Option<(usize, usize)> = None;
    for term in terms {
        if let Some(pos) = body_lower.find(term) {
            let candidate = (pos, term.len());
            if best_pos.map(|(p, _)| pos < p).unwrap_or(true) {
                best_pos = Some(candidate);
            }
        }
    }

    let text = if let Some((pos, len)) = best_pos {
        let window = 120usize;
        let half = window.saturating_sub(len) / 2;
        let start = floor_char_boundary(&body, pos.saturating_sub(half));
        let end = ceil_char_boundary(&body, (pos + len + half).min(body.len()));
        let mut snippet = body[start..end].to_string();
        if start > 0 {
            snippet.insert_str(0, "...");
        }
        if end < body.len() {
            snippet.push_str("...");
        }
        snippet
    } else {
        let mut snippet = body.chars().take(120).collect::<String>();
        if body.len() > 120 {
            snippet.push_str("...");
        }
        snippet
    };

    build_highlighted_segments(&text, terms)
}

fn keyword_search_impl(
    notes: &HashMap<String, IndexedNote>,
    query: &str,
    limit: usize,
) -> Vec<SearchResultPayload> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        let mut all: Vec<_> = notes.values().collect();
        all.sort_by(|a, b| b.mtime.cmp(&a.mtime));
        return all
            .into_iter()
            .take(limit)
            .map(|note| SearchResultPayload {
                note: note_to_preview(note),
                snippet: None,
            })
            .collect();
    }

    let terms: Vec<String> = trimmed
        .split_whitespace()
        .map(|t| t.to_lowercase())
        .filter(|t| !t.is_empty())
        .collect();

    let mut scored: Vec<(f32, &IndexedNote)> = Vec::new();

    for note in notes.values() {
        let mut score = 0.0f32;
        for term in &terms {
            if note.title_lower.contains(term) {
                score += 8.0;
            }
            if note.headings_lower.contains(term) {
                score += 4.0;
            }
            if note.body_lower.contains(term) {
                score += 1.0;
            }
        }
        if score > 0.0 {
            // Recency boost over 30 days.
            let age_days = ((now_ms() - note.mtime).max(0) as f32) / (1000.0 * 60.0 * 60.0 * 24.0);
            let recency = (1.0 - (age_days / 30.0)).max(0.0);
            scored.push((score + recency, note));
        }
    }

    scored.sort_by(|(score_a, note_a), (score_b, note_b)| {
        score_b
            .partial_cmp(score_a)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(note_b.mtime.cmp(&note_a.mtime))
    });

    scored
        .into_iter()
        .take(limit)
        .map(|(_, note)| SearchResultPayload {
            note: note_to_preview(note),
            snippet: Some(snippet_for_note(note, &terms)),
        })
        .collect()
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

#[tauri::command]
pub async fn fs_list_note_files(app: AppHandle) -> Result<Vec<NoteFileEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        convert_txt_to_md(&base);
        let mut files = fs::read_dir(&base)
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
                Some(NoteFileEntry {
                    name,
                    mtime: file_mtime_ms(&meta),
                })
            })
            .collect::<Vec<_>>();
        files.sort_by(|a, b| b.mtime.cmp(&a.mtime));
        Ok(files)
    })
    .await
    .map_err(task_join_err)?
}

#[tauri::command]
pub async fn fs_read_note(app: AppHandle, id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        let path = safe_note_path(&base, &id)?;
        fs::read_to_string(path).map_err(io_err_to_string)
    })
    .await
    .map_err(task_join_err)?
}

#[tauri::command]
pub async fn fs_write_note(
    app: AppHandle,
    state: State<'_, CoreState>,
    id: String,
    content: String,
    modified_at_ms: Option<i64>,
) -> Result<i64, String> {
    let index = state.index.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        let path = safe_note_path(&base, &id)?;
        write_atomic_text(&path, &content)?;

        if let Some(ms) = modified_at_ms {
            if ms >= 0 {
                let _ = set_file_mtime_ms(&path, ms);
            }
        }

        let mtime = fs::metadata(&path)
            .map(|meta| file_mtime_ms(&meta))
            .unwrap_or_else(|_| now_ms());

        if let Ok(mut idx) = index.write() {
            if idx.loaded {
                idx.notes
                    .insert(id.clone(), build_indexed_note(id, content, mtime));
            }
        }

        Ok(mtime)
    })
    .await
    .map_err(task_join_err)?
}

#[tauri::command]
pub async fn fs_delete_note_file(
    app: AppHandle,
    state: State<'_, CoreState>,
    id: String,
) -> Result<(), String> {
    let index = state.index.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        let path = safe_note_path(&base, &id)?;
        let _ = fs::remove_file(path);

        if let Ok(mut idx) = index.write() {
            if idx.loaded {
                idx.notes.remove(&id);
            }
        }
        Ok(())
    })
    .await
    .map_err(task_join_err)?
}

#[tauri::command]
pub async fn fs_note_exists(app: AppHandle, id: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        let path = safe_note_path(&base, &id)?;
        Ok(path.exists())
    })
    .await
    .map_err(task_join_err)?
}

#[tauri::command]
pub async fn fs_delete_all_content(
    app: AppHandle,
    state: State<'_, CoreState>,
) -> Result<(), String> {
    let index = state.index.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        for entry in fs::read_dir(&base).map_err(io_err_to_string)? {
            let entry = entry.map_err(io_err_to_string)?;
            let path = entry.path();
            if path.is_dir() {
                fs::remove_dir_all(path).map_err(io_err_to_string)?;
            } else {
                fs::remove_file(path).map_err(io_err_to_string)?;
            }
        }

        if let Ok(mut idx) = index.write() {
            idx.notes.clear();
            idx.loaded = true;
            idx.bodies_loaded = true;
        }

        Ok(())
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
pub async fn appdata_read(app: AppHandle, rel_path: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        let path = safe_appdata_path(&base, &rel_path)?;
        match fs::read_to_string(path) {
            Ok(content) => Ok(Some(content)),
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(err) => Err(io_err_to_string(err)),
        }
    })
    .await
    .map_err(task_join_err)?
}

#[tauri::command]
pub async fn appdata_write(
    app: AppHandle,
    rel_path: String,
    content: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        let path = safe_appdata_path(&base, &rel_path)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(io_err_to_string)?;
        }
        write_atomic_text(&path, &content)
    })
    .await
    .map_err(task_join_err)?
}

#[tauri::command]
pub async fn appdata_delete(app: AppHandle, rel_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        let path = safe_appdata_path(&base, &rel_path)?;
        let _ = fs::remove_file(path);
        Ok(())
    })
    .await
    .map_err(task_join_err)?
}

#[tauri::command]
pub async fn appdata_list(app: AppHandle, rel_dir: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        let dir = safe_appdata_path(&base, &rel_dir)?;
        if !dir.exists() {
            return Ok(Vec::new());
        }
        let files = fs::read_dir(dir)
            .map_err(io_err_to_string)?
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect::<Vec<_>>();
        Ok(files)
    })
    .await
    .map_err(task_join_err)?
}

#[tauri::command]
pub async fn appdata_read_binary(
    app: AppHandle,
    rel_path: String,
) -> Result<Option<Vec<u8>>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        let path = safe_appdata_path(&base, &rel_path)?;
        match fs::read(path) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(err) => Err(io_err_to_string(err)),
        }
    })
    .await
    .map_err(task_join_err)?
}

#[tauri::command]
pub async fn appdata_write_binary(
    app: AppHandle,
    rel_path: String,
    data: Vec<u8>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        let path = safe_appdata_path(&base, &rel_path)?;
        let parent = path
            .parent()
            .ok_or_else(|| "invalid file path".to_string())?;
        fs::create_dir_all(parent).map_err(io_err_to_string)?;
        fs::write(path, data).map_err(io_err_to_string)
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
    let supersearch_meta_state = state.supersearch_meta.clone();
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
            let mut ss_write = supersearch_meta_state
                .write()
                .map_err(|_| "supersearch meta lock poisoned".to_string())?;
            *ss_write = Some(meta);
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

pub(crate) fn is_image_filename(name: &str) -> bool {
    let dot = match name.rfind('.') {
        Some(i) => i,
        None => return false,
    };
    let ext = &name[dot + 1..];
    if ext.is_empty() {
        return false;
    }
    let lower = ext.to_lowercase();
    ALLOWED_IMAGE_EXTS.contains(&lower.as_str())
}

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
    let watcher_index = state.index.clone();
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
                    if let Ok(mut idx) = watcher_index.write() {
                        idx.loaded = false;
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
pub async fn app_get_config(app: AppHandle) -> Result<AppConfigPayload, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        let cfg = load_app_config(&base);
        let is_custom = load_notes_dir_override(&app).is_some();
        let default_dir = default_notes_root(&app)?;
        Ok(AppConfigPayload {
            notes_dir: base.to_string_lossy().to_string(),
            sidebar_width: cfg.sidebar_width,
            graph_sidebar_width: cfg.graph_sidebar_width,
            is_custom_dir: is_custom,
            default_notes_dir: default_dir.to_string_lossy().to_string(),
        })
    })
    .await
    .map_err(task_join_err)?
}

#[tauri::command]
pub async fn app_save_config(app: AppHandle, updates: AppConfigUpdates) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        let mut cfg = load_app_config(&base);
        if let Some(sidebar_width) = updates.sidebar_width {
            cfg.sidebar_width = sidebar_width;
        }
        if let Some(graph_sidebar_width) = updates.graph_sidebar_width {
            cfg.graph_sidebar_width = graph_sidebar_width;
        }
        save_app_config(&base, &cfg)
    })
    .await
    .map_err(task_join_err)?
}

#[tauri::command]
pub async fn app_set_notes_dir(app: AppHandle, dir: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(ref d) = dir {
            let path = PathBuf::from(d);
            if !path.is_absolute() {
                return Err("path must be absolute".to_string());
            }
            fs::create_dir_all(&path).map_err(io_err_to_string)?;
        }
        save_notes_dir_override(&app, dir.as_deref())
    })
    .await
    .map_err(task_join_err)?
}

#[tauri::command]
pub fn app_get_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
pub fn app_get_platform() -> String {
    std::env::consts::OS.to_string()
}

#[tauri::command]
pub async fn core_rebuild_index(
    app: AppHandle,
    state: State<'_, CoreState>,
) -> Result<Vec<NotePreviewPayload>, String> {
    let index = state.index.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        let scanned = scan_notes(&base)?;
        let mut write = index
            .write()
            .map_err(|_| "search index lock poisoned".to_string())?;
        write.notes = scanned;
        write.loaded = true;
        write.bodies_loaded = false;

        let mut previews: Vec<_> = write.notes.values().map(note_to_preview).collect();
        previews.sort_by(|a, b| {
            b.modification_time
                .cmp(&a.modification_time)
                .then_with(|| a.id.cmp(&b.id))
        });
        Ok(previews)
    })
    .await
    .map_err(task_join_err)?
}

#[tauri::command]
pub async fn core_get_note_list(
    app: AppHandle,
) -> Result<Vec<NotePreviewPayload>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        scan_note_previews(&base)
    })
    .await
    .map_err(task_join_err)?
}

#[tauri::command]
pub async fn core_get_note_previews(
    app: AppHandle,
    state: State<'_, CoreState>,
) -> Result<Vec<NotePreviewPayload>, String> {
    let index = state.index.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        ensure_index_loaded(&base, &index)?;
        let read = index
            .read()
            .map_err(|_| "search index lock poisoned".to_string())?;
        let mut previews: Vec<_> = read.notes.values().map(note_to_preview).collect();
        previews.sort_by(|a, b| {
            b.modification_time
                .cmp(&a.modification_time)
                .then_with(|| a.id.cmp(&b.id))
        });
        Ok(previews)
    })
    .await
    .map_err(task_join_err)?
}

#[tauri::command]
pub async fn core_keyword_search(
    app: AppHandle,
    state: State<'_, CoreState>,
    input: KeywordSearchInput,
) -> Result<Vec<SearchResultPayload>, String> {
    let index = state.index.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        ensure_index_loaded(&base, &index)?;

        // Backfill deferred bodies (cache-hit notes had body skipped at scan time)
        {
            let needs_backfill = index
                .read()
                .map_err(|_| "search index lock poisoned".to_string())?
                .bodies_loaded
                == false;
            if needs_backfill {
                let mut write = index
                    .write()
                    .map_err(|_| "search index lock poisoned".to_string())?;
                if !write.bodies_loaded {
                    backfill_bodies(&base, &mut write.notes);
                    write.bodies_loaded = true;
                }
            }
        }

        let read = index
            .read()
            .map_err(|_| "search index lock poisoned".to_string())?;
        let limit = input.limit.unwrap_or(200).max(1);
        Ok(keyword_search_impl(&read.notes, &input.query, limit))
    })
    .await
    .map_err(task_join_err)?
}

fn list_image_files_impl(base: &Path) -> Result<Vec<ImageFileEntry>, String> {
    let mut entries = Vec::new();
    for entry in fs::read_dir(base).map_err(io_err_to_string)? {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().to_string();
        if !is_image_filename(&name) {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) if m.is_file() => m,
            _ => continue,
        };
        entries.push(ImageFileEntry {
            filename: name,
            size: meta.len(),
            mtime: file_mtime_ms(&meta),
        });
    }
    entries.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    Ok(entries)
}

fn delete_image_file_impl(base: &Path, filename: &str) -> Result<(), String> {
    if !is_image_filename(filename) {
        return Err("not an image filename".to_string());
    }
    if filename.contains("..") || filename.contains('/') || filename.contains('\\') {
        return Err("invalid filename".to_string());
    }
    let path = base.join(filename);
    fs::remove_file(&path).map_err(io_err_to_string)
}

#[tauri::command]
pub async fn core_list_image_files(app: AppHandle) -> Result<Vec<ImageFileEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        list_image_files_impl(&base)
    })
    .await
    .map_err(task_join_err)?
}

#[tauri::command]
pub async fn core_delete_image_file(app: AppHandle, filename: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        delete_image_file_impl(&base, &filename)
    })
    .await
    .map_err(task_join_err)?
}

#[tauri::command]
pub async fn engagement_load(app: AppHandle, state: State<'_, CoreState>) -> Result<(), String> {
    let engagement = state.engagement.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        ensure_engagement_loaded(&base, &engagement)
    })
    .await
    .map_err(task_join_err)?
}

#[tauri::command]
pub async fn engagement_track_open(
    app: AppHandle,
    state: State<'_, CoreState>,
    id: String,
) -> Result<(), String> {
    let engagement = state.engagement.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        ensure_engagement_loaded(&base, &engagement)?;
        let mut write = engagement
            .write()
            .map_err(|_| "engagement lock poisoned".to_string())?;
        let record = write.data.notes.entry(id).or_insert(EngagementRecord {
            last_opened_at: 0,
            open_count: 0,
            last_edited_at: 0,
            edit_count: 0,
        });
        record.open_count += 1;
        record.last_opened_at = now_ms();
        write.dirty = true;
        Ok(())
    })
    .await
    .map_err(task_join_err)?
}

#[tauri::command]
pub async fn engagement_track_edit(
    app: AppHandle,
    state: State<'_, CoreState>,
    id: String,
) -> Result<(), String> {
    let engagement = state.engagement.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        ensure_engagement_loaded(&base, &engagement)?;
        let mut write = engagement
            .write()
            .map_err(|_| "engagement lock poisoned".to_string())?;
        let record = write.data.notes.entry(id).or_insert(EngagementRecord {
            last_opened_at: 0,
            open_count: 0,
            last_edited_at: 0,
            edit_count: 0,
        });
        record.edit_count += 1;
        record.last_edited_at = now_ms();
        write.dirty = true;
        Ok(())
    })
    .await
    .map_err(task_join_err)?
}

#[tauri::command]
pub async fn engagement_remove(
    app: AppHandle,
    state: State<'_, CoreState>,
    id: String,
) -> Result<(), String> {
    let engagement = state.engagement.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        ensure_engagement_loaded(&base, &engagement)?;
        let mut write = engagement
            .write()
            .map_err(|_| "engagement lock poisoned".to_string())?;
        write.data.notes.remove(&id);
        write.dirty = true;
        Ok(())
    })
    .await
    .map_err(task_join_err)?
}

#[tauri::command]
pub async fn engagement_rename(
    app: AppHandle,
    state: State<'_, CoreState>,
    old_id: String,
    new_id: String,
) -> Result<(), String> {
    let engagement = state.engagement.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        ensure_engagement_loaded(&base, &engagement)?;
        let mut write = engagement
            .write()
            .map_err(|_| "engagement lock poisoned".to_string())?;
        if let Some(record) = write.data.notes.remove(&old_id) {
            write.data.notes.insert(new_id, record);
            write.dirty = true;
        }
        Ok(())
    })
    .await
    .map_err(task_join_err)?
}

#[tauri::command]
pub async fn engagement_get_all(
    app: AppHandle,
    state: State<'_, CoreState>,
) -> Result<HashMap<String, EngagementRecord>, String> {
    let engagement = state.engagement.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        ensure_engagement_loaded(&base, &engagement)?;
        let read = engagement
            .read()
            .map_err(|_| "engagement lock poisoned".to_string())?;
        Ok(read.data.notes.clone())
    })
    .await
    .map_err(task_join_err)?
}

#[tauri::command]
pub async fn engagement_flush(app: AppHandle, state: State<'_, CoreState>) -> Result<(), String> {
    let engagement = state.engagement.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        let mut write = engagement
            .write()
            .map_err(|_| "engagement lock poisoned".to_string())?;
        if !write.dirty {
            return Ok(());
        }
        let json = serde_json::to_string_pretty(&write.data).map_err(|e| e.to_string())?;
        write_atomic_text(&base.join(".engagement-v1.json"), &json)?;
        write.dirty = false;
        Ok(())
    })
    .await
    .map_err(task_join_err)?
}

#[tauri::command]
pub async fn supersearch_is_ready(
    app: AppHandle,
    state: State<'_, CoreState>,
) -> Result<bool, String> {
    let ss_meta = state.supersearch_meta.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;

        // Ensure meta is cached
        {
            let read = ss_meta
                .read()
                .map_err(|_| "supersearch meta lock poisoned".to_string())?;
            if read.is_none() {
                drop(read);
                let loaded = load_supersearch_meta(&base);
                let mut write = ss_meta
                    .write()
                    .map_err(|_| "supersearch meta lock poisoned".to_string())?;
                if write.is_none() {
                    *write = loaded;
                }
            }
        }

        let read = ss_meta
            .read()
            .map_err(|_| "supersearch meta lock poisoned".to_string())?;
        if read.is_none() {
            return Ok(false);
        }

        let manifest = base.join(".supersearch-manifest.json");
        let vectors = base.join(".supersearch-vectors.bin");
        Ok(manifest.exists() && vectors.exists())
    })
    .await
    .map_err(task_join_err)?
}

#[tauri::command]
pub async fn supersearch_get_state(
    app: AppHandle,
    state: State<'_, CoreState>,
) -> Result<Option<SupersearchMeta>, String> {
    let ss_meta = state.supersearch_meta.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;

        {
            let read = ss_meta
                .read()
                .map_err(|_| "supersearch meta lock poisoned".to_string())?;
            if read.is_some() {
                return Ok(read.clone());
            }
        }

        let loaded = load_supersearch_meta(&base);
        let mut write = ss_meta
            .write()
            .map_err(|_| "supersearch meta lock poisoned".to_string())?;
        if write.is_none() {
            *write = loaded;
        }
        Ok(write.clone())
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
    fn keyword_search_ranks_title_higher() {
        let mut notes = HashMap::new();
        notes.insert(
            "banana-recipe".to_string(),
            build_indexed_note(
                "banana-recipe".to_string(),
                "Banana bread and banana muffins".to_string(),
                1,
            ),
        );
        notes.insert(
            "grocery-list".to_string(),
            build_indexed_note(
                "grocery-list".to_string(),
                "milk eggs banana".to_string(),
                now_ms(),
            ),
        );

        let results = keyword_search_impl(&notes, "banana", 10);
        assert!(!results.is_empty());
        assert_eq!(results[0].note.id, "banana-recipe");
    }

    #[test]
    fn highlighted_segments_merge_overlaps() {
        let segments =
            build_highlighted_segments("xfoobarx", &["foo".to_string(), "foob".to_string()]);
        let highlighted = segments.iter().filter(|s| s.highlight).collect::<Vec<_>>();
        assert_eq!(highlighted.len(), 1);
        assert_eq!(highlighted[0].text, "foob");
    }

    #[test]
    fn snippet_generation_handles_unicode_boundaries() {
        let note = build_indexed_note(
            "unicode-note".to_string(),
            "Pick a “Major” for your semester — don’t bounce around.".to_string(),
            now_ms(),
        );
        let snippet = snippet_for_note(&note, &["major".to_string()]);
        assert!(!snippet.is_empty());
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

    #[test]
    fn note_id_from_filename_returns_none_for_empty_id() {
        // ".md" has no name before the extension — should be filtered out
        assert_eq!(note_id_from_filename(".md"), None);
    }

    #[test]
    fn note_id_from_filename_returns_some_for_valid() {
        assert_eq!(note_id_from_filename("hello.md"), Some("hello".to_string()));
        assert_eq!(
            note_id_from_filename("my note.md"),
            Some("my note".to_string())
        );
    }

    #[test]
    fn note_id_from_filename_returns_none_for_non_md() {
        assert_eq!(note_id_from_filename("hello.txt"), None);
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

    // ── Image sync tests ──────────────────────────────────────

    #[test]
    fn is_image_filename_valid() {
        assert!(is_image_filename("photo.jpg"));
        assert!(is_image_filename("photo.JPEG"));
        assert!(is_image_filename("1234-abc.png"));
        assert!(is_image_filename("test.gif"));
        assert!(is_image_filename("test.webp"));
        assert!(is_image_filename("test.svg"));
        assert!(is_image_filename("test.bmp"));
        assert!(is_image_filename("test.ico"));
        assert!(is_image_filename("test.avif"));
        assert!(is_image_filename("test.heic"));
    }

    #[test]
    fn is_image_filename_invalid() {
        assert!(!is_image_filename("note.md"));
        assert!(!is_image_filename("file.txt"));
        assert!(!is_image_filename("no_extension"));
        assert!(!is_image_filename(".hidden"));
        assert!(!is_image_filename("script.exe"));
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

    // ── Image gallery (list / delete) tests ──────────────────────────

    #[test]
    fn list_image_files_returns_images_only() {
        let base = temp_notes_dir();
        fs::write(base.join("photo.jpg"), b"jpeg").unwrap();
        fs::write(base.join("diagram.png"), b"png").unwrap();
        write_atomic_text(&base.join("note.md"), "# Hello").unwrap();
        fs::write(base.join("readme.txt"), b"text").unwrap();

        let entries = list_image_files_impl(&base).unwrap();
        assert_eq!(entries.len(), 2);
        let names: Vec<&str> = entries.iter().map(|e| e.filename.as_str()).collect();
        assert!(names.contains(&"photo.jpg"));
        assert!(names.contains(&"diagram.png"));
        assert!(!names
            .iter()
            .any(|n| n.ends_with(".md") || n.ends_with(".txt")));

        cleanup_temp_dir(&base);
    }

    #[test]
    fn delete_image_file_removes_file() {
        let base = temp_notes_dir();
        fs::write(base.join("to-delete.png"), b"png data").unwrap();
        assert!(base.join("to-delete.png").exists());

        delete_image_file_impl(&base, "to-delete.png").unwrap();
        assert!(!base.join("to-delete.png").exists());

        cleanup_temp_dir(&base);
    }

    #[test]
    fn delete_image_file_rejects_non_image() {
        let base = temp_notes_dir();
        write_atomic_text(&base.join("note.md"), "# Keep me").unwrap();

        let result = delete_image_file_impl(&base, "note.md");
        assert!(result.is_err());
        assert!(base.join("note.md").exists());

        cleanup_temp_dir(&base);
    }

    #[test]
    fn delete_image_file_rejects_traversal() {
        let base = temp_notes_dir();
        assert!(delete_image_file_impl(&base, "../etc/passwd.png").is_err());
        assert!(delete_image_file_impl(&base, "sub/image.jpg").is_err());
        assert!(delete_image_file_impl(&base, "..\\evil.png").is_err());

        cleanup_temp_dir(&base);
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

    // ── Note preview cache tests ─────────────────────────────────────

    #[test]
    fn note_cache_round_trips_to_disk() {
        let base = temp_notes_dir();
        let mut entries = HashMap::new();
        entries.insert(
            "hello".to_string(),
            CachedNoteMeta {
                mtime: 1000,
                preview: "Hello world".to_string(),
                tags: vec!["#test".to_string()],
                headings_lower: "heading one".to_string(),
            },
        );
        let cache = NoteMetadataCache {
            version: 1,
            entries,
        };

        save_note_cache(&base, &cache);
        let loaded = load_note_cache(&base);

        assert_eq!(loaded.version, 1);
        assert_eq!(loaded.entries.len(), 1);
        let entry = loaded.entries.get("hello").unwrap();
        assert_eq!(entry.mtime, 1000);
        assert_eq!(entry.preview, "Hello world");
        assert_eq!(entry.tags, vec!["#test"]);
        assert_eq!(entry.headings_lower, "heading one");

        cleanup_temp_dir(&base);
    }

    #[test]
    fn note_cache_returns_default_when_missing() {
        let base = temp_notes_dir();
        let cache = load_note_cache(&base);
        assert_eq!(cache.version, 0); // Default
        assert!(cache.entries.is_empty());
        cleanup_temp_dir(&base);
    }

    #[test]
    fn note_cache_returns_default_on_corrupt_json() {
        let base = temp_notes_dir();
        fs::write(base.join(NOTE_PREVIEW_CACHE_FILE), "not json{{{").unwrap();
        let cache = load_note_cache(&base);
        assert!(cache.entries.is_empty());
        cleanup_temp_dir(&base);
    }

    #[test]
    fn note_cache_rejects_wrong_version() {
        let base = temp_notes_dir();
        let json = r#"{"version":99,"entries":{"a":{"mtime":1,"preview":"p","tags":[],"headings_lower":""}}}"#;
        fs::write(base.join(NOTE_PREVIEW_CACHE_FILE), json).unwrap();
        let cache = load_note_cache(&base);
        assert!(cache.entries.is_empty());
        cleanup_temp_dir(&base);
    }

    #[test]
    fn scan_notes_creates_cache_file() {
        let base = temp_notes_dir();
        fs::write(base.join("alpha.md"), "# Alpha\nBody text #tag1").unwrap();
        fs::write(base.join("beta.md"), "Beta content").unwrap();

        let result = scan_notes(&base).unwrap();
        assert_eq!(result.len(), 2);

        // Cache file should now exist
        let cache = load_note_cache(&base);
        assert_eq!(cache.version, 1);
        assert_eq!(cache.entries.len(), 2);
        assert!(cache.entries.contains_key("alpha"));
        assert!(cache.entries.contains_key("beta"));

        // Verify cached content matches indexed content
        let alpha_cached = cache.entries.get("alpha").unwrap();
        let alpha_indexed = result.get("alpha").unwrap();
        assert_eq!(alpha_cached.preview, alpha_indexed.preview);
        assert_eq!(alpha_cached.tags, alpha_indexed.tags);
        assert_eq!(alpha_cached.mtime, alpha_indexed.mtime);
        assert_eq!(alpha_cached.headings_lower, alpha_indexed.headings_lower);

        cleanup_temp_dir(&base);
    }

    #[test]
    fn scan_notes_uses_cache_for_unchanged_files() {
        let base = temp_notes_dir();
        fs::write(base.join("note.md"), "# Heading\n\nSome content #mytag").unwrap();

        // First scan populates the cache
        let first = scan_notes(&base).unwrap();
        let first_note = first.get("note").unwrap();
        assert_eq!(first_note.tags, vec!["#mytag"]);

        // Second scan should use cache (mtime unchanged) and produce identical results
        let second = scan_notes(&base).unwrap();
        let second_note = second.get("note").unwrap();
        assert_eq!(first_note.preview, second_note.preview);
        assert_eq!(first_note.tags, second_note.tags);
        assert_eq!(first_note.headings_lower, second_note.headings_lower);
        assert_eq!(first_note.mtime, second_note.mtime);

        cleanup_temp_dir(&base);
    }

    #[test]
    fn scan_notes_defers_body_for_cache_hits() {
        let base = temp_notes_dir();
        fs::write(base.join("note.md"), "# Heading\n\nBody text here").unwrap();

        // First scan reads the full body
        let first = scan_notes(&base).unwrap();
        assert_eq!(first.get("note").unwrap().body, "# Heading\n\nBody text here");

        // Second scan (cache hit) defers body
        let second = scan_notes(&base).unwrap();
        let deferred = second.get("note").unwrap();
        assert!(deferred.body.is_empty(), "cache-hit body should be empty");
        assert!(
            deferred.body_lower.is_empty(),
            "cache-hit body_lower should be empty"
        );
        // But preview/tags/headings are still correct
        assert_eq!(deferred.preview, first.get("note").unwrap().preview);
        assert_eq!(deferred.headings_lower, "heading");

        cleanup_temp_dir(&base);
    }

    #[test]
    fn backfill_bodies_loads_deferred_notes() {
        let base = temp_notes_dir();
        fs::write(base.join("alpha.md"), "Alpha body").unwrap();
        fs::write(base.join("beta.md"), "Beta body").unwrap();

        // First scan populates cache, second scan defers bodies
        scan_notes(&base).unwrap();
        let mut notes = scan_notes(&base).unwrap();

        assert!(notes.get("alpha").unwrap().body.is_empty());
        assert!(notes.get("beta").unwrap().body.is_empty());

        backfill_bodies(&base, &mut notes);

        assert_eq!(notes.get("alpha").unwrap().body, "Alpha body");
        assert_eq!(notes.get("alpha").unwrap().body_lower, "alpha body");
        assert_eq!(notes.get("beta").unwrap().body, "Beta body");
        assert_eq!(notes.get("beta").unwrap().body_lower, "beta body");
    }

    #[test]
    fn scan_notes_invalidates_cache_on_mtime_change() {
        let base = temp_notes_dir();
        fs::write(base.join("note.md"), "Original").unwrap();

        // First scan
        scan_notes(&base).unwrap();
        let cache_before = load_note_cache(&base);
        let original_preview = cache_before.entries.get("note").unwrap().preview.clone();

        // Modify the file (changes mtime)
        std::thread::sleep(std::time::Duration::from_millis(50));
        fs::write(base.join("note.md"), "Updated content here").unwrap();

        // Second scan should detect mtime change and re-extract
        let result = scan_notes(&base).unwrap();
        let note = result.get("note").unwrap();
        assert_ne!(note.preview, original_preview);
        assert_eq!(note.preview, "Updated content here");

        // Cache should be updated
        let cache_after = load_note_cache(&base);
        assert_eq!(
            cache_after.entries.get("note").unwrap().preview,
            "Updated content here"
        );

        cleanup_temp_dir(&base);
    }

    #[test]
    fn scan_notes_removes_deleted_files_from_cache() {
        let base = temp_notes_dir();
        fs::write(base.join("keep.md"), "keep").unwrap();
        fs::write(base.join("remove.md"), "remove").unwrap();

        scan_notes(&base).unwrap();
        let cache = load_note_cache(&base);
        assert_eq!(cache.entries.len(), 2);

        // Delete one file
        fs::remove_file(base.join("remove.md")).unwrap();

        scan_notes(&base).unwrap();
        let cache = load_note_cache(&base);
        assert_eq!(cache.entries.len(), 1);
        assert!(cache.entries.contains_key("keep"));
        assert!(!cache.entries.contains_key("remove"));

        cleanup_temp_dir(&base);
    }

    #[test]
    fn scan_notes_adds_new_file_to_existing_cache() {
        let base = temp_notes_dir();
        fs::write(base.join("existing.md"), "# Existing\nBody #old").unwrap();

        // First scan: cache has one entry
        scan_notes(&base).unwrap();
        let cache = load_note_cache(&base);
        assert_eq!(cache.entries.len(), 1);
        assert!(cache.entries.contains_key("existing"));

        // Add a new file
        fs::write(base.join("newcomer.md"), "# New Note\nFresh content #new").unwrap();

        // Second scan: cache grows to two entries
        let result = scan_notes(&base).unwrap();
        let cache = load_note_cache(&base);
        assert_eq!(cache.entries.len(), 2);
        assert!(cache.entries.contains_key("existing"));
        assert!(cache.entries.contains_key("newcomer"));

        // New entry has correct metadata
        let newcomer = cache.entries.get("newcomer").unwrap();
        assert_eq!(newcomer.tags, vec!["#new"]);
        assert!(newcomer.headings_lower.contains("new note"));

        // Existing entry is still served from cache (body deferred)
        let existing = result.get("existing").unwrap();
        assert!(existing.body.is_empty(), "unchanged note should have deferred body");

        // New entry has its body populated (was read fresh)
        let newcomer_note = result.get("newcomer").unwrap();
        assert_eq!(newcomer_note.body, "# New Note\nFresh content #new");

        cleanup_temp_dir(&base);
    }

    #[test]
    fn scan_notes_re_extracts_tags_and_headings_on_change() {
        let base = temp_notes_dir();
        fs::write(base.join("note.md"), "# Old Heading\nText #oldtag").unwrap();

        scan_notes(&base).unwrap();
        let cache = load_note_cache(&base);
        let entry = cache.entries.get("note").unwrap();
        assert_eq!(entry.tags, vec!["#oldtag"]);
        assert!(entry.headings_lower.contains("old heading"));

        // Modify file with new tags and headings
        std::thread::sleep(std::time::Duration::from_millis(50));
        fs::write(base.join("note.md"), "# New Heading\nDifferent #newtag #extra").unwrap();

        let result = scan_notes(&base).unwrap();
        let note = result.get("note").unwrap();
        assert_eq!(note.tags, vec!["#newtag", "#extra"]);
        assert!(note.headings_lower.contains("new heading"));
        assert!(!note.headings_lower.contains("old heading"));

        // Cache is updated with new metadata
        let cache = load_note_cache(&base);
        let entry = cache.entries.get("note").unwrap();
        assert_eq!(entry.tags, vec!["#newtag", "#extra"]);
        assert!(entry.headings_lower.contains("new heading"));

        cleanup_temp_dir(&base);
    }

    #[test]
    fn scan_notes_handles_mixed_add_delete_unchanged() {
        let base = temp_notes_dir();
        fs::write(base.join("stable.md"), "Stable content").unwrap();
        fs::write(base.join("doomed.md"), "Will be deleted").unwrap();
        fs::write(base.join("mutable.md"), "# Before\nOld body #v1").unwrap();

        scan_notes(&base).unwrap();
        let cache = load_note_cache(&base);
        assert_eq!(cache.entries.len(), 3);

        // Simultaneous changes: delete one, modify one, add one
        fs::remove_file(base.join("doomed.md")).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(50));
        fs::write(base.join("mutable.md"), "# After\nNew body #v2").unwrap();
        fs::write(base.join("fresh.md"), "Brand new").unwrap();

        let result = scan_notes(&base).unwrap();
        assert_eq!(result.len(), 3); // stable + mutable + fresh

        // Stable: cache hit, body deferred
        let stable = result.get("stable").unwrap();
        assert!(stable.body.is_empty(), "unchanged note body should be deferred");
        assert_eq!(stable.preview, "Stable content");

        // Mutable: cache miss, full re-read
        let mutable = result.get("mutable").unwrap();
        assert_eq!(mutable.body, "# After\nNew body #v2");
        assert_eq!(mutable.tags, vec!["#v2"]);
        assert!(mutable.headings_lower.contains("after"));

        // Fresh: new entry, full read
        let fresh = result.get("fresh").unwrap();
        assert_eq!(fresh.body, "Brand new");

        // Doomed: evicted from cache
        let cache = load_note_cache(&base);
        assert_eq!(cache.entries.len(), 3);
        assert!(!cache.entries.contains_key("doomed"));
        assert!(cache.entries.contains_key("stable"));
        assert!(cache.entries.contains_key("mutable"));
        assert!(cache.entries.contains_key("fresh"));

        cleanup_temp_dir(&base);
    }

    #[test]
    fn scan_notes_cold_cache_reads_all_bodies() {
        let base = temp_notes_dir();
        fs::write(base.join("one.md"), "Body one").unwrap();
        fs::write(base.join("two.md"), "Body two").unwrap();

        // Delete any existing cache to ensure cold start
        let _ = fs::remove_file(base.join(NOTE_PREVIEW_CACHE_FILE));

        let result = scan_notes(&base).unwrap();

        // With no cache, every note body must be fully read
        assert_eq!(result.get("one").unwrap().body, "Body one");
        assert_eq!(result.get("two").unwrap().body, "Body two");

        // Cache is now populated for next run
        let cache = load_note_cache(&base);
        assert_eq!(cache.entries.len(), 2);

        cleanup_temp_dir(&base);
    }

    #[test]
    fn backfill_after_mixed_cache_hits_and_misses() {
        let base = temp_notes_dir();
        fs::write(base.join("cached.md"), "Cached body text").unwrap();
        fs::write(base.join("changed.md"), "Original").unwrap();

        // First scan populates cache
        scan_notes(&base).unwrap();

        // Modify one file
        std::thread::sleep(std::time::Duration::from_millis(50));
        fs::write(base.join("changed.md"), "Modified body text").unwrap();

        // Second scan: cached.md is a cache hit (empty body), changed.md is fresh
        let mut result = scan_notes(&base).unwrap();
        assert!(result.get("cached").unwrap().body.is_empty());
        assert_eq!(result.get("changed").unwrap().body, "Modified body text");

        // Backfill loads the deferred body
        backfill_bodies(&base, &mut result);
        assert_eq!(result.get("cached").unwrap().body, "Cached body text");
        assert_eq!(result.get("cached").unwrap().body_lower, "cached body text");
        // Already-loaded body is preserved
        assert_eq!(result.get("changed").unwrap().body, "Modified body text");

        cleanup_temp_dir(&base);
    }

    // ── scan_note_previews tests ──────────────────────────────────────

    #[test]
    fn scan_note_previews_returns_sorted_previews() {
        let base = temp_notes_dir();
        fs::write(base.join("alpha.md"), "# Alpha\nBody #tag1").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(50));
        fs::write(base.join("beta.md"), "Beta content").unwrap();

        let previews = scan_note_previews(&base).unwrap();
        assert_eq!(previews.len(), 2);
        // Most-recent first
        assert_eq!(previews[0].id, "beta");
        assert_eq!(previews[1].id, "alpha");
        assert_eq!(previews[1].tags, vec!["#tag1"]);

        cleanup_temp_dir(&base);
    }

    #[test]
    fn scan_note_previews_uses_cache_without_reading_files() {
        let base = temp_notes_dir();
        fs::write(base.join("note.md"), "# Heading\nContent #cached").unwrap();

        // First call populates the cache
        let first = scan_note_previews(&base).unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].tags, vec!["#cached"]);

        // Overwrite file content but preserve mtime by restoring the same bytes
        // (the cache should still serve stale preview since mtime is unchanged)
        let mtime_before = fs::metadata(base.join("note.md")).unwrap();
        let mtime_ms = file_mtime_ms(&mtime_before);

        // Second call should produce identical results from cache
        let second = scan_note_previews(&base).unwrap();
        assert_eq!(second[0].preview, first[0].preview);
        assert_eq!(second[0].tags, first[0].tags);
        assert_eq!(second[0].modification_time, mtime_ms);

        cleanup_temp_dir(&base);
    }

    #[test]
    fn scan_note_previews_detects_cache_miss_on_mtime_change() {
        let base = temp_notes_dir();
        fs::write(base.join("note.md"), "Original").unwrap();

        let first = scan_note_previews(&base).unwrap();
        assert_eq!(first[0].preview, "Original");

        std::thread::sleep(std::time::Duration::from_millis(50));
        fs::write(base.join("note.md"), "Updated").unwrap();

        let second = scan_note_previews(&base).unwrap();
        assert_eq!(second[0].preview, "Updated");

        cleanup_temp_dir(&base);
    }

    #[test]
    fn scan_note_previews_removes_deleted_files_from_cache() {
        let base = temp_notes_dir();
        fs::write(base.join("keep.md"), "keep").unwrap();
        fs::write(base.join("gone.md"), "gone").unwrap();

        scan_note_previews(&base).unwrap();
        let cache = load_note_cache(&base);
        assert_eq!(cache.entries.len(), 2);

        fs::remove_file(base.join("gone.md")).unwrap();

        let previews = scan_note_previews(&base).unwrap();
        assert_eq!(previews.len(), 1);
        assert_eq!(previews[0].id, "keep");

        let cache = load_note_cache(&base);
        assert_eq!(cache.entries.len(), 1);
        assert!(cache.entries.contains_key("keep"));

        cleanup_temp_dir(&base);
    }

    #[test]
    fn scan_note_previews_does_not_populate_search_index() {
        // Verify that scan_note_previews is independent of SearchIndexState
        let base = temp_notes_dir();
        fs::write(base.join("test.md"), "body text").unwrap();

        let previews = scan_note_previews(&base).unwrap();
        assert_eq!(previews.len(), 1);

        // The function should not require or touch SearchIndexState —
        // it's a pure function of (base dir, cache file).
        // This test just confirms it runs without any index state.

        cleanup_temp_dir(&base);
    }
}
