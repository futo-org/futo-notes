//! Long-lived indexer task and query handle.
//!
//! At boot:
//!   1. Open both Tantivy indices (`TantivyIndices::open`).
//!   2. Walk notes root; collect (path, mtime).
//!   3. Reconcile BM25 fast (in one tokio task) and emit `keyword.ready = true`.
//!   4. Drive SPLADE backfill in 8-note batches with progress events.
//!
//! Steady state: consume `IndexerMsg` from the channel.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use tantivy::collector::Collector;
#[cfg(feature = "semantic")]
use tantivy::collector::TopDocs;
use tokenizers::Tokenizer;
use tokio::sync::mpsc::UnboundedReceiver;
use walkdir::WalkDir;

#[cfg(feature = "semantic")]
use futo_notes_core::search::{build_embedding_text, chunk_content_with_target};
#[cfg(feature = "semantic")]
use futo_notes_inference::{tokenize_only_query, SpladeDocEncoder, SpladeSparseVec};

#[cfg(feature = "semantic")]
use crate::splade_scorer::{dedupe_by_note, WeightedSpladeQuery};
use crate::tantivy_indices::TantivyIndices;
use crate::{
    KeywordStatus, SearchHit, SearchStatus, SpladeModelVariant, StatusObserver,
    DEFAULT_PER_INDEX_TOPK,
};

// Silence unused-trait warning: Collector trait import is required for
// `Searcher::search` to recognize `TopDocs` as a Collector.
#[allow(dead_code)]
fn _collector_in_scope<C: Collector>() {}

/// Shared indexer context: the status observer plus the SPLADE model config and
/// a per-engine encoder cache. The Tauri layer used to pass an `AppHandle`
/// around for exactly these three things (status emit, model/tokenizer paths,
/// process-wide encoder cell); the agnostic engine bundles them here instead.
///
/// `Clone` is cheap (every field is `Arc`/`Copy`/`Option`), so it moves freely
/// into `spawn_blocking` closures.
#[derive(Clone)]
pub(crate) struct Ctx {
    /// Invoked with a status snapshot whenever the indexer makes progress. The
    /// host (Tauri → `app.emit`; FFI → a callback interface) decides where it
    /// goes.
    on_status: StatusObserver,
    /// Resolved SPLADE model path, or `None` for BM25-only (no encoder load).
    /// Only read by the semantic encoder path; carried (but unused) in a
    /// keyword-only build so `Ctx::new`'s signature is feature-independent.
    #[cfg_attr(not(feature = "semantic"), allow(dead_code))]
    model_path: Option<PathBuf>,
    /// Resolved SPLADE WordPiece `tokenizer.json` path, or `None`.
    #[cfg_attr(not(feature = "semantic"), allow(dead_code))]
    tokenizer_path: Option<PathBuf>,
    /// Which model file we resolved — drives env knobs + chunker target.
    #[cfg_attr(not(feature = "semantic"), allow(dead_code))]
    variant: SpladeModelVariant,
    /// Loaded encoder, cached for the lifetime of the engine instance. Replaces
    /// the Tauri version's process-wide `OnceLock`.
    #[cfg(feature = "semantic")]
    encoder: Arc<OnceLock<Arc<Mutex<SpladeDocEncoder>>>>,
}

impl Ctx {
    pub(crate) fn new(
        on_status: StatusObserver,
        model_path: Option<PathBuf>,
        tokenizer_path: Option<PathBuf>,
        variant: SpladeModelVariant,
    ) -> Self {
        Self {
            on_status,
            model_path,
            tokenizer_path,
            variant,
            #[cfg(feature = "semantic")]
            encoder: Arc::new(OnceLock::new()),
        }
    }

    fn emit_status(&self, status: &SearchStatus) {
        (self.on_status)(status);
    }
}

/// Lightweight diagnostic trace. The Tauri version wrote these to
/// `/tmp/futo-splade-trace.log` (and to stderr on Android) for offline
/// debugging; the agnostic engine routes the same call sites through `tracing`
/// and lets the host app decide where the output lands.
fn splade_trace<S: AsRef<[u8]>>(msg: S) {
    let s = String::from_utf8_lossy(msg.as_ref());
    tracing::trace!(target: "futo_notes_search", "{}", s.trim_end());
}

#[cfg(feature = "semantic")]
pub const SPLADE_TARGET_TOKENS: usize = 400;
/// Notes per encode_batch call. 16 matches the splade_bench default and
/// gives ORT enough work to amortize session-call overhead.
#[cfg(feature = "semantic")]
const SPLADE_BATCH_SIZE: usize = 16;
/// Inter-batch yield. Small enough not to noticeably slow the backfill,
/// large enough to give the OS scheduler a chance to switch context.
#[cfg(feature = "semantic")]
const INTER_BATCH_YIELD: Duration = Duration::from_millis(5);

/// On-disk sidecar that tracks the last successfully-encoded mtime per note.
/// Sibling to the Tantivy index dirs in `<app_data_dir>/search/`. Used to
/// skip re-encoding notes whose file mtime hasn't moved past what's already
/// in the index — without this, every app launch re-runs the SPLADE encoder
/// over the entire corpus.
const PROGRESS_FILE: &str = "splade-progress.json";
const PROGRESS_VERSION: u32 = 1;

#[derive(Debug, Default, Serialize, Deserialize)]
struct ProgressFile {
    version: u32,
    #[serde(default)]
    mtimes: HashMap<String, i64>,
}

#[derive(Default)]
struct Progress {
    map: HashMap<String, i64>,
    path: PathBuf,
    dirty: bool,
}

impl Progress {
    fn load(index_root: &Path) -> Self {
        let path = index_root.join(PROGRESS_FILE);
        let map = match fs::read_to_string(&path) {
            Ok(raw) => match serde_json::from_str::<ProgressFile>(&raw) {
                Ok(f) if f.version == PROGRESS_VERSION => f.mtimes,
                _ => HashMap::new(),
            },
            Err(_) => HashMap::new(),
        };
        Self {
            map,
            path,
            dirty: false,
        }
    }

    // Only the semantic backfill consults/records encode progress; keyword
    // builds keep the sidecar (forget/save on deletes) but never gate on it.
    #[cfg(feature = "semantic")]
    fn should_skip(&self, note_id: &str, file_mtime_ms: i64) -> bool {
        match self.map.get(note_id) {
            Some(stored) => *stored >= file_mtime_ms && file_mtime_ms > 0,
            None => false,
        }
    }

    #[cfg(feature = "semantic")]
    fn record(&mut self, note_id: String, mtime_ms: i64) {
        self.map.insert(note_id, mtime_ms);
        self.dirty = true;
    }

    fn forget(&mut self, note_id: &str) {
        if self.map.remove(note_id).is_some() {
            self.dirty = true;
        }
    }

