//! Tantivy index handles for BM25 (keyword) and SPLADE (sparse).
//!
//! BM25 schema: one doc per note. Title + body + tags + folder + mtime fast field.
//! SPLADE schema: one doc per chunk. `terms` field stores pre-tokenized SPLADE
//! expansion tokens with frequency = `round(weight * SPLADE_SCALE)`. The custom
//! `WeightedSpladeQuery` scorer reads `term_freq` to recover the weight.

use std::collections::HashMap;
use std::path::Path;

use tantivy::collector::{Collector, TopDocs};
use tantivy::query::QueryParser;
use tantivy::schema::{
    Field, IndexRecordOption, Schema, TextFieldIndexing, TextOptions, FAST, INDEXED, STORED,
    STRING,
};
#[cfg(feature = "semantic")]
use tantivy::tokenizer::PreTokenizedString;
use tantivy::{Index, IndexReader, IndexWriter, ReloadPolicy, TantivyDocument, Term};

// Silence unused-import warnings: Collector trait import is required for
// `Searcher::search` to recognize `TopDocs` as a Collector.
#[allow(dead_code)]
fn _collector_in_scope<C: Collector>() {}

#[cfg(feature = "semantic")]
use futo_notes_inference::SpladeSparseVec;

#[cfg(feature = "semantic")]
use crate::SPLADE_SCALE;

/// Schema field handles for the BM25 index.
pub struct Bm25Schema {
    pub schema: Schema,
    pub note_id: Field,
    pub title: Field,
    pub body: Field,
    pub tags: Field,
    pub folder: Field,
    pub mtime: Field,
}

impl Bm25Schema {
    fn build() -> Self {
        let mut sb = Schema::builder();
        // Use the default tokenizer (lowercase + ASCII fold + simple split).
        let text_opts = TextOptions::default().set_indexing_options(
            TextFieldIndexing::default()
                .set_tokenizer("default")
                .set_index_option(IndexRecordOption::WithFreqsAndPositions),
        );
        let note_id = sb.add_text_field("note_id", STRING | STORED);
        let title = sb.add_text_field("title", text_opts.clone());
        let body = sb.add_text_field("body", text_opts.clone());
        let tags = sb.add_text_field("tags", text_opts.clone());
        let folder = sb.add_text_field("folder", text_opts);
        // i64 fast field for recency tiebreaks. Numeric fields need INDEXED
        // for range queries.
        let mtime = sb.add_i64_field("mtime", FAST | STORED | INDEXED);
        let schema = sb.build();
        Self {
            schema,
            note_id,
            title,
            body,
            tags,
            folder,
            mtime,
        }
    }
}

/// Schema field handles for the SPLADE index.
pub struct SpladeSchema {
    pub schema: Schema,
    pub note_id: Field,
    /// Written only by the semantic upsert path.
    #[cfg_attr(not(feature = "semantic"), allow(dead_code))]
    pub chunk_idx: Field,
    #[cfg_attr(not(feature = "semantic"), allow(dead_code))]
    pub terms: Field,
}

impl SpladeSchema {
    fn build() -> Self {
        let mut sb = Schema::builder();
        // `raw` tokenizer means the text is treated as a single token by
        // default. We bypass tokenization entirely by passing
        // `PreTokenizedString` documents, so what matters here is that the
        // tokenizer name resolves at query time when we look up Terms.
        let terms_opts = TextOptions::default().set_indexing_options(
            TextFieldIndexing::default()
                .set_tokenizer("raw")
                .set_index_option(IndexRecordOption::WithFreqs),
        );
        // STRING already enables exact-token indexing; INDEXED only applies
        // to numeric fields.
        let note_id = sb.add_text_field("note_id", STRING | STORED);
        let chunk_idx = sb.add_u64_field("chunk_idx", STORED);
        let terms = sb.add_text_field("terms", terms_opts);
        let schema = sb.build();
        Self {
            schema,
            note_id,
            chunk_idx,
            terms,
        }
    }
}

/// Combined handle: both indices, their writers, readers, and schemas.
///
/// Writers are buffered (10 MB each). Callers commit explicitly via `commit`.
pub struct TantivyIndices {
    pub bm25: Index,
    pub bm25_schema: Bm25Schema,
    pub bm25_writer: IndexWriter,
    pub bm25_reader: IndexReader,

    // Retained for ownership symmetry with `bm25`; the SPLADE path queries via
    // `splade_reader` + the custom scorer (no `QueryParser::for_index`), so the
    // `Index` itself isn't read after construction.
    #[allow(dead_code)]
    pub splade: Index,
    pub splade_schema: SpladeSchema,
    pub splade_writer: IndexWriter,
    pub splade_reader: IndexReader,
}

