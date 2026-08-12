//! Tantivy index handles for BM25 keyword search.

use std::collections::HashMap;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use tantivy::collector::TopDocs;
use tantivy::query::{BooleanQuery, BoostQuery, FuzzyTermQuery, Occur, Query, QueryParser};
use tantivy::schema::{
    Field, IndexRecordOption, Schema, TextFieldIndexing, TextOptions, FAST, INDEXED, STORED, STRING,
};
use tantivy::{
    DocId, Index, IndexReader, IndexWriter, ReloadPolicy, Score, SegmentReader, TantivyDocument,
    Term,
};

/// Boost on title-field matches. Titles are what users search for most, and
/// per-field BM25 gives a note whose short body repeats a word more score
/// than a note whose title IS the word; this counterweights that.
const TITLE_BOOST: f32 = 2.0;

/// Recency multiplier: a just-edited note scores up to (1 + RECENCY_WEIGHT)×
/// its BM25 score, decaying by half every RECENCY_HALF_LIFE_DAYS. Bounded and
/// multiplicative, so it reorders comparable matches (a daily note titled
/// "August 10, 2026" vs one from 2022) without letting a fresh-but-irrelevant
/// note beat a strong exact match.
const RECENCY_WEIGHT: f32 = 1.0;
const RECENCY_HALF_LIFE_DAYS: f32 = 30.0;
const MS_PER_DAY: f32 = 86_400_000.0;

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

    #[cfg(test)]
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

        // A query ending mid-word is search-as-you-type: its last word
        // matches as a prefix ("Aug" finds "August"). Trailing whitespace or
        // punctuation means the user finished the word, so it matches as
        // typed — which is why callers must not trim the query's tail.
        let (head, prefix_word) = split_trailing_prefix(query);

        // Three passes, most precise first. Each falls through only when the
        // previous one found nothing, so the cheap common case stays one pass
        // and no pass can ever shadow a better one's results.
        //
        // 1. ALL words required. BM25 alone scores a short note matching one
        //    query word above a long note matching every word, so a pure
        //    should-clause parse buried the only both-words note outside the
        //    top 10 in 18 of 20 measured cases.
        // 2. ANY word, for queries no single note satisfies (long natural
        //    questions, a stray stop word).
        // 3. Edit-distance 1, for a typo. Without it one wrong character
        //    returns an empty list, which reads as "you have no such note".
        let mut top = self.run_pass(&searcher, query, head, prefix_word, k, Pass::AllWords)?;
        if top.is_empty() {
            top = self.run_pass(&searcher, query, head, prefix_word, k, Pass::AnyWord)?;
        }
        if top.is_empty() {
            top = self.run_pass(&searcher, query, head, prefix_word, k, Pass::Fuzzy)?;
        }

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

    /// One retrieval pass. The head (every completed word) goes through the
    /// QueryParser; a trailing mid-typing word becomes a prefix clause joined
    /// with the pass's own occurrence (Must for AllWords, Should for AnyWord).
    /// A query neither parse survives yields no hits rather than an error, so
    /// a later, looser pass still gets its turn.
    fn run_pass(
        &self,
        searcher: &tantivy::Searcher,
        raw_query: &str,
        head: &str,
        prefix_word: Option<&str>,
        k: usize,
        pass: Pass,
    ) -> Result<Vec<(f32, tantivy::DocAddress)>, String> {
        let fields = vec![
            self.bm25_schema.title,
            self.bm25_schema.body,
            self.bm25_schema.tags,
            self.bm25_schema.folder,
        ];
        let mut parser = QueryParser::for_index(&self.bm25, fields.clone());
        parser.set_field_boost(self.bm25_schema.title, TITLE_BOOST);

        let parsed: Option<Box<dyn Query>> = match pass {
            Pass::AllWords | Pass::AnyWord => {
                let occur = match pass {
                    Pass::AllWords => {
                        parser.set_conjunction_by_default();
                        Occur::Must
                    }
                    _ => Occur::Should,
                };
                let mut clauses: Vec<(Occur, Box<dyn Query>)> = Vec::new();
                if let Some(head_query) = parse_lenient(&parser, head) {
                    clauses.push((occur, head_query));
                }
                if let Some(word) = prefix_word {
                    clauses.push((occur, self.prefix_word_query(word)));
                }
                match clauses.len() {
                    0 => None,
                    1 => Some(clauses.remove(0).1),
                    _ => Some(Box::new(BooleanQuery::new(clauses))),
                }
            }
            Pass::Fuzzy => {
                for field in &fields {
                    // (prefix = false, distance = 1, transposition costs 1)
                    parser.set_field_fuzzy(*field, false, 1, true);
                }
                parse_lenient(&parser, raw_query)
            }
        };
        let Some(parsed) = parsed else {
            return Ok(vec![]);
        };

        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let collector =
            TopDocs::with_limit(k).tweak_score(move |segment_reader: &SegmentReader| {
                let mtimes = segment_reader.fast_fields().i64("mtime").ok();
                move |doc: DocId, score: Score| {
                    let mtime_ms = mtimes.as_ref().and_then(|c| c.first(doc)).unwrap_or(0);
                    // Unset mtime (0) decays to a ~1.0 multiplier, i.e. plain BM25.
                    let age_days = ((now_ms - mtime_ms).max(0) as f32) / MS_PER_DAY;
                    let freshness =
                        (-age_days * std::f32::consts::LN_2 / RECENCY_HALF_LIFE_DAYS).exp();
                    score * (1.0 + RECENCY_WEIGHT * freshness)
                }
            });
        searcher
            .search(&parsed, &collector)
            .map_err(|e| format!("bm25 search: {e}"))
    }

    /// One should-clause per field matching any indexed term that starts with
    /// `word` (case-folded to mirror the default tokenizer). Prefix hits score
    /// a constant (boosted for title), so among prefix-only matches the
    /// recency tweak decides the order — which is what an as-you-type result
    /// list should do.
    fn prefix_word_query(&self, word: &str) -> Box<dyn Query> {
        let lowered = word.to_lowercase();
        let mut clauses: Vec<(Occur, Box<dyn Query>)> = Vec::new();
        for field in [
            self.bm25_schema.title,
            self.bm25_schema.body,
            self.bm25_schema.tags,
            self.bm25_schema.folder,
        ] {
            let term = Term::from_field_text(field, &lowered);
            let mut q: Box<dyn Query> = Box::new(FuzzyTermQuery::new_prefix(term, 0, true));
            if field == self.bm25_schema.title {
                q = Box::new(BoostQuery::new(q, TITLE_BOOST));
            }
            clauses.push((Occur::Should, q));
        }
        Box::new(BooleanQuery::new(clauses))
    }
}

