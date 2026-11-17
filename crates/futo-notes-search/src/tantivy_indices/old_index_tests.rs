//! An index written by an older Tantivy keeps working after the dependency
//! moves. `fixtures/index-tantivy-0.26/` was written by this crate's own
//! `TantivyIndices` while it linked tantivy 0.26.2 (three notes over two
//! commits; index format version 7), so it is the on-disk layout users have.
//! Nothing rebuilds an index Tantivy refuses to open: `TantivyIndices::open`
//! fails and the store retries the same open on a cooldown, so an unreadable
//! old index would mean search never comes back. This test is the guard.

use std::collections::HashMap;
use std::path::Path;

use super::TantivyIndices;
use crate::test_support::ScopedTempDir;

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).unwrap();
        }
    }
}

fn ids(hits: Vec<(String, f32)>) -> Vec<String> {
    hits.into_iter().map(|(id, _)| id).collect()
}

#[test]
fn an_index_written_by_tantivy_0_26_opens_searches_and_takes_writes() {
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/index-tantivy-0.26");
    let root = ScopedTempDir::new("old-index");
    copy_dir(&fixture, root.path());

    let mut idx = TantivyIndices::open(root.path()).expect("open the 0.26 index");
    assert_eq!(
        idx.bm25_note_mtimes().unwrap(),
        HashMap::from([
            ("grocery list.md".to_string(), 1_700_000_000_000),
            ("journal/2026-08-10.md".to_string(), 1_786_000_000_000),
            ("work/standup.md".to_string(), 1_720_000_000_000),
        ])
    );
    assert_eq!(
        ids(idx.search_bm25("flour", 10).unwrap()),
        ["grocery list.md"]
    );
    assert_eq!(
        ids(idx.search_bm25("tantivy upgrade", 10).unwrap()),
        ["work/standup.md"]
    );
    assert_eq!(
        ids(idx.search_bm25("Aug", 10).unwrap())[0],
        "journal/2026-08-10.md"
    );

    // Replacing an old document writes a delete against a 0.26 segment.
    idx.upsert_note_bm25(
        "grocery list.md",
        "grocery list",
        "oat milk",
        "food",
        "",
        1_800_000_000_000,
    );
    idx.commit_bm25().unwrap();
    drop(idx);

    let idx = TantivyIndices::open(root.path()).expect("reopen after a write");
    assert!(idx.search_bm25("flour", 10).unwrap().is_empty());
    assert_eq!(
        ids(idx.search_bm25("oat", 10).unwrap()),
        ["grocery list.md"]
    );
    assert_eq!(idx.bm25_note_mtimes().unwrap().len(), 3);
}