/// Bump when any change makes existing on-disk SPLADE docs unreadable or
/// produces wrong scores at query time (schema fields, quantization scale,
/// term naming, ...). On boot, the indexer compares this to a sidecar in the
/// search dir and blows away both `splade/` and `splade-progress.json` if it
/// mismatches, forcing a clean reindex.
pub const SPLADE_INDEX_VERSION: &str = "v2-scale32";

/// Tmp + fsync + rename for the splade.version marker. A bare `fs::write`
/// would skip fsync on the data and on the directory, so a crash between
/// the kernel acknowledging the write and the data hitting disk could
/// leave the marker truncated. The rename is atomic at the directory-entry
/// level, so readers see either the old marker or the new — never garbage.
fn write_version_atomically(path: &Path, version: &str) -> std::io::Result<()> {
    use std::io::Write;
    let tmp = path.with_extension("version.tmp");
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(version.as_bytes())?;
        f.sync_all()?;
    }
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

impl TantivyIndices {
    pub fn open(index_root: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(index_root).map_err(|e| format!("mkdir search root: {e}"))?;

        // Discard the splade dir if the on-disk version marker doesn't match
        // the running build. Old SCALE=100 docs read back with garbled scores
        // under SCALE=32, so silent mismatch is worse than a one-time rebuild.
        //
        // Atomicity matters: a torn write to splade.version would leave a
        // partial string that mismatches SPLADE_INDEX_VERSION and triggers a
        // perpetual rebuild on every launch. tmp + fsync + rename avoids that.
        // Removal failures are fatal (better to bail than reuse stale data
        // that scores wrong under the new schema).
        let version_file = index_root.join("splade.version");
        let existing = std::fs::read_to_string(&version_file).ok();
        if existing.as_deref() != Some(SPLADE_INDEX_VERSION) {
            // Remove progress sidecar first — if anything below fails, the
            // next launch re-encodes (safe), it doesn't think it's done.
            if let Err(e) = std::fs::remove_file(index_root.join("splade-progress.json")) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    return Err(format!("remove stale splade-progress.json: {e}"));
                }
            }
            if let Err(e) = std::fs::remove_dir_all(index_root.join("splade")) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    return Err(format!("remove stale splade dir: {e}"));
                }
            }
            write_version_atomically(&version_file, SPLADE_INDEX_VERSION)
                .map_err(|e| format!("persist splade.version: {e}"))?;
        }

        let bm25_dir = index_root.join("bm25");
        let splade_dir = index_root.join("splade");
        std::fs::create_dir_all(&bm25_dir).map_err(|e| format!("mkdir bm25: {e}"))?;
        std::fs::create_dir_all(&splade_dir).map_err(|e| format!("mkdir splade: {e}"))?;

        let bm25_schema = Bm25Schema::build();
        let splade_schema = SpladeSchema::build();

        let bm25 = Index::open_or_create(
            tantivy::directory::MmapDirectory::open(&bm25_dir)
                .map_err(|e| format!("open bm25 dir: {e}"))?,
            bm25_schema.schema.clone(),
        )
        .map_err(|e| format!("open bm25 index: {e}"))?;

        let splade = Index::open_or_create(
            tantivy::directory::MmapDirectory::open(&splade_dir)
                .map_err(|e| format!("open splade dir: {e}"))?,
            splade_schema.schema.clone(),
        )
        .map_err(|e| format!("open splade index: {e}"))?;

        // 50 MB heap split across one indexing thread per writer is plenty
        // at our corpus size and keeps memory predictable on mobile.
        let bm25_writer = bm25
            .writer(50_000_000)
            .map_err(|e| format!("bm25 writer: {e}"))?;
        let splade_writer = splade
            .writer(50_000_000)
            .map_err(|e| format!("splade writer: {e}"))?;

        let bm25_reader = bm25
            .reader_builder()
            .reload_policy(ReloadPolicy::Manual)
            .try_into()
            .map_err(|e| format!("bm25 reader: {e}"))?;
        let splade_reader = splade
            .reader_builder()
            .reload_policy(ReloadPolicy::Manual)
            .try_into()
            .map_err(|e| format!("splade reader: {e}"))?;

        Ok(Self {
            bm25,
            bm25_schema,
            bm25_writer,
            bm25_reader,
            splade,
            splade_schema,
            splade_writer,
            splade_reader,
        })
    }

    /// Upsert one note's content into the BM25 index (delete-then-add by note_id).
    pub fn upsert_note_bm25(
        &mut self,
        note_id: &str,
        title: &str,
        body: &str,
        tags: &str,
        folder: &str,
        mtime_ms: i64,
    ) {
        let term = Term::from_field_text(self.bm25_schema.note_id, note_id);
        let _ = self.bm25_writer.delete_term(term);
        let mut doc = TantivyDocument::default();
        doc.add_text(self.bm25_schema.note_id, note_id);
        doc.add_text(self.bm25_schema.title, title);
        doc.add_text(self.bm25_schema.body, body);
        doc.add_text(self.bm25_schema.tags, tags);
        doc.add_text(self.bm25_schema.folder, folder);
        doc.add_i64(self.bm25_schema.mtime, mtime_ms);
        let _ = self.bm25_writer.add_document(doc);
    }

    /// Replace all SPLADE docs for a note with the provided chunk vectors.
    /// Semantic-only: keyword builds never produce chunk vectors (the SPLADE
    /// index still exists so `delete_note` tombstones stay symmetric).
    #[cfg(feature = "semantic")]
    pub fn upsert_note_splade(&mut self, note_id: &str, chunks: &[SpladeSparseVec]) {
        let term = Term::from_field_text(self.splade_schema.note_id, note_id);
        let _ = self.splade_writer.delete_term(term);
        for (idx, vec) in chunks.iter().enumerate() {
            if vec.indices.is_empty() {
                continue;
            }
            let pre = build_splade_pretokenized(vec);
            let mut doc = TantivyDocument::default();
            doc.add_text(self.splade_schema.note_id, note_id);
            doc.add_u64(self.splade_schema.chunk_idx, idx as u64);
            doc.add_pre_tokenized_text(self.splade_schema.terms, pre);
            let _ = self.splade_writer.add_document(doc);
        }
    }

    pub fn delete_note(&mut self, note_id: &str) {
        let bm25_term = Term::from_field_text(self.bm25_schema.note_id, note_id);
        let _ = self.bm25_writer.delete_term(bm25_term);
        let splade_term = Term::from_field_text(self.splade_schema.note_id, note_id);
        let _ = self.splade_writer.delete_term(splade_term);
    }

    /// All note_ids currently visible in the committed BM25 index. Reads the
    /// `note_id` stored field on every doc — one doc per note, so cost is
    /// proportional to corpus size. Retained as a focused id-only sibling to
    /// [`Self::bm25_note_mtimes`] (which startup reconcile now uses); kept for
    /// tests and any caller that needs the id set without the mtime map.
    #[allow(dead_code)]
    pub fn list_bm25_note_ids(&self) -> Result<Vec<String>, String> {
        use tantivy::collector::DocSetCollector;
        use tantivy::query::AllQuery;
        let searcher = self.bm25_reader.searcher();
        let doc_addrs = searcher
            .search(&AllQuery, &DocSetCollector)
            .map_err(|e| format!("list bm25 docs: {e}"))?;
        let mut out = Vec::with_capacity(doc_addrs.len());
        for addr in doc_addrs {
            let doc: TantivyDocument = searcher
                .doc(addr)
                .map_err(|e| format!("bm25 doc fetch: {e}"))?;
            if let Some(note_id) = read_stored_text(&doc, self.bm25_schema.note_id) {
                out.push(note_id);
            }
        }
        Ok(out)
    }

    /// Committed `note_id → mtime_ms` for every note in the BM25 index. Reads
    /// the stored `note_id` + `mtime` fields on every doc — one doc per note, so
    /// cost is proportional to corpus size and it shares the same single index
    /// walk as [`Self::list_bm25_note_ids`]. Used at startup to skip the
    /// `read_to_string` + delete+add for notes whose file mtime hasn't moved
    /// past what's already indexed (the BM25 equivalent of SPLADE's
    /// `should_skip` gate) — without it every launch re-indexes the whole vault.
    pub fn bm25_note_mtimes(&self) -> Result<HashMap<String, i64>, String> {
        use tantivy::collector::DocSetCollector;
        use tantivy::query::AllQuery;
        let searcher = self.bm25_reader.searcher();
        let doc_addrs = searcher
            .search(&AllQuery, &DocSetCollector)
            .map_err(|e| format!("list bm25 docs: {e}"))?;
        let mut out = HashMap::with_capacity(doc_addrs.len());
        for addr in doc_addrs {
            let doc: TantivyDocument = searcher
                .doc(addr)
                .map_err(|e| format!("bm25 doc fetch: {e}"))?;
            if let Some(note_id) = read_stored_text(&doc, self.bm25_schema.note_id) {
                let mtime = read_stored_i64(&doc, self.bm25_schema.mtime).unwrap_or(0);
                out.insert(note_id, mtime);
            }
        }
        Ok(out)
    }

    pub fn commit_bm25(&mut self) -> Result<(), String> {
        self.bm25_writer
            .commit()
            .map(|_| ())
            .map_err(|e| format!("bm25 commit: {e}"))?;
        self.bm25_reader
            .reload()
            .map_err(|e| format!("bm25 reader reload: {e}"))
    }

    pub fn commit_splade(&mut self) -> Result<(), String> {
        self.splade_writer
            .commit()
            .map(|_| ())
            .map_err(|e| format!("splade commit: {e}"))?;
        self.splade_reader
            .reload()
            .map_err(|e| format!("splade reader reload: {e}"))
    }

    /// Top-K BM25 hits for `query`. Empty query returns empty.
    pub fn search_bm25(&self, query: &str, k: usize) -> Result<Vec<(String, f32)>, String> {
        if query.trim().is_empty() {
            return Ok(vec![]);
        }
        let searcher = self.bm25_reader.searcher();
        let parser = QueryParser::for_index(
            &self.bm25,
            vec![
                self.bm25_schema.title,
                self.bm25_schema.body,
                self.bm25_schema.tags,
                self.bm25_schema.folder,
            ],
        );
        // QueryParser parse errors are usually syntax issues from user input;
        // fall back to a simple-text query by escaping wildcards.
        let q = match parser.parse_query(query) {
            Ok(q) => q,
            Err(_) => {
                let cleaned = query.replace(|c: char| !c.is_alphanumeric() && c != ' ', " ");
                parser
                    .parse_query(&cleaned)
                    .map_err(|e| format!("query parse: {e}"))?
            }
        };
        let top = searcher
            .search(&q, &TopDocs::with_limit(k).order_by_score())
            .map_err(|e| format!("bm25 search: {e}"))?;
        let mut hits = Vec::with_capacity(top.len());
        for (score, addr) in top {
            let doc: TantivyDocument = searcher
                .doc(addr)
                .map_err(|e| format!("bm25 doc fetch: {e}"))?;
            if let Some(note_id) = read_stored_text(&doc, self.bm25_schema.note_id) {
                hits.push((note_id, score));
            }
        }
        Ok(hits)
    }

    /// Snapshot of indexed note count in the BM25 index (cheap; reads segment
    /// counts). Part of the index handle's API for host diagnostics; not yet
    /// wired through `SearchEngine`.
    #[allow(dead_code)]
    pub fn bm25_num_docs(&self) -> u64 {
        self.bm25_reader.searcher().num_docs()
    }
}

