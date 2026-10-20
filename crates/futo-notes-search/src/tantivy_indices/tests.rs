use super::*;
use crate::test_support::ScopedTempDir;

fn open_indices_in_tempdir() -> (ScopedTempDir, TantivyIndices) {
    let dir = ScopedTempDir::new("indices");
    let idx = TantivyIndices::open(dir.path()).expect("open");
    (dir, idx)
}

#[test]
fn open_removes_old_splade_sidecars() {
    let dir = ScopedTempDir::new("indices");
    std::fs::create_dir_all(dir.path().join("splade")).unwrap();
    std::fs::write(dir.path().join("splade-progress.json"), b"{}").unwrap();
    std::fs::write(dir.path().join("splade.version"), b"v2").unwrap();

    let _idx = TantivyIndices::open(dir.path()).expect("open should succeed");

    assert!(!dir.path().join("splade").exists());
    assert!(!dir.path().join("splade-progress.json").exists());
    assert!(!dir.path().join("splade.version").exists());
}

#[test]
fn note_mtimes_exclude_replaced_and_deleted_documents_across_segments() {
    let (dir, mut idx) = open_indices_in_tempdir();
    // Keep segment boundaries deterministic, including tombstoned documents.
    idx.bm25_writer
        .set_merge_policy(Box::new(tantivy::merge_policy::NoMergePolicy));
    idx.upsert_note_bm25("旅行/日記", "日記", "old body", "", "旅行", 1_000);
    idx.upsert_note_bm25("deleted", "Deleted", "old body", "", "", 2_000);
    idx.upsert_note_bm25("unchanged", "Unchanged", "body", "", "", 0);
    idx.commit_bm25().unwrap();

    idx.upsert_note_bm25("旅行/日記", "日記", "new body", "", "旅行", 3_000);
    idx.delete_note("deleted");
    idx.upsert_note_bm25("new", "New", "new body", "", "", 4_000);
    idx.commit_bm25().unwrap();
    assert!(idx.bm25_reader.searcher().segment_readers().len() >= 2);

    // A later uncommitted mutation must not leak into reconciliation metadata.
    idx.upsert_note_bm25("pending", "Pending", "pending body", "", "", 5_000);
    let expected = HashMap::from([
        ("旅行/日記".to_owned(), 3_000),
        ("unchanged".to_owned(), 0),
        ("new".to_owned(), 4_000),
    ]);
    assert_eq!(idx.bm25_note_mtimes().unwrap(), expected);
    drop(idx);
    let reopened = TantivyIndices::open(dir.path()).unwrap();
    assert_eq!(reopened.bm25_note_mtimes().unwrap(), expected);
}

#[test]
fn committing_without_changes_leaves_the_persisted_index_untouched() {
    let (dir, mut idx) = open_indices_in_tempdir();
    let metadata_path = dir.path().join("bm25/meta.json");
    let empty_metadata = std::fs::read(&metadata_path).unwrap();
    idx.commit_bm25().unwrap();
    assert_eq!(std::fs::read(&metadata_path).unwrap(), empty_metadata);

    idx.upsert_note_bm25("alpha", "Alpha", "body", "", "", 1_000);
    idx.commit_bm25().unwrap();
    let committed_metadata = std::fs::read(&metadata_path).unwrap();
    assert_ne!(committed_metadata, empty_metadata);
    assert_eq!(idx.bm25_note_mtimes().unwrap().get("alpha"), Some(&1_000));

    idx.commit_bm25().unwrap();
    assert_eq!(std::fs::read(&metadata_path).unwrap(), committed_metadata);

    idx.delete_note("alpha");
    idx.commit_bm25().unwrap();
    assert!(idx.bm25_note_mtimes().unwrap().is_empty());
    let deleted_metadata = std::fs::read(&metadata_path).unwrap();
    idx.commit_bm25().unwrap();
    assert_eq!(std::fs::read(&metadata_path).unwrap(), deleted_metadata);
}

