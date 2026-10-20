//! The mobile wire shape: every record built and destructured without `..`.

use futo_notes_ffi::{
    FlushDisposition, FlushDraftResult, NoteBootstrap, NoteMetadata, NoteMutation, NoteSnapshot,
    NoteStore, SearchHit, TitleIssue,
};

/// Compile-time only: every record is built and destructured without `..`, so
/// adding, removing or renaming a field on the mobile wire shape breaks this
/// file and forces the shells' side of the change to be looked at. The values
/// themselves are exercised with real store output by the tests above.
#[test]
fn note_records_and_threading_keep_the_full_semantic_shape() {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<NoteStore>();

    let NoteMetadata {
        id: _,
        title: _,
        folder: _,
        modified_ms: _,
        preview: _,
        rich_preview: _,
        tags: _,
    } = NoteMetadata {
        id: "folder/note.md".to_owned(),
        title: "note".to_owned(),
        folder: "folder".to_owned(),
        modified_ms: 42,
        preview: "preview".to_owned(),
        rich_preview: "rich".to_owned(),
        tags: vec!["tag".to_owned()],
    };

    let NoteMutation {
        upserted: _,
        removed: _,
        folders: _,
        final_id: _,
        final_folder: _,
        relinked: _,
        final_body: _,
        warnings: _,
    } = NoteMutation {
        upserted: Vec::new(),
        removed: vec!["before.md".to_owned()],
        folders: vec!["folder".to_owned()],
        final_id: Some("after.md".to_owned()),
        final_folder: Some("folder".to_owned()),
        relinked: vec!["after.md".to_owned()],
        final_body: Some("body".to_owned()),
        warnings: vec!["warning".to_owned()],
    };

    let NoteBootstrap {
        snapshot: NoteSnapshot {
            notes: _,
            folders: _,
        },
        seeded: _,
        migrated: _,
        warnings: _,
    } = NoteBootstrap {
        snapshot: NoteSnapshot {
            notes: Vec::new(),
            folders: vec!["folder".to_owned()],
        },
        seeded: 1,
        migrated: 2,
        warnings: vec!["warning".to_owned()],
    };

    let FlushDraftResult {
        disposition: _,
        mutation: _,
    } = FlushDraftResult {
        disposition: FlushDisposition::ParkedConflict {
            parked_id: "note (conflict 2026-07-21)".to_owned(),
        },
        mutation: None,
    };

    let TitleIssue {
        kind: _,
        message: _,
    } = TitleIssue {
        kind: "empty".to_owned(),
        message: "message".to_owned(),
    };

    let SearchHit {
        note_id: _,
        score: _,
        source: _,
    } = SearchHit {
        note_id: "note.md".to_owned(),
        score: 1.25,
        source: "bm25".to_owned(),
    };
}