/// Build the pre-tokenized SPLADE representation. Each token appears
/// `round(weight * SPLADE_SCALE)` times so the Tantivy term-frequency
/// equals the quantized weight (the field is indexed `WithFreqs`, no
/// positions — Tantivy counts repeats and that becomes the score input).
///
/// Hot path during backfill: a 103-note vault with ~3 chunks/note and
/// ~150 expansion-terms/chunk produces ~46k Token allocations even at
/// SCALE=32. Keep this loop tight — no offset bookkeeping (we don't do
/// positional queries or highlighting on SPLADE terms) and a single
/// pre-allocated `Vec`.
#[cfg(feature = "semantic")]
fn build_splade_pretokenized(vec: &SpladeSparseVec) -> PreTokenizedString {
    use tantivy::tokenizer::Token;
    let est = vec.indices.len() * (SPLADE_SCALE as usize / 2);
    let mut tokens: Vec<Token> = Vec::with_capacity(est);
    let mut text_buf = String::with_capacity(vec.indices.len() * 6);
    for (&idx, &weight) in vec.indices.iter().zip(vec.values.iter()) {
        let quantized = (weight * SPLADE_SCALE).round() as i64;
        if quantized <= 0 {
            continue;
        }
        // Append once to the field text (offsets unused by WithFreqs but
        // required by PreTokenizedString to be non-empty + ordered).
        let start = text_buf.len();
        let text = format!("t{}", idx);
        text_buf.push_str(&text);
        let end = text_buf.len();
        text_buf.push(' ');
        // All repeats share the same offsets and position. Tantivy's posting
        // writer (`WithFreqs`) only reads token.text and counts occurrences.
        for _ in 0..quantized {
            tokens.push(Token {
                offset_from: start,
                offset_to: end,
                position: 0,
                text: text.clone(),
                position_length: 1,
            });
        }
    }
    PreTokenizedString { text: text_buf, tokens }
}

