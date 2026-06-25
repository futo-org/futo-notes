//! Long-lived BM25 indexer task and query handle.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::mpsc::UnboundedReceiver;
use walkdir::WalkDir;

use crate::tantivy_indices::TantivyIndices;
use crate::{KeywordStatus, SearchHit, SearchStatus, StatusObserver, DEFAULT_TOPK};

#[derive(Clone)]
pub(crate) struct Ctx {
    on_status: StatusObserver,
}

impl Ctx {
    pub(crate) fn new(on_status: StatusObserver) -> Self {
        Self { on_status }
    }

    fn emit_status(&self, status: &SearchStatus) {
        (self.on_status)(status);
    }
}

#[derive(Debug)]
pub enum IndexerMsg {
    Changed(String),
    Removed(String),
    Renamed { from: String, to: String },
    Rescan,
}

#[derive(Clone)]
pub struct IndexerHandle {
    indices: Arc<Mutex<TantivyIndices>>,
}

impl IndexerHandle {
    pub fn query(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>, String> {
        let trimmed = query.trim();
        if trimmed.is_empty() {
            return Ok(vec![]);
        }
        let indices = self.indices.lock().map_err(|_| "index mutex poisoned".to_string())?;
        let bm25 = indices.search_bm25(trimmed, limit.max(1).min(DEFAULT_TOPK))?;
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

pub(crate) fn spawn(
    ctx: Ctx,
    notes_root: PathBuf,
    index_root: PathBuf,
    rx: UnboundedReceiver<IndexerMsg>,
    status: Arc<Mutex<SearchStatus>>,
) -> Result<IndexerHandle, String> {
    let indices = Arc::new(Mutex::new(TantivyIndices::open(&index_root)?));
    let handle = IndexerHandle {
        indices: indices.clone(),
    };

    cleanup_legacy(&notes_root);

    let status_for_supervisor = status.clone();
    let ctx_for_supervisor = ctx.clone();
    tokio::spawn(async move {
        let inner = tokio::task::spawn(run_loop(ctx, notes_root, indices, status, rx));
        match inner.await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                eprintln!("[search/indexer] run_loop returned error: {e}");
            }
            Err(je) => {
                eprintln!("[search/indexer] run_loop panicked: {je}");
            }
        }
        let snap = status_for_supervisor
            .lock()
            .map(|s| s.clone())
            .unwrap_or_default();
        ctx_for_supervisor.emit_status(&snap);
    });

    Ok(handle)
}

async fn run_loop(
    ctx: Ctx,
    notes_root: PathBuf,
    indices: Arc<Mutex<TantivyIndices>>,
    status: Arc<Mutex<SearchStatus>>,
    mut rx: UnboundedReceiver<IndexerMsg>,
) -> Result<(), String> {
    {
        let notes_root = notes_root.clone();
        let indices = indices.clone();
        let status_arc = status.clone();
        let ctx2 = ctx.clone();
        tokio::task::spawn_blocking(move || {
            let _ = reconcile_bm25(&ctx2, &notes_root, &indices, &status_arc);
        })
        .await
        .map_err(|e| format!("bm25 join: {e}"))?;
    }

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
                let notes_root = notes_root.clone();
                let indices = indices.clone();
                let status_arc = status.clone();
                let ctx2 = ctx.clone();
                tokio::task::spawn_blocking(move || {
                    let _ = reconcile_bm25(&ctx2, &notes_root, &indices, &status_arc);
                })
                .await
                .ok();
            }
            None => {
                if deadline.is_none() {
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
                let status_arc = status.clone();
                let ctx2 = ctx.clone();
                tokio::task::spawn_blocking(move || {
                    apply_pending(&ctx2, &notes_root, &indices, &status_arc, drained);
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
    status: &Arc<Mutex<SearchStatus>>,
    changes: Vec<(String, ChangeKind)>,
) {
    if changes.is_empty() {
        return;
    }
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
                }
            }
        }
        let _ = idx.commit_bm25();
    }
    emit_keyword_ready(ctx, status);
}