#[test]
fn a_failed_commit_retries_pending_changes_without_another_upsert() {
    let (dir, mut idx) = open_indices_in_tempdir();
    idx.upsert_note_bm25("alpha", "Alpha", "body", "", "", 1_000);
    let metadata_path = dir.path().join("bm25/meta.json");
    let backup = dir.path().join("original-meta.json");
    std::fs::rename(&metadata_path, &backup).unwrap();
    std::fs::create_dir(&metadata_path).unwrap();
    assert!(idx.commit_bm25().is_err(), "a directory blocks the commit");
    std::fs::remove_dir(&metadata_path).unwrap();
    std::fs::rename(&backup, &metadata_path).unwrap();

    idx.commit_bm25().unwrap();
    assert_eq!(idx.bm25_note_mtimes().unwrap().get("alpha"), Some(&1_000));
    drop(idx);
    let reopened = TantivyIndices::open(dir.path()).unwrap();
    assert_eq!(
        reopened.bm25_note_mtimes().unwrap().get("alpha"),
        Some(&1_000)
    );
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

const FOUR_YEARS_MS: i64 = 4 * 365 * 86_400_000;

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
fn no_stemming_yet_a_mid_typing_query_reaches_longer_forms() {
    // There is still no stemmer: nothing maps "meetings" onto "meeting".
    // What DOES reach the plural is the prefix rule, and only in the
    // direction where the query prefixes the indexed word — so the
    // behavior is asymmetric, not stemming.
    let (_dir, mut idx) = open_indices_in_tempdir();
    let now = now_ms();
    idx.upsert_note_bm25("singular", "Meeting notes", "one meeting", "", "", now);
    idx.upsert_note_bm25("plural", "Team schedule", "two meetings", "", "", now);
    idx.commit_bm25().unwrap();

    let mut mid_typing: Vec<String> = idx
        .search_bm25("meeting", 10)
        .unwrap()
        .into_iter()
        .map(|(id, _)| id)
        .collect();
    mid_typing.sort();
    assert_eq!(
        mid_typing,
        vec!["plural", "singular"],
        "mid-typing 'meeting' prefixes 'meetings', so the plural-only note is retrieved"
    );

    assert_eq!(
        idx.search_bm25("meeting ", 10)
            .unwrap()
            .iter()
            .map(|(id, _)| id.as_str())
            .collect::<Vec<_>>(),
        vec!["singular"],
        "a completed word matches as typed — no stemming reaches the plural"
    );

    assert_eq!(
        idx.search_bm25("meetings", 10)
            .unwrap()
            .iter()
            .map(|(id, _)| id.as_str())
            .collect::<Vec<_>>(),
        vec!["plural"],
        "the asymmetry: the longer query does not reach the shorter word"
    );
}

#[test]
fn prefix_only_match_can_outrank_an_exact_match_until_the_word_ends() {
    // Inside the prefix path every matching term scores a constant, so
    // BM25 term relevance is discarded and only the title boost plus
    // recency order the list. A note that merely PREFIXES the query word
    // can therefore beat one containing it exactly — until the trailing
    // space completes the word. Both notes share one mtime so recency
    // cannot explain the order.
    let (_dir, mut idx) = open_indices_in_tempdir();
    let now = now_ms();
    idx.upsert_note_bm25(
        "snack",
        "Snack list",
        "buy cat food and cat litter",
        "",
        "",
        now,
    );
    idx.upsert_note_bm25(
        "category",
        "Category ideas",
        "category ideas and catalog",
        "",
        "",
        now,
    );
    idx.commit_bm25().unwrap();

    let mid_typing = idx.search_bm25("cat", 10).unwrap();
    assert_eq!(
        mid_typing
            .iter()
            .map(|(id, _)| id.as_str())
            .collect::<Vec<_>>(),
        vec!["category", "snack"],
        "prefix-only ordering is title-boost + recency, not term relevance: {mid_typing:?}"
    );

    let completed = idx.search_bm25("cat ", 10).unwrap();
    assert_eq!(
        completed
            .iter()
            .map(|(id, _)| id.as_str())
            .collect::<Vec<_>>(),
        vec!["snack"],
        "completing the word restores exact matching: {completed:?}"
    );
}

#[test]
fn a_longer_query_reaches_a_shorter_word_only_through_the_fuzzy_last_resort() {
    // Companion to no_stemming_yet_a_mid_typing_query_reaches_longer_forms:
    // prefixing runs one way, so "meetings" cannot prefix-match
    // "meeting". When nothing else matches at all, the
    // edit-distance-1 pass still finds it — which is the fuzzy fallback
    // doing its job, not stemming. Asserted in a vault where "meetings"
    // appears nowhere, so no earlier pass can satisfy the query.
    let (_dir, mut idx) = open_indices_in_tempdir();
    idx.upsert_note_bm25("singular", "Meeting notes", "one meeting", "", "", now_ms());
    idx.commit_bm25().unwrap();
    for query in ["meetings", "meetings "] {
        assert_eq!(
            idx.search_bm25(query, 10)
                .unwrap()
                .iter()
                .map(|(id, _)| id.as_str())
                .collect::<Vec<_>>(),
            vec!["singular"],
            "{query:?} reaches the shorter word via edit distance 1"
        );
    }
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