fn read_stored_text(doc: &TantivyDocument, field: Field) -> Option<String> {
    use tantivy::schema::Value;
    doc.get_first(field)
        .and_then(|v| v.as_str().map(|s| s.to_string()))
}

fn read_stored_i64(doc: &TantivyDocument, field: Field) -> Option<i64> {
    use tantivy::schema::Value;
    doc.get_first(field).and_then(|v| v.as_i64())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    /// Auto-cleanup wrapper around a one-shot temp dir under
    /// `std::env::temp_dir()`. Mirrors `core::tests::temp_notes_dir` so we
    /// don't pull tempfile in just for tests.
    struct ScopedTempDir(PathBuf);
    impl ScopedTempDir {
        fn new() -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let ms = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let dir = std::env::temp_dir().join(format!("futo-search-test-{ms}-{n}"));
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

    fn open_indices_in_tempdir() -> (ScopedTempDir, TantivyIndices) {
        let dir = ScopedTempDir::new();
        let idx = TantivyIndices::open(dir.path()).expect("open");
        (dir, idx)
    }

    #[test]
    fn write_version_atomically_persists_content_and_leaves_no_tmp() {
        let dir = ScopedTempDir::new();
        let path = dir.path().join("splade.version");
        write_version_atomically(&path, "v9-test").unwrap();
        let read = std::fs::read_to_string(&path).unwrap();
        assert_eq!(read, "v9-test");
        let tmp = path.with_extension("version.tmp");
        assert!(!tmp.exists(), "tmp file should be removed on success");
    }

    #[test]
    fn version_marker_triggers_rebuild_on_mismatch() {
        let dir = ScopedTempDir::new();
        std::fs::create_dir_all(dir.path().join("splade")).unwrap();
        std::fs::write(dir.path().join("splade-progress.json"), b"{}").unwrap();
        std::fs::write(dir.path().join("splade.version"), b"v1-old").unwrap();
        // Sanity: stale files present before open.
        assert!(dir.path().join("splade-progress.json").exists());
        let _idx = TantivyIndices::open(dir.path()).expect("open should succeed");
        // After open, the stale progress file is gone (rebuild was forced)
        // and the version file matches the current SPLADE_INDEX_VERSION.
        assert!(!dir.path().join("splade-progress.json").exists());
        let v = std::fs::read_to_string(dir.path().join("splade.version")).unwrap();
        assert_eq!(v, SPLADE_INDEX_VERSION);
    }

    #[test]
    fn list_bm25_note_ids_returns_committed_notes_only() {
        let (_dir, mut idx) = open_indices_in_tempdir();
        idx.upsert_note_bm25("alpha", "Alpha", "body", "", "", 0);
        idx.upsert_note_bm25("beta", "Beta", "body", "", "", 0);
        // Uncommitted: should not appear yet.
        let before = idx.list_bm25_note_ids().unwrap();
        assert!(before.is_empty(), "uncommitted upserts are invisible to the reader");
        idx.commit_bm25().unwrap();
        let mut after = idx.list_bm25_note_ids().unwrap();
        after.sort();
        assert_eq!(after, vec!["alpha".to_string(), "beta".to_string()]);
    }

    #[test]
    fn bm25_note_mtimes_returns_committed_mtimes() {
        let (_dir, mut idx) = open_indices_in_tempdir();
        idx.upsert_note_bm25("alpha", "Alpha", "body", "", "", 1_000);
        idx.upsert_note_bm25("beta", "Beta", "body", "", "", 2_000);
        // Uncommitted: invisible to the reader.
        assert!(idx.bm25_note_mtimes().unwrap().is_empty());
        idx.commit_bm25().unwrap();
        let m = idx.bm25_note_mtimes().unwrap();
        assert_eq!(m.get("alpha"), Some(&1_000));
        assert_eq!(m.get("beta"), Some(&2_000));
        assert_eq!(m.len(), 2);
        // Re-upsert with a newer mtime; reflected after commit.
        idx.upsert_note_bm25("alpha", "Alpha", "body2", "", "", 5_000);
        idx.commit_bm25().unwrap();
        assert_eq!(idx.bm25_note_mtimes().unwrap().get("alpha"), Some(&5_000));
    }

    #[test]
    fn delete_note_removes_from_subsequent_list() {
        let (_dir, mut idx) = open_indices_in_tempdir();
        idx.upsert_note_bm25("keep", "K", "x", "", "", 0);
        idx.upsert_note_bm25("drop", "D", "x", "", "", 0);
        idx.commit_bm25().unwrap();
        idx.delete_note("drop");
        idx.commit_bm25().unwrap();
        let ids = idx.list_bm25_note_ids().unwrap();
        assert_eq!(ids, vec!["keep".to_string()]);
    }
}