    fn save(&mut self) {
        if !self.dirty {
            return;
        }
        let f = ProgressFile {
            version: PROGRESS_VERSION,
            mtimes: self.map.clone(),
        };
        let Ok(json) = serde_json::to_string(&f) else {
            return;
        };
        // Write via a tmp + rename so a crash mid-write can't truncate the
        // sidecar to garbage. If write fails the next launch just re-encodes;
        // not fatal.
        let tmp = self.path.with_extension("json.tmp");
        if fs::write(&tmp, json).is_ok() {
            let _ = fs::rename(&tmp, &self.path);
            self.dirty = false;
        }
    }
}

#[derive(Debug)]
pub enum IndexerMsg {
    /// A note was added or modified at this relative path (under notes_root).
    Changed(String),
    /// A note at this relative path was removed.
    Removed(String),
    /// Atomic rename.
    Renamed { from: String, to: String },
    /// Force a full corpus rescan.
    Rescan,
}

/// Read-side handle returned to the engine's query surface. Cloneable;
/// queries don't need the writer lock.
#[derive(Clone)]
pub struct IndexerHandle {
    indices: Arc<Mutex<TantivyIndices>>,
    /// Read by the hybrid query path to check `splade.ready`; carried (but
    /// unread) in a keyword-only build.
    #[cfg_attr(not(feature = "semantic"), allow(dead_code))]
    status: Arc<Mutex<SearchStatus>>,
    /// Query-time WordPiece tokenizer path (the inference-free query encoder).
    /// `None` when no SPLADE tokenizer was configured. Only read by the
    /// semantic hybrid-query path.
    #[cfg_attr(not(feature = "semantic"), allow(dead_code))]
    tokenizer_path: Option<PathBuf>,
    /// Lazily-loaded tokenizer, cached per handle (was a process-wide static in
    /// the Tauri version). Loaded on first hybrid query.
    #[cfg_attr(not(feature = "semantic"), allow(dead_code))]
    tokenizer_cell: Arc<OnceLock<Option<Arc<Tokenizer>>>>,
}

impl IndexerHandle {
    /// Load + cache the query tokenizer. Returns `None` if no path was
    /// configured or the file failed to parse (the query then degrades to BM25).
    #[cfg(feature = "semantic")]
    fn query_tokenizer(&self) -> Option<Arc<Tokenizer>> {
        self.tokenizer_cell
            .get_or_init(|| {
                let path = self.tokenizer_path.clone()?;
                match Tokenizer::from_file(&path) {
                    Ok(t) => Some(Arc::new(t)),
                    Err(e) => {
                        eprintln!("[search] tokenizer load failed: {e}");
                        None
                    }
                }
            })
            .clone()
    }

