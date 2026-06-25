//! Tantivy index handles for BM25 keyword search.

use std::collections::HashMap;
use std::path::Path;

use tantivy::collector::{Collector, TopDocs};
use tantivy::query::QueryParser;
use tantivy::schema::{
    Field, IndexRecordOption, Schema, TextFieldIndexing, TextOptions, FAST, INDEXED, STORED,
    STRING,
};
use tantivy::{Index, IndexReader, IndexWriter, ReloadPolicy, TantivyDocument, Term};

// Silence unused-import warnings: Collector trait import is required for
// `Searcher::search` to recognize `TopDocs` as a Collector.
#[allow(dead_code)]
fn _collector_in_scope<C: Collector>() {}

pub struct Bm25Schema {
    pub note_id: Field,
    pub title: Field,
    pub body: Field,
    pub tags: Field,
    pub folder: Field,
    pub mtime: Field,
}

impl Bm25Schema {
    fn build() -> (Schema, Self) {
        let mut sb = Schema::builder();
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
        let mtime = sb.add_i64_field("mtime", FAST | STORED | INDEXED);
        let schema = sb.build();
        (
            schema,
            Self {
                note_id,
                title,
                body,
                tags,
                folder,
                mtime,
            },
        )
    }
}

pub struct TantivyIndices {
    pub bm25: Index,
    pub bm25_schema: Bm25Schema,
    pub bm25_writer: IndexWriter,
    pub bm25_reader: IndexReader,
}

impl TantivyIndices {
    pub fn open(index_root: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(index_root).map_err(|e| format!("mkdir search root: {e}"))?;
        cleanup_old_splade_index(index_root)?;

        let bm25_dir = index_root.join("bm25");
        std::fs::create_dir_all(&bm25_dir).map_err(|e| format!("mkdir bm25: {e}"))?;

        let (schema, bm25_schema) = Bm25Schema::build();
        let bm25 = Index::open_or_create(
            tantivy::directory::MmapDirectory::open(&bm25_dir)
                .map_err(|e| format!("open bm25 dir: {e}"))?,
            schema,
        )
        .map_err(|e| format!("open bm25 index: {e}"))?;

        let bm25_writer = bm25
            .writer(50_000_000)
            .map_err(|e| format!("bm25 writer: {e}"))?;
        let bm25_reader = bm25
            .reader_builder()
            .reload_policy(ReloadPolicy::Manual)
            .try_into()
            .map_err(|e| format!("bm25 reader: {e}"))?;

        Ok(Self {
            bm25,
            bm25_schema,
            bm25_writer,
            bm25_reader,
        })
    }

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

    pub fn delete_note(&mut self, note_id: &str) {
        let term = Term::from_field_text(self.bm25_schema.note_id, note_id);
        let _ = self.bm25_writer.delete_term(term);
    }

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

    #[allow(dead_code)]
    pub fn bm25_num_docs(&self) -> u64 {
        self.bm25_reader.searcher().num_docs()
    }
}

fn cleanup_old_splade_index(index_root: &Path) -> Result<(), String> {
    for file in ["splade-progress.json", "splade.version"] {
        match std::fs::remove_file(index_root.join(file)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("remove stale {file}: {e}")),
        }
    }
    match std::fs::remove_dir_all(index_root.join("splade")) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("remove stale splade dir: {e}")),
    }
    Ok(())
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
    fn open_removes_old_splade_sidecars() {
        let dir = ScopedTempDir::new();
        std::fs::create_dir_all(dir.path().join("splade")).unwrap();
        std::fs::write(dir.path().join("splade-progress.json"), b"{}").unwrap();
        std::fs::write(dir.path().join("splade.version"), b"v2").unwrap();

        let _idx = TantivyIndices::open(dir.path()).expect("open should succeed");

        assert!(!dir.path().join("splade").exists());
        assert!(!dir.path().join("splade-progress.json").exists());
        assert!(!dir.path().join("splade.version").exists());
    }

    #[test]
    fn list_bm25_note_ids_returns_committed_notes_only() {
        let (_dir, mut idx) = open_indices_in_tempdir();
        idx.upsert_note_bm25("alpha", "Alpha", "body", "", "", 0);
        idx.upsert_note_bm25("beta", "Beta", "body", "", "", 0);
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
        assert!(idx.bm25_note_mtimes().unwrap().is_empty());
        idx.commit_bm25().unwrap();
        let m = idx.bm25_note_mtimes().unwrap();
        assert_eq!(m.get("alpha"), Some(&1_000));
        assert_eq!(m.get("beta"), Some(&2_000));
        assert_eq!(m.len(), 2);
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