/// Parse through the QueryParser, retrying a rejected query (unbalanced
/// quote, bare operator) with non-alphanumerics stripped.
fn parse_lenient(parser: &QueryParser, query: &str) -> Option<Box<dyn Query>> {
    if query.trim().is_empty() {
        return None;
    }
    parser.parse_query(query).ok().or_else(|| {
        let cleaned = query.replace(|c: char| !c.is_alphanumeric() && c != ' ', " ");
        if cleaned.trim().is_empty() {
            return None;
        }
        parser.parse_query(&cleaned).ok()
    })
}

/// Split a query into a parseable head and the word still being typed. The
/// last word counts as in-progress only when the query ends mid-word: any
/// trailing whitespace or punctuation means the user completed it. A tail
/// glued to punctuation ("folder-sco") is NOT split — the QueryParser owns
/// hyphen compounds as adjacent phrases, and splitting would silently turn
/// the phrase into two independent words.
fn split_trailing_prefix(query: &str) -> (&str, Option<&str>) {
    match query.chars().last() {
        Some(c) if c.is_alphanumeric() => {}
        _ => return (query, None),
    }
    let start = query
        .char_indices()
        .rev()
        .take_while(|(_, c)| c.is_alphanumeric())
        .last()
        .map(|(i, _)| i)
        .unwrap_or(0);
    let head = &query[..start];
    match head.chars().last() {
        None => ((""), Some(query)),
        Some(c) if c.is_whitespace() => (head, Some(&query[start..])),
        Some(_) => (query, None),
    }
}

/// Retrieval strictness for one [`TantivyIndices::run_pass`] call.
#[derive(Clone, Copy)]
enum Pass {
    /// Every query word must appear in the note.
    AllWords,
    /// Any query word may match.
    AnyWord,
    /// Any query word may match within edit distance 1.
    Fuzzy,
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
        assert!(
            before.is_empty(),
            "uncommitted upserts are invisible to the reader"
        );
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