    pub fn query(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>, String> {
        let trimmed = query.trim();
        if trimmed.is_empty() {
            return Ok(vec![]);
        }
        let indices = self.indices.lock().map_err(|_| "index mutex poisoned".to_string())?;

        let bm25 = indices.search_bm25(trimmed, DEFAULT_PER_INDEX_TOPK)?;

        // Hybrid path: SPLADE backfill ready AND the query tokenizer loads
        // (lazily; cached per handle so we don't reload tokenizer.json on
        // every search). Compiled out entirely in a keyword-only build — the
        // engine then always serves the BM25 fallthrough below.
        #[cfg(feature = "semantic")]
        {
            let status = self
                .status
                .lock()
                .map(|s| s.clone())
                .unwrap_or_default();
            if status.splade.ready {
                if let Some(tokenizer) = self.query_tokenizer() {
                    let splade =
                        search_splade(&indices, &tokenizer, trimmed, DEFAULT_PER_INDEX_TOPK)?;
                    // rrf_fuse takes (String, f64); upgrade the f32 scores at
                    // the boundary.
                    let bm25_64: Vec<(String, f64)> =
                        bm25.iter().map(|(s, v)| (s.clone(), *v as f64)).collect();
                    let splade_64: Vec<(String, f64)> =
                        splade.iter().map(|(s, v)| (s.clone(), *v as f64)).collect();
                    let fused = futo_notes_core::search::rrf_fuse(&bm25_64, &splade_64, None);
                    let mut out = Vec::with_capacity(fused.len().min(limit));
                    for (id, score) in fused.into_iter().take(limit) {
                        out.push(SearchHit {
                            note_id: id,
                            score: score as f32,
                            source: "hybrid".to_string(),
                        });
                    }
                    return Ok(out);
                }
                // Tokenizer unavailable; degrade to BM25 silently.
            }
        }

        let mut out = Vec::with_capacity(bm25.len().min(limit));
        for (id, score) in bm25.into_iter().take(limit) {
            out.push(SearchHit {
                note_id: id,
                score,
                source: "bm25".to_string(),
            });
        }
        Ok(out)
    }
}

#[cfg(feature = "semantic")]
fn search_splade(
    indices: &TantivyIndices,
    tokenizer: &Tokenizer,
    query: &str,
    k: usize,
) -> Result<Vec<(String, f32)>, String> {
    let sparse = tokenize_only_query(tokenizer, query)
        .map_err(|e| format!("tokenize_only_query: {e}"))?;
    if sparse.indices.is_empty() {
        return Ok(vec![]);
    }
    let pairs: Vec<(u32, f32)> = sparse
        .indices
        .into_iter()
        .zip(sparse.values.into_iter())
        .collect();
    let q = WeightedSpladeQuery::new(indices.splade_schema.terms, pairs);
    let searcher = indices.splade_reader.searcher();
    let top = searcher
        .search(&q, &TopDocs::with_limit(k * 4).order_by_score())
        .map_err(|e| format!("splade search: {e}"))?;
    let mut hits: Vec<(String, f32)> = Vec::with_capacity(top.len());
    for (score, addr) in top {
        if let Some(id) = crate::splade_scorer::doc_note_id(
            &searcher,
            indices.splade_schema.note_id,
            addr,
        ) {
            hits.push((id, score));
        }
    }
    Ok(dedupe_by_note(hits).into_iter().take(k).collect())
}

/// Spawn the indexer task. Returns the read-side handle.
///
/// Must be called from within a tokio runtime (the engine enters its owned
/// runtime before calling this). `ctx` carries the status callback + SPLADE
/// model config; path resolution happened in the host layer.
pub(crate) fn spawn(
    ctx: Ctx,
    notes_root: PathBuf,
    index_root: PathBuf,
    rx: UnboundedReceiver<IndexerMsg>,
    status: Arc<Mutex<SearchStatus>>,
) -> Result<IndexerHandle, String> {
    let _ = splade_trace(b"indexer::spawn ENTER\n");
    let indices = TantivyIndices::open(&index_root)?;
    let _ = splade_trace(b"indexer::spawn: TantivyIndices::open OK\n");
    let indices = Arc::new(Mutex::new(indices));
    let progress = Arc::new(Mutex::new(Progress::load(&index_root)));
    let handle = IndexerHandle {
        indices: indices.clone(),
        status: status.clone(),
        // Cache the tokenizer.json path for query-time use. Loading is
        // deferred to first hybrid query.
        tokenizer_path: ctx.tokenizer_path.clone(),
        tokenizer_cell: Arc::new(OnceLock::new()),
    };

    // One-time cleanup of orphaned legacy index files in the notes vault.
    cleanup_legacy(&notes_root);

    let _ = splade_trace(b"indexer::spawn: spawning task\n");
    // Supervised launch: a panic or unexpected Err inside run_loop used to
    // exit the task silently while leaving the engine installed. Subsequent
    // sends would no-op (the receiver is dropped) and the UI would sit on a
    // partial "indexing" state forever. Now we surface the crash via
    // fallback_reason so the indicator switches to an error state.
    let status_for_supervisor = status.clone();
    let ctx_for_supervisor = ctx.clone();
    tokio::spawn(async move {
        let _ = splade_trace(b"indexer::spawn: task started\n");
        let inner = tokio::task::spawn(run_loop(ctx, notes_root, indices, progress, status, rx));
        let crashed_reason: Option<&str> = match inner.await {
            Ok(Ok(())) => {
                let _ = splade_trace(b"indexer::spawn: run_loop returned Ok\n");
                None
            }
            Ok(Err(e)) => {
                let _ = splade_trace(format!("indexer::spawn: run_loop ERR: {e}\n"));
                eprintln!("[search/indexer] run_loop returned error: {e}");
                Some("indexer_crashed")
            }
            Err(je) => {
                let _ = splade_trace(format!(
                    "indexer::spawn: run_loop join error (panic={}): {je}\n",
                    je.is_panic()
                ));
                eprintln!("[search/indexer] run_loop panicked: {je}");
                Some("indexer_crashed")
            }
        };
        if let Some(reason) = crashed_reason {
            if let Ok(mut s) = status_for_supervisor.lock() {
                s.splade.fallback_reason = Some(reason.to_string());
                s.splade.ready = false;
                s.splade.compiling = false;
            }
            let snap = status_for_supervisor
                .lock()
                .map(|s| s.clone())
                .unwrap_or_default();
            ctx_for_supervisor.emit_status(&snap);
        }
    });

    Ok(handle)
}

async fn run_loop(
    ctx: Ctx,
    notes_root: PathBuf,
    indices: Arc<Mutex<TantivyIndices>>,
    progress: Arc<Mutex<Progress>>,
    status: Arc<Mutex<SearchStatus>>,
    mut rx: UnboundedReceiver<IndexerMsg>,
) -> Result<(), String> {
    let _ = splade_trace(b"run_loop: starting phase 1\n");
    // Phase 1: BM25 reconcile in a blocking task. We don't want to hold the
    // tokio runtime through synchronous Tantivy writes.
    {
        let notes_root = notes_root.clone();
        let indices = indices.clone();
        let progress_arc = progress.clone();
        let status_arc = status.clone();
        let ctx2 = ctx.clone();
        tokio::task::spawn_blocking(move || {
            let _ = splade_trace(b"run_loop: phase 1 spawn_blocking started\n");
            let _ = reconcile_bm25(&ctx2, &notes_root, &indices, &progress_arc, &status_arc);
            let _ = splade_trace(b"run_loop: reconcile_bm25 returned\n");
        })
        .await
        .map_err(|e| format!("bm25 join: {e}"))?;
    }
    let _ = splade_trace(b"run_loop: phase 1 complete, entering phase 2\n");

    // Phase 2: SPLADE backfill in a blocking task. Runs to completion or
    // bails out with a `fallback_reason`. Either way, the indicator UX
    // reflects the result.
    {
        let notes_root = notes_root.clone();
        let indices = indices.clone();
        let progress = progress.clone();
        let status_arc = status.clone();
        let ctx2 = ctx.clone();
        tokio::task::spawn_blocking(move || {
            backfill_splade(&ctx2, &notes_root, &indices, &progress, &status_arc);
        })
        .await
        .map_err(|e| format!("splade join: {e}"))?;
    }

    // Phase 3: steady-state message loop. Debounce per-path with a short
    // collection window so a burst of saves coalesces into one upsert.
    let debounce = Duration::from_millis(200);
    let mut pending: HashMap<String, ChangeKind> = HashMap::new();
    let mut deadline: Option<Instant> = None;
    loop {
        let sleep_to = deadline.map(|t| t.saturating_duration_since(Instant::now()));
        let next = if let Some(d) = sleep_to {
            tokio::select! {
                msg = rx.recv() => msg,
                _ = tokio::time::sleep(d) => None,
            }
        } else {
            rx.recv().await
        };
        match next {
            Some(IndexerMsg::Changed(path)) => {
                pending.insert(path, ChangeKind::Upsert);
                deadline = Some(Instant::now() + debounce);
            }
            Some(IndexerMsg::Removed(path)) => {
                pending.insert(path, ChangeKind::Remove);
                deadline = Some(Instant::now() + debounce);
            }
            Some(IndexerMsg::Renamed { from, to }) => {
                pending.insert(from, ChangeKind::Remove);
                pending.insert(to, ChangeKind::Upsert);
                deadline = Some(Instant::now() + debounce);
            }
            Some(IndexerMsg::Rescan) => {
                // A rescan request forces re-encoding regardless of cached
                // mtimes — clear the progress map first.
                if let Ok(mut p) = progress.lock() {
                    p.map.clear();
                    p.dirty = true;
                    p.save();
                }
                let notes_root = notes_root.clone();
                let indices = indices.clone();
                let progress = progress.clone();
                let status_arc = status.clone();
                let ctx2 = ctx.clone();
                tokio::task::spawn_blocking(move || {
                    let _ = reconcile_bm25(&ctx2, &notes_root, &indices, &progress, &status_arc);
                    backfill_splade(&ctx2, &notes_root, &indices, &progress, &status_arc);
                })
                .await
                .ok();
            }
            None => {
                if deadline.is_none() {
                    // Channel closed and nothing pending; exit.
                    break;
                }
            }
        }
        if let Some(d) = deadline {
            if Instant::now() >= d {
                let drained: Vec<(String, ChangeKind)> = pending.drain().collect();
                deadline = None;
                let notes_root = notes_root.clone();
                let indices = indices.clone();
                let progress = progress.clone();
                let status_arc = status.clone();
                let ctx2 = ctx.clone();
                tokio::task::spawn_blocking(move || {
                    apply_pending(&ctx2, &notes_root, &indices, &progress, &status_arc, drained);
                })
                .await
                .ok();
            }
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Copy)]
enum ChangeKind {
    Upsert,
    Remove,
}

fn apply_pending(
    ctx: &Ctx,
    notes_root: &Path,
    indices: &Arc<Mutex<TantivyIndices>>,
    progress: &Arc<Mutex<Progress>>,
    status: &Arc<Mutex<SearchStatus>>,
    changes: Vec<(String, ChangeKind)>,
) {
    if changes.is_empty() {
        return;
    }
    let mut splade_upserts: Vec<(String, String, i64)> = Vec::new();
    let mut splade_removes: Vec<String> = Vec::new();
    {
        let mut idx = match indices.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        for (rel, kind) in &changes {
            match kind {
                ChangeKind::Remove => {
                    let note_id = rel_to_note_id(rel);
                    idx.delete_note(&note_id);
                    splade_removes.push(note_id);
                }
                ChangeKind::Upsert => {
                    let abs = notes_root.join(rel);
                    let Ok(body) = fs::read_to_string(&abs) else {
                        continue;
                    };
                    let mtime_ms = mtime_ms_of(&abs).unwrap_or(0);
                    let note_id = rel_to_note_id(rel);
                    let title = note_title(&note_id);
                    let folder = folder_of(&note_id);
                    let tags = extract_tags_inline(&body);
                    idx.upsert_note_bm25(&note_id, &title, &body, &tags, &folder, mtime_ms);
                    splade_upserts.push((note_id, body, mtime_ms));
                }
            }
        }
        let _ = idx.commit_bm25();
    }
    if let Ok(mut p) = progress.lock() {
        for note_id in &splade_removes {
            p.forget(note_id);
        }
        p.save();
    }
    emit_keyword_ready(ctx, status);

    // Keyword-only build: no encoder, nothing to upsert into the SPLADE index.
    // Just flush the SPLADE tombstones buffered by the removes above.
    #[cfg(not(feature = "semantic"))]
    {
        let _ = splade_upserts;
        if let Ok(mut idx) = indices.lock() {
            let _ = idx.commit_splade();
        }
    }

    // SPLADE encoding may need the encoder; do it outside the mutex so reads
    // can proceed while encoding runs.
    #[cfg(feature = "semantic")]
    {
        if splade_upserts.is_empty() {
            let mut idx = match indices.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            let _ = idx.commit_splade();
            return;
        }

        let snapshot = status.lock().map(|s| s.clone()).unwrap_or_default();
        if !snapshot.splade.ready && snapshot.splade.fallback_reason.is_some() {
            // SPLADE permanently failed earlier; skip.
            return;
        }

        let encoder = match load_encoder(ctx, status) {
            Some(e) => e,
            None => return,
        };

        let mut encoded: Vec<(String, Vec<SpladeSparseVec>, i64)> = Vec::new();
        for (note_id, body, mtime_ms) in splade_upserts {
            let title = note_title(&note_id);
            let chunks = chunk_content_with_target(&body, chunker_target_tokens());
            let texts: Vec<String> = chunks
                .iter()
                .map(|c| build_embedding_text(&title, &c.text))
                .collect();
            let refs: Vec<&str> = texts.iter().map(|s| s.as_str()).collect();
            match encoder.lock() {
                Ok(mut enc) => match enc.encode_batch(&refs) {
                    Ok(vecs) => encoded.push((note_id, vecs, mtime_ms)),
                    Err(e) => {
                        eprintln!("[search/indexer] encode_batch failed: {e}");
                    }
                },
                Err(_) => return,
            }
        }
        {
            let mut idx = match indices.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            for (note_id, vecs, _) in &encoded {
                idx.upsert_note_splade(note_id, vecs);
            }
            let _ = idx.commit_splade();
        }
        if let Ok(mut p) = progress.lock() {
            for (note_id, _, mtime_ms) in encoded {
                p.record(note_id, mtime_ms);
            }
            p.save();
        }
    }
}

/// Phase-1 reconciliation against the filesystem. Despite the name, this
/// also reconciles deletions for the SPLADE index because `delete_note`
/// affects both writers — without this pass, notes deleted while the app
/// was closed would leave stale rows in both indices and ghost nodes in
/// any downstream graph view.
///
/// Returns the number of notes actually re-read + re-indexed this pass. On a
/// warm second launch with no edits this is 0 (the mtime gate skips the whole
/// vault); tests assert on it to pin the gate.
fn reconcile_bm25(
    ctx: &Ctx,
    notes_root: &Path,
    indices: &Arc<Mutex<TantivyIndices>>,
    progress: &Arc<Mutex<Progress>>,
    status: &Arc<Mutex<SearchStatus>>,
) -> u32 {
    use std::collections::HashSet;
    let files = walk_md_files(notes_root);
    let total = files.len() as u32;
    let on_disk: HashSet<String> = files.iter().map(|(rel, _, _)| rel_to_note_id(rel)).collect();
    let mut deleted: Vec<String> = Vec::new();
    let mut reindexed: u32 = 0;
    {
        let mut idx = match indices.lock() {
            Ok(g) => g,
            Err(_) => return 0,
        };
        // Enumerate the *currently-committed* index (note_id → mtime) before any
        // writes from this run land. One walk serves two purposes:
        //   1. Deletion reconcile: anything in the index but not on disk was
        //      deleted while we were offline; tombstone it in BM25 + SPLADE.
        //   2. The mtime gate (F16): the BM25 index already stores a per-note
        //      mtime, so we skip the `read_to_string` + delete+add for any note
        //      whose file mtime hasn't moved past what's indexed. Without this,
        //      reconcile re-reads + re-indexes the ENTIRE vault every launch.
        //      Mirrors SPLADE's `Progress::should_skip` semantics, but reads the
        //      authoritative mtime straight from the index (no extra sidecar).
        let indexed_mtimes = match idx.bm25_note_mtimes() {
            Ok(m) => m,
            Err(e) => {
                eprintln!("[search/indexer] bm25_note_mtimes failed (full reindex): {e}");
                HashMap::new()
            }
        };
        for (note_id, _) in indexed_mtimes.iter() {
            if !on_disk.contains(note_id) {
                idx.delete_note(note_id);
                deleted.push(note_id.clone());
            }
        }
        for (rel, abs, mtime_ms) in &files {
            let note_id = rel_to_note_id(rel);
            // Skip notes already indexed at a mtime ≥ the file's. `mtime_ms > 0`
            // guard matches `Progress::should_skip`: a 0 mtime means we couldn't
            // stat the file, so never trust the gate and always re-read.
            if *mtime_ms > 0 {
                if let Some(&stored) = indexed_mtimes.get(&note_id) {
                    if stored >= *mtime_ms {
                        continue;
                    }
                }
            }
            let Ok(body) = fs::read_to_string(abs) else {
                continue;
            };
            let title = note_title(&note_id);
            let folder = folder_of(&note_id);
            let tags = extract_tags_inline(&body);
            idx.upsert_note_bm25(&note_id, &title, &body, &tags, &folder, *mtime_ms);
            reindexed += 1;
        }
        if let Err(e) = idx.commit_bm25() {
            eprintln!("[search/indexer] bm25 commit failed: {e}");
        }
        // Also commit SPLADE: `delete_note` buffered tombstones in the SPLADE
        // writer too. If backfill_splade later returns early (e.g. encoder
        // failed to load) we'd lose them. Adds zero adds, only flushes the
        // tombstones — fast.
        if !deleted.is_empty() {
            if let Err(e) = idx.commit_splade() {
                eprintln!(
                    "[search/indexer] splade commit (deletion reconcile) failed: {e}"
                );
            }
        }
    }
    if !deleted.is_empty() {
        if let Ok(mut p) = progress.lock() {
            for note_id in &deleted {
                p.forget(note_id);
            }
            p.save();
        }
        eprintln!(
            "[search/indexer] reconciled {} deletion(s) detected at startup",
            deleted.len()
        );
    }
    eprintln!(
        "[search/indexer] BM25 reconcile: {reindexed} new/changed of {total} total ({} skipped via mtime gate)",
        total.saturating_sub(reindexed)
    );
    if let Ok(mut s) = status.lock() {
        s.keyword = KeywordStatus { ready: true };
        s.splade.total = total;
    }
    let snap = status.lock().map(|s| s.clone()).unwrap_or_default();
    ctx.emit_status(&snap);
    reindexed
}

/// Keyword-only stand-in for the SPLADE backfill: the semantic half (doc
/// encoder + futo-notes-inference + ORT) is compiled out, so report that as a
/// permanent fallback. `ready` stays false → `IndexerHandle::query` always
/// serves `"bm25"` hits; hosts read `fallback_reason = "semantic_disabled"`
/// to distinguish "disabled by build" from "still indexing".
#[cfg(not(feature = "semantic"))]
fn backfill_splade(
    ctx: &Ctx,
    notes_root: &Path,
    _indices: &Arc<Mutex<TantivyIndices>>,
    _progress: &Arc<Mutex<Progress>>,
    status: &Arc<Mutex<SearchStatus>>,
) {
    let total = walk_md_files(notes_root).len() as u32;
    if let Ok(mut s) = status.lock() {
        s.splade.total = total;
        s.splade.indexed = 0;
        s.splade.ready = false;
        s.splade.compiling = false;
        s.splade.fallback_reason = Some("semantic_disabled".to_string());
    }
    let snap = status.lock().map(|s| s.clone()).unwrap_or_default();
    ctx.emit_status(&snap);
}

#[cfg(feature = "semantic")]
fn backfill_splade(
    ctx: &Ctx,
    notes_root: &Path,
    indices: &Arc<Mutex<TantivyIndices>>,
    progress: &Arc<Mutex<Progress>>,
    status: &Arc<Mutex<SearchStatus>>,
) {
    // DEBUG: file-based marker so we can confirm this fn ran even when
    // stderr is being eaten by launchd.
    let _ = splade_trace(format!(
            "backfill_splade ENTERED at notes_root={}\n",
            notes_root.display()
        ),
    );
    let all_files = walk_md_files(notes_root);
    let total = all_files.len() as u32;
    let _ = splade_trace(format!(
            "backfill_splade walk done: {} files at notes_root={}\n",
            total,
            notes_root.display()
        ),
    );

    // Skip notes whose stored mtime is at least as new as the file's mtime.
    // This is the difference between "encode every boot" and "encode once".
    let pending: Vec<(String, PathBuf, i64)> = {
        let p = match progress.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        all_files
            .iter()
            .filter(|(rel, _abs, mtime)| !p.should_skip(&rel_to_note_id(rel), *mtime))
            .cloned()
            .collect()
    };
    let already_indexed = total.saturating_sub(pending.len() as u32);

    if let Ok(mut s) = status.lock() {
        s.splade.total = total;
        s.splade.indexed = already_indexed;
        s.splade.ready = pending.is_empty() && total > 0;
        s.splade.fallback_reason = None;
    }
    let snap = status.lock().map(|s| s.clone()).unwrap_or_default();
    ctx.emit_status(&snap);

    let _ = splade_trace(format!(
            "backfill_splade pending={} total={} already_indexed={}\n",
            pending.len(),
            total,
            already_indexed
        ),
    );
    if pending.is_empty() {
        // Vault is fully indexed; nothing to do.
        let _ = splade_trace(b"backfill_splade returning early: pending empty\n",
        );
        return;
    }

    eprintln!(
        "[search/indexer] SPLADE backfill: {} new/changed of {} total",
        pending.len(),
        total
    );

    let encoder = match load_encoder(ctx, status) {
        Some(e) => e,
        None => {
            let _ = splade_trace(b"backfill_splade returning: load_encoder returned None\n",
            );
            return;
        }
    };
    let _ = splade_trace(b"backfill_splade: encoder loaded, entering batch loop\n",
    );

    let mut indexed: u32 = already_indexed;
    let mut last_emit = Instant::now();
    let mut last_commit = Instant::now();
    let backfill_started = Instant::now();
    let mut chunks_encoded: u32 = 0;
    // Notes whose docs have been *written* via `upsert_note_splade` but not yet
    // *committed* to a Tantivy segment. We only persist their mtimes to
    // `splade-progress.json` after a successful `commit_splade()` — otherwise
    // a crash between progress save and the next 5-second commit would leave
    // the sidecar claiming "indexed" for notes the index has never seen.
    let mut pending_progress: Vec<(String, i64)> = Vec::new();

    for batch in pending.chunks(SPLADE_BATCH_SIZE) {
        let batch_started = Instant::now();
        // Build batched inputs across notes; track chunk-counts per note.
        let mut flat: Vec<String> = Vec::new();
        let mut owners: Vec<(String, usize, i64)> = Vec::new(); // (note_id, chunk_count, mtime)
        for (rel, abs, mtime) in batch {
            let Ok(body) = fs::read_to_string(abs) else {
                owners.push((rel_to_note_id(rel), 0, *mtime));
                continue;
            };
            let note_id = rel_to_note_id(rel);
            let title = note_title(&note_id);
            let chunks = chunk_content_with_target(&body, chunker_target_tokens());
            let cnt = chunks.len();
            for c in chunks {
                flat.push(build_embedding_text(&title, &c.text));
            }
            owners.push((note_id, cnt, *mtime));
        }
        let refs: Vec<&str> = flat.iter().map(|s| s.as_str()).collect();
        let encoded_flat = match encoder.lock() {
            Ok(mut enc) => match enc.encode_batch(&refs) {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("[search/indexer] backfill encode_batch failed: {e}");
                    if let Ok(mut s) = status.lock() {
                        s.splade.fallback_reason = Some("encoder_load_failed".to_string());
                    }
                    let snap = status.lock().map(|s| s.clone()).unwrap_or_default();
                    ctx.emit_status(&snap);
                    return;
                }
            },
            Err(_) => return,
        };
        // Re-slice the flat output back per-note.
        let mut cursor = 0;
        let commit_result = {
            let mut idx = match indices.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            for (note_id, cnt, _mtime) in &owners {
                if *cnt == 0 {
                    continue;
                }
                let slice = &encoded_flat[cursor..cursor + *cnt];
                cursor += *cnt;
                idx.upsert_note_splade(note_id, slice);
            }
            // Stage every note (including cnt==0 — keeps us from retrying
            // failed reads forever) for progress recording. Don't persist yet.
            for (note_id, _cnt, mtime) in &owners {
                pending_progress.push((note_id.clone(), *mtime));
            }
            // Commit on the 5-second cadence. Holding off lets Tantivy amortize
            // segment merges across batches.
            if last_commit.elapsed() > Duration::from_secs(5) {
                Some(idx.commit_splade())
            } else {
                None
            }
        };
        // Only persist progress for notes whose data is now durable. A
        // failed commit leaves pending_progress in memory; we'll retry on
        // the next batch's commit attempt or at end-of-loop.
        if let Some(Ok(())) = commit_result {
            if let Ok(mut p) = progress.lock() {
                for (note_id, mtime) in pending_progress.drain(..) {
                    p.record(note_id, mtime);
                }
                p.save();
            }
            last_commit = Instant::now();
        } else if let Some(Err(e)) = commit_result {
            eprintln!("[search/indexer] commit_splade failed mid-backfill: {e}");
            // Back off so we don't hammer commit on every following batch.
            last_commit = Instant::now();
        }
        indexed += batch.len() as u32;
        chunks_encoded += flat.len() as u32;
        let batch_ms = batch_started.elapsed().as_millis();
        let notes_per_sec = if batch_ms > 0 {
            (batch.len() as f64 * 1000.0) / batch_ms as f64
        } else {
            0.0
        };
        eprintln!(
            "[search/indexer] batch: {} notes / {} chunks in {} ms ({:.1} notes/s) — {}/{}",
            batch.len(),
            flat.len(),
            batch_ms,
            notes_per_sec,
            indexed,
            total
        );

        if let Ok(mut s) = status.lock() {
            s.splade.indexed = indexed;
        }
        if last_emit.elapsed() > Duration::from_millis(200) {
            let snap = status.lock().map(|s| s.clone()).unwrap_or_default();
            ctx.emit_status(&snap);
            last_emit = Instant::now();
        }

        // Yield CPU between batches so other apps stay responsive while
        // the indexer chews through the corpus on a fresh install.
        std::thread::sleep(INTER_BATCH_YIELD);
    }
    let total_secs = backfill_started.elapsed().as_secs_f64();
    eprintln!(
        "[search/indexer] SPLADE backfill done: {} notes / {} chunks in {:.1}s ({:.1} notes/s)",
        pending.len(),
        chunks_encoded,
        total_secs,
        pending.len() as f64 / total_secs.max(0.001)
    );

    // Final commit + drain. Same ordering rule as in-loop: progress only
    // records what the index actually holds.
    let final_commit = {
        let mut idx = match indices.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        idx.commit_splade()
    };
    match final_commit {
        Ok(()) => {
            if let Ok(mut p) = progress.lock() {
                for (note_id, mtime) in pending_progress.drain(..) {
                    p.record(note_id, mtime);
                }
                p.save();
            }
        }
        Err(e) => {
            eprintln!(
                "[search/indexer] final commit_splade failed: {e}. \
                 Dropping {} unpersisted progress entries — next launch will re-encode.",
                pending_progress.len()
            );
        }
    }
    if let Ok(mut s) = status.lock() {
        s.splade.indexed = total;
        s.splade.ready = total > 0;
    }
    let snap = status.lock().map(|s| s.clone()).unwrap_or_default();
    ctx.emit_status(&snap);
}

#[cfg(feature = "semantic")]
#[cfg_attr(target_arch = "arm", allow(unreachable_code))]
fn load_encoder(
    ctx: &Ctx,
    status: &Arc<Mutex<SearchStatus>>,
) -> Option<Arc<Mutex<SpladeDocEncoder>>> {
    // Encoder cache lives on the engine instance (`ctx.encoder`), not a
    // process-wide static — so two engines (e.g. in tests) don't share one.
    if let Some(e) = ctx.encoder.get() {
        return Some(e.clone());
    }
    // 32-bit ARM (armeabi-v7a) is unsupported: ORT's INT8 GEMM kernels SIGBUS
    // with BUS_ADRALN inside SpladeDocEncoder::load_with_threads on these
    // devices, and the fault happens below Rust so we can't catch the Err.
    // Skip the load entirely and let the app run BM25-only.
    #[cfg(target_arch = "arm")]
    {
        let _ = splade_trace(b"load_encoder: skipped (armv7 unsupported)\n");
        if let Ok(mut s) = status.lock() {
            s.splade.fallback_reason = Some("armv7_unsupported".to_string());
        }
        let snap = status.lock().map(|s| s.clone()).unwrap_or_default();
        ctx.emit_status(&snap);
        return None;
    }
    // Model path + variant come from the host (path resolution — resource_dir,
    // Android asset extraction, exe-sibling probing — stays platform-side).
    // `None` means BM25-only, so report it the same way a missing file would.
    let variant = ctx.variant;
    let model = match ctx.model_path.clone() {
        Some(p) if p.exists() => p,
        _ => {
            let _ = splade_trace(b"load_encoder: no model path configured / file missing\n");
            if let Ok(mut s) = status.lock() {
                s.splade.fallback_reason = Some("model_file_missing".to_string());
            }
            let snap = status.lock().map(|s| s.clone()).unwrap_or_default();
            ctx.emit_status(&snap);
            return None;
        }
    };
    let _ = splade_trace(format!(
            "load_encoder: found model {} variant={:?}\n",
            model.display(),
            variant
        ),
    );
    let tokenizer = match ctx.tokenizer_path.clone() {
        Some(p) if p.exists() => p,
        _ => {
            let _ = splade_trace(b"load_encoder: no tokenizer path configured / file missing\n");
            if let Ok(mut s) = status.lock() {
                s.splade.fallback_reason = Some("model_file_missing".to_string());
            }
            let snap = status.lock().map(|s| s.clone()).unwrap_or_default();
            ctx.emit_status(&snap);
            return None;
        }
    };
    // Surface the resolved paths + file sizes via stderr (visible in iOS Console
    // / idevicesyslog as `[stderr]` lines). Helps diagnose path-probe mismatches
    // when the model loads but the tokenizer parses as empty, etc.
    let model_size = std::fs::metadata(&model).map(|m| m.len()).unwrap_or(0);
    let tok_size = std::fs::metadata(&tokenizer).map(|m| m.len()).unwrap_or(0);
    eprintln!(
        "[search/indexer] resolved model={} ({} bytes) tokenizer={} ({} bytes)",
        model.display(),
        model_size,
        tokenizer.display(),
        tok_size
    );

    // The fp16 variant is shape-locked at [1, 128] and routes through
    // CoreML. The encoder reads these env vars at load time. Set them
    // before the SpladeDocEncoder::load call. Also retarget the chunker
    // so chunks fit inside the 128-token window without truncation.
    set_chunker_target_for_variant(variant);
    if matches!(variant, crate::SpladeModelVariant::Fp16Static128) {
        std::env::set_var("FUTO_SPLADE_FIXED_SEQ", "128");
        std::env::set_var("FUTO_SPLADE_BATCH1", "1");
        std::env::set_var("FUTO_COREML_ON", "1");
        eprintln!("[search/indexer] using fp16 SPLADE model + CoreML EP (seq=128, batch=1)");
    } else {
        eprintln!("[search/indexer] using int8 SPLADE model on CPU");
    }

    // SpladeDocEncoder::load on the fp16 variant pays a ~40s one-time CoreML
    // compile on first launch. Surface that as `compiling=true` so the UI can
    // distinguish "model warming up" from "stuck at 0 / N".
    if let Ok(mut s) = status.lock() {
        s.splade.compiling = true;
    }
    let snap = status.lock().map(|s| s.clone()).unwrap_or_default();
    ctx.emit_status(&snap);

    let started = Instant::now();
    let _ = splade_trace(b"load_encoder: calling SpladeDocEncoder::load\n",
    );
    let result = SpladeDocEncoder::load(&model, &tokenizer);

    if let Ok(mut s) = status.lock() {
        s.splade.compiling = false;
    }
    let snap = status.lock().map(|s| s.clone()).unwrap_or_default();
    ctx.emit_status(&snap);

    match result {
        Ok(enc) => {
            let _ = splade_trace(format!(
                    "load_encoder: SUCCESS in {} ms\n",
                    started.elapsed().as_millis()
                ),
            );
            eprintln!(
                "[search/indexer] encoder loaded in {} ms",
                started.elapsed().as_millis()
            );
            let arc = Arc::new(Mutex::new(enc));
            let _ = ctx.encoder.set(arc.clone());
            Some(arc)
        }
        Err(e) => {
            let _ = splade_trace(format!("load_encoder: SpladeDocEncoder::load FAILED: {e}\n"),
            );
            eprintln!("[search/indexer] encoder load failed: {e}");
            if let Ok(mut s) = status.lock() {
                s.splade.fallback_reason = Some("encoder_load_failed".to_string());
            }
            let snap = status.lock().map(|s| s.clone()).unwrap_or_default();
            ctx.emit_status(&snap);
            None
        }
    }
}

/// Chunker target tokens. The fp16 model is fixed at seq=128 WordPiece
/// tokens, so chunks larger than that get truncated and we lose information
/// from the tail. With ~1.3× WordPiece-to-word ratio, ~96 estimated tokens
/// is the right target to avoid truncation.
#[cfg(feature = "semantic")]
fn chunker_target_tokens() -> usize {
    // Match the model variant we *actually* loaded if possible. We don't
    // know it inside this fn without plumbing it through, so use a static
    // OnceLock primed by the load_encoder path.
    SPLADE_TARGET_TOKENS_RUNTIME
        .get()
        .copied()
        .unwrap_or(SPLADE_TARGET_TOKENS)
}

#[cfg(feature = "semantic")]
use std::sync::OnceLock as ChunkOnceLock;
#[cfg(feature = "semantic")]
static SPLADE_TARGET_TOKENS_RUNTIME: ChunkOnceLock<usize> = ChunkOnceLock::new();

#[cfg(feature = "semantic")]
fn set_chunker_target_for_variant(variant: crate::SpladeModelVariant) {
    let target = match variant {
        crate::SpladeModelVariant::Fp16Static128 => 96,
        crate::SpladeModelVariant::Int8Dynamic => SPLADE_TARGET_TOKENS,
    };
    let _ = SPLADE_TARGET_TOKENS_RUNTIME.set(target);
}

fn emit_keyword_ready(ctx: &Ctx, status: &Arc<Mutex<SearchStatus>>) {
    if let Ok(mut s) = status.lock() {
        s.keyword.ready = true;
    }
    let snap = status.lock().map(|s| s.clone()).unwrap_or_default();
    ctx.emit_status(&snap);
}

/// Walk the notes root and return `(relative_path, absolute_path, mtime_ms)`
/// for every `.md` file.
fn walk_md_files(notes_root: &Path) -> Vec<(String, PathBuf, i64)> {
    let mut out = Vec::new();
    for entry in WalkDir::new(notes_root)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let abs = entry.path().to_path_buf();
        let Some(name) = abs.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if name.starts_with('.') {
            continue;
        }
        let ext_ok = abs.extension().and_then(|e| e.to_str()).map(|e| {
            let e = e.to_lowercase();
            e == "md" || e == "txt"
        });
        if ext_ok != Some(true) {
            continue;
        }
        let Ok(rel) = abs.strip_prefix(notes_root) else {
            continue;
        };
        let rel_s = rel.to_string_lossy().replace('\\', "/");
        let mtime_ms = mtime_ms_of(&abs).unwrap_or(0);
        out.push((rel_s, abs, mtime_ms));
    }
    out
}