/// Reconcile the BM25 index against the filesystem.
///
/// Returns the number of notes re-read + re-indexed this pass. On a warm second
/// launch with no edits this is 0 because the mtime gate skips unchanged files.
fn reconcile_bm25(
    ctx: &Ctx,
    notes_root: &Path,
    indices: &Arc<Mutex<TantivyIndices>>,
    status: &Arc<Mutex<SearchStatus>>,
) -> u32 {
    use std::collections::HashSet;
    let files = walk_md_files(notes_root);
    let total = files.len() as u32;
    let on_disk: HashSet<String> = files.iter().map(|(rel, _, _)| rel_to_note_id(rel)).collect();
    let mut deleted: u32 = 0;
    let mut reindexed: u32 = 0;
    {
        let mut idx = match indices.lock() {
            Ok(g) => g,
            Err(_) => return 0,
        };
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
                deleted += 1;
            }
        }
        for (rel, abs, mtime_ms) in &files {
            let note_id = rel_to_note_id(rel);
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
    }
    if deleted > 0 {
        eprintln!("[search/indexer] reconciled {deleted} deletion(s) detected at startup");
    }
    eprintln!(
        "[search/indexer] BM25 reconcile: {reindexed} new/changed of {total} total ({} skipped via mtime gate)",
        total.saturating_sub(reindexed)
    );
    emit_keyword_ready(ctx, status);
    reindexed
}

fn emit_keyword_ready(ctx: &Ctx, status: &Arc<Mutex<SearchStatus>>) {
    if let Ok(mut s) = status.lock() {
        s.keyword = KeywordStatus { ready: true };
    }
    let snap = status.lock().map(|s| s.clone()).unwrap_or_default();
    ctx.emit_status(&snap);
}

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

    fn make_state(
        index_root: &Path,
    ) -> (
        Ctx,
        Arc<Mutex<TantivyIndices>>,
        Arc<Mutex<SearchStatus>>,
    ) {
        let ctx = Ctx::new(Arc::new(|_| {}));
        let indices = Arc::new(Mutex::new(
            TantivyIndices::open(index_root).expect("open indices"),
        ));
        let status = Arc::new(Mutex::new(SearchStatus::default()));
        (ctx, indices, status)
    }

    fn run_reconcile(notes_root: &Path, index_root: &Path) -> u32 {
        let (ctx, indices, status) = make_state(index_root);
        reconcile_bm25(&ctx, notes_root, &indices, &status)
    }

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

        let cold = run_reconcile(vault.path(), index.path());
        assert_eq!(cold, 50, "cold launch indexes the whole vault");

        let warm = run_reconcile(vault.path(), index.path());
        assert_eq!(warm, 0, "warm launch must skip every unchanged note");
    }

    #[test]
    fn warm_reconcile_only_reindexes_changed_and_handles_deletion() {
        let vault = ScopedTempDir::new("vault");
        let index = ScopedTempDir::new("index");
        for i in 0..20 {
            std::fs::write(vault.path().join(format!("n{i}.md")), format!("v0 {i}")).unwrap();
        }
        assert_eq!(run_reconcile(vault.path(), index.path()), 20);

        let edited = vault.path().join("n7.md");
        std::fs::write(&edited, "v1 changed body").unwrap();
        let future = SystemTime::now() + std::time::Duration::from_secs(120);
        filetime_set(&edited, future);

        std::fs::remove_file(vault.path().join("n3.md")).unwrap();

        let warm = run_reconcile(vault.path(), index.path());
        assert_eq!(warm, 1, "only the edited note is re-read + re-indexed");

        let idx = TantivyIndices::open(index.path()).unwrap();
        let mut ids = idx.list_bm25_note_ids().unwrap();
        ids.sort();
        assert!(!ids.contains(&"n3".to_string()), "deleted note tombstoned");
        assert_eq!(ids.len(), 19, "19 survivors");
    }

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

    #[test]
    #[ignore]
    fn measure_warm_reconcile_5k() {
        let vault = ScopedTempDir::new("measure-vault");
        let index = ScopedTempDir::new("measure-index");
        let n = 5000usize;
        for i in 0..n {
            let body = if i % 1000 == 0 {
                "lorem ipsum dolor ".repeat(120_000)
            } else if i % 50 == 0 {
                "medium note body ".repeat(2_000)
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