    fn now_ms() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }

    const FOUR_YEARS_MS: i64 = 4 * 365 * 86_400_000;

    #[test]
    fn last_word_matches_as_prefix_while_typing() {
        let (_dir, mut idx) = open_indices_in_tempdir();
        idx.upsert_note_bm25("august", "August 10, 2026", "daily entry", "", "", now_ms());
        idx.upsert_note_bm25("groceries", "Groceries", "milk eggs", "", "", now_ms());
        idx.commit_bm25().unwrap();
        let hits = idx.search_bm25("Aug", 10).unwrap();
        assert_eq!(
            hits.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(),
            vec!["august"],
            "a mid-typing word must match titles it prefixes"
        );
    }

    #[test]
    fn trailing_space_ends_the_word_so_no_prefix_expansion() {
        let (_dir, mut idx) = open_indices_in_tempdir();
        idx.upsert_note_bm25("august", "August 10, 2026", "daily entry", "", "", now_ms());
        idx.commit_bm25().unwrap();
        assert!(
            idx.search_bm25("Aug ", 10).unwrap().is_empty(),
            "a completed word matches as typed, not as a prefix"
        );
    }

    #[test]
    fn prefix_composes_with_the_all_words_pass() {
        let (_dir, mut idx) = open_indices_in_tempdir();
        idx.upsert_note_bm25("list", "Grocery list", "weekly shop", "", "", now_ms());
        idx.upsert_note_bm25("bills", "Grocery bills", "utilities", "", "", now_ms());
        idx.commit_bm25().unwrap();
        let hits = idx.search_bm25("grocery li", 10).unwrap();
        assert_eq!(
            hits.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(),
            vec!["list"],
            "completed words stay required while the last word prefixes"
        );
    }

    #[test]
    fn recent_note_outranks_stale_note_on_an_equal_match() {
        let (_dir, mut idx) = open_indices_in_tempdir();
        let now = now_ms();
        idx.upsert_note_bm25(
            "old",
            "meeting notes",
            "same body",
            "",
            "",
            now - FOUR_YEARS_MS,
        );
        idx.upsert_note_bm25("new", "meeting notes", "same body", "", "", now);
        idx.commit_bm25().unwrap();
        let hits = idx.search_bm25("meeting", 10).unwrap();
        assert_eq!(hits[0].0, "new", "recency must break BM25 ties: {hits:?}");
        assert_eq!(hits.len(), 2);
    }

    #[test]
    fn title_match_outranks_body_only_match() {
        let (_dir, mut idx) = open_indices_in_tempdir();
        let now = now_ms();
        idx.upsert_note_bm25("titled", "zebra", "some daily entry", "", "", now);
        idx.upsert_note_bm25("body", "randoms", "zebra spotted today", "", "", now);
        idx.commit_bm25().unwrap();
        let hits = idx.search_bm25("zebra", 10).unwrap();
        assert_eq!(
            hits[0].0, "titled",
            "title hits outrank body hits: {hits:?}"
        );
        assert_eq!(hits.len(), 2);
    }

    #[test]
    fn recent_title_match_beats_old_body_heavy_note() {
        // The reported regression: a 2022 note repeating the word in a short
        // body outranked a fresh daily note whose TITLE contains it.
        let (_dir, mut idx) = open_indices_in_tempdir();
        let now = now_ms();
        idx.upsert_note_bm25(
            "old-2022",
            "randoms",
            "august august august august",
            "",
            "",
            now - FOUR_YEARS_MS,
        );
        idx.upsert_note_bm25("daily", "August 10, 2026", "daily entry", "", "", now);
        idx.commit_bm25().unwrap();
        let hits = idx.search_bm25("August", 10).unwrap();
        assert_eq!(hits[0].0, "daily", "fresh title match must win: {hits:?}");
    }

    #[test]
    fn split_trailing_prefix_splits_only_mid_word_tails() {
        assert_eq!(split_trailing_prefix("Aug"), ("", Some("Aug")));
        assert_eq!(
            split_trailing_prefix("grocery li"),
            ("grocery ", Some("li"))
        );
        assert_eq!(split_trailing_prefix("Aug "), ("Aug ", None));
        assert_eq!(split_trailing_prefix("aug."), ("aug.", None));
        assert_eq!(split_trailing_prefix(""), ("", None));
        // A tail glued to punctuation stays with the parser so hyphen
        // compounds keep their adjacent-phrase semantics.
        assert_eq!(split_trailing_prefix("folder-sco"), ("folder-sco", None));
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