fn mtime_ms_of(path: &Path) -> Option<i64> {
    let meta = fs::metadata(path).ok()?;
    let mt = meta.modified().ok()?;
    let dur = mt
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as i64)?;
    Some(dur)
}

fn rel_to_note_id(rel: &str) -> String {
    let r = rel.replace('\\', "/");
    if let Some(stripped) = r.strip_suffix(".md") {
        stripped.to_string()
    } else if let Some(stripped) = r.strip_suffix(".txt") {
        stripped.to_string()
    } else {
        r
    }
}

fn note_title(note_id: &str) -> String {
    note_id.rsplit('/').next().unwrap_or(note_id).to_string()
}

fn folder_of(note_id: &str) -> String {
    match note_id.rsplit_once('/') {
        Some((dir, _)) => dir.to_string(),
        None => String::new(),
    }
}

fn extract_tags_inline(body: &str) -> String {
    // Crude inline extractor: matches `#tag` patterns without context. Faster
    // than spinning up a regex; the BM25 layer doesn't need strict parity
    // with the TS extractor — it just needs the tokens.
    let mut out = String::new();
    let mut chars = body.char_indices().peekable();
    while let Some((_i, c)) = chars.next() {
        if c == '#' {
            let mut tag = String::new();
            while let Some(&(_, nc)) = chars.peek() {
                if nc.is_alphanumeric() || nc == '_' || nc == '-' {
                    tag.push(nc);
                    chars.next();
                } else {
                    break;
                }
            }
            if !tag.is_empty() {
                if !out.is_empty() {
                    out.push(' ');
                }
                out.push_str(&tag);
            }
        }
    }
    out
}

fn cleanup_legacy(notes_root: &Path) {
    let _ = fs::remove_file(notes_root.join(".search-index-v1.json"));
    let _ = fs::remove_file(notes_root.join(".search-splade-v1.bin"));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SpladeModelVariant;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::time::{Instant, SystemTime, UNIX_EPOCH};

    struct ScopedTempDir(PathBuf);
    impl ScopedTempDir {
        fn new(tag: &str) -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let ms = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let dir = std::env::temp_dir().join(format!("futo-search-reconcile-{tag}-{ms}-{n}"));
            std::fs::create_dir_all(&dir).expect("create temp dir");
            Self(dir)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for ScopedTempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// BM25-only Ctx (no SPLADE model) + the Arc-wrapped state `reconcile_bm25`
    /// needs. Opens fresh indices against `index_root`.
    fn make_state(
        index_root: &Path,
    ) -> (
        Ctx,
        Arc<Mutex<TantivyIndices>>,
        Arc<Mutex<Progress>>,
        Arc<Mutex<SearchStatus>>,
    ) {
        let ctx = Ctx::new(Arc::new(|_| {}), None, None, SpladeModelVariant::Int8Dynamic);
        let indices = Arc::new(Mutex::new(
            TantivyIndices::open(index_root).expect("open indices"),
        ));
        let progress = Arc::new(Mutex::new(Progress::load(index_root)));
        let status = Arc::new(Mutex::new(SearchStatus::default()));
        (ctx, indices, progress, status)
    }

    fn run_reconcile(notes_root: &Path, index_root: &Path) -> u32 {
        let (ctx, indices, progress, status) = make_state(index_root);
        reconcile_bm25(&ctx, notes_root, &indices, &progress, &status)
    }

    /// F16 regression: the second BM25 reconcile over an unchanged vault must
    /// re-index ZERO notes (the mtime gate skips the whole corpus). Before the
    /// fix this re-read + re-indexed every note on every launch.
    #[test]
    fn warm_reconcile_skips_unchanged_vault() {
        let vault = ScopedTempDir::new("vault");
        let index = ScopedTempDir::new("index");
        for i in 0..50 {
            std::fs::write(
                vault.path().join(format!("note-{i}.md")),
                format!("body of note {i} with some words"),
            )
            .unwrap();
        }

        // First (cold) launch: every note is new → all re-indexed.
        let cold = run_reconcile(vault.path(), index.path());
        assert_eq!(cold, 50, "cold launch indexes the whole vault");

        // Second (warm) launch against the same committed index: nothing changed
        // on disk, so the gate skips everything.
        let warm = run_reconcile(vault.path(), index.path());
        assert_eq!(warm, 0, "warm launch must skip every unchanged note");
    }

    /// F16: a single edited note (newer mtime) is re-indexed; everything else
    /// stays gated. Deleted notes are tombstoned without re-reading survivors.
    #[test]
    fn warm_reconcile_only_reindexes_changed_and_handles_deletion() {
        let vault = ScopedTempDir::new("vault");
        let index = ScopedTempDir::new("index");
        for i in 0..20 {
            std::fs::write(vault.path().join(format!("n{i}.md")), format!("v0 {i}")).unwrap();
        }
        assert_eq!(run_reconcile(vault.path(), index.path()), 20);

        // Edit one note + bump its mtime past the indexed value.
        let edited = vault.path().join("n7.md");
        std::fs::write(&edited, "v1 changed body").unwrap();
        let future = SystemTime::now() + std::time::Duration::from_secs(120);
        filetime_set(&edited, future);

        // Delete another note entirely.
        std::fs::remove_file(vault.path().join("n3.md")).unwrap();

        let warm = run_reconcile(vault.path(), index.path());
        assert_eq!(warm, 1, "only the edited note is re-read + re-indexed");

        // The deletion was reconciled: n3 is gone, the rest survive.
        let idx = TantivyIndices::open(index.path()).unwrap();
        let mut ids = idx.list_bm25_note_ids().unwrap();
        ids.sort();
        assert!(!ids.contains(&"n3".to_string()), "deleted note tombstoned");
        assert_eq!(ids.len(), 19, "19 survivors");
    }

    /// Set a file's mtime to `when` so the gate sees a newer value. Uses a
    /// short sleep + rewrite fallback if direct mtime control isn't available
    /// (no filetime crate dep — we drive it through the OS via `utimes`).
    fn filetime_set(path: &Path, when: SystemTime) {
        let dur = when
            .duration_since(UNIX_EPOCH)
            .unwrap_or(std::time::Duration::ZERO);
        set_mtime_secs(path, dur.as_secs() as i64);
    }

    #[cfg(unix)]
    fn set_mtime_secs(path: &Path, secs: i64) {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        let c = CString::new(path.as_os_str().as_bytes()).unwrap();
        let times = [
            libc_timeval { tv_sec: secs, tv_usec: 0 },
            libc_timeval { tv_sec: secs, tv_usec: 0 },
        ];
        unsafe {
            utimes(c.as_ptr(), times.as_ptr());
        }
    }

    #[cfg(not(unix))]
    fn set_mtime_secs(path: &Path, _secs: i64) {
        // Non-unix fallback: rewrite bumps mtime to "now", which is newer than
        // the indexed value, satisfying the gate.
        let body = std::fs::read(path).unwrap_or_default();
        std::fs::write(path, body).unwrap();
    }

    #[cfg(unix)]
    #[repr(C)]
    struct libc_timeval {
        tv_sec: i64,
        tv_usec: i64,
    }
    #[cfg(unix)]
    extern "C" {
        fn utimes(path: *const std::os::raw::c_char, times: *const libc_timeval) -> i32;
    }

    /// Measurement harness (ignored by default — run with
    /// `cargo test -p futo-notes-search measure_warm_reconcile_5k -- --ignored --nocapture`).
    /// Generates a 5k-note vault with varied sizes (incl. a few multi-MB notes),
    /// then times the cold vs warm BM25 reconcile. Cleans up after itself.
    #[test]
    #[ignore]
    fn measure_warm_reconcile_5k() {
        let vault = ScopedTempDir::new("measure-vault");
        let index = ScopedTempDir::new("measure-index");
        let n = 5000usize;
        for i in 0..n {
            // Varied sizes: most small, some medium, a handful multi-MB.
            let body = if i % 1000 == 0 {
                "lorem ipsum dolor ".repeat(120_000) // ~2.2 MB
            } else if i % 50 == 0 {
                "medium note body ".repeat(2_000) // ~34 KB
            } else {
                format!("note {i} body with #tag{i} and a few searchable words")
            };
            std::fs::write(vault.path().join(format!("note-{i}.md")), body).unwrap();
        }

        let t0 = Instant::now();
        let cold = run_reconcile(vault.path(), index.path());
        let cold_ms = t0.elapsed().as_millis();

        let t1 = Instant::now();
        let warm = run_reconcile(vault.path(), index.path());
        let warm_ms = t1.elapsed().as_millis();

        println!(
            "[measure] 5k vault: cold reindexed={cold} in {cold_ms}ms; warm reindexed={warm} in {warm_ms}ms"
        );
        assert_eq!(cold, n as u32);
        assert_eq!(warm, 0, "warm launch must skip everything");
    }
}

