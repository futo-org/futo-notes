//! A note the store saves exactly as typed (no final line ending added) syncs
//! once: neither device's next cycle sees a change, so a note never flips
//! between `abc` and `abc\n` across devices.

use futo_notes_editor::{DisplayOffset, DisplayRange, Revision};
use futo_notes_store::LocalNoteStore;

use crate::fault_injection::{FaultServer, Route};
use crate::journal::SyncRunJournal;
use crate::sync::cycle;

use super::*;

async fn run(state: &ConnectedState, root: &Path) -> ConnectedState {
    let (summary, after) = cycle(
        state,
        root,
        &no_progress,
        &no_pre_write,
        &SyncRunJournal::disabled(),
    )
    .await
    .unwrap();
    assert!(summary.failures.is_empty(), "{summary:?}");
    after
}

#[tokio::test]
async fn a_deleted_final_empty_line_is_pushed_once_and_stays_deleted() {
    let root = TempRoot::new();
    let server = FaultServer::new()
        .note(&KEY, "obj", 1, "note.md", "abc\n")
        .start();
    let state = synced_notes(
        root.path(),
        &server.base_url,
        &[("note.md", "obj", "abc\n")],
    );
    let store = LocalNoteStore::new(root.path().to_owned());
    let mut editor = store.open_editor("note").unwrap();
    let last_line = DisplayRange {
        start: DisplayOffset(3),
        end: DisplayOffset(4),
    };
    editor.replace(Revision(0), last_line, "").unwrap();
    editor.checkpoint().unwrap();
    drop(editor);
    assert_eq!(
        std::fs::read_to_string(root.path().join("note.md")).unwrap(),
        "abc"
    );

    let state = run(&state, root.path()).await;
    assert_eq!(server.requests(Route::UpdateObject), 1);
    run(&state, root.path()).await;
    assert_eq!(
        server.requests(Route::UpdateObject),
        1,
        "the second cycle pushes nothing"
    );
    assert_eq!(server.requests(Route::CreateObject), 0);
    assert_eq!(
        std::fs::read_to_string(root.path().join("note.md")).unwrap(),
        "abc"
    );
}

#[tokio::test]
async fn a_peers_note_without_a_final_line_ending_is_pulled_once_and_opening_it_writes_nothing() {
    let root = TempRoot::new();
    // The peer saved `abc` over the `abc\n` this device last synced.
    let server = FaultServer::new()
        .note(&KEY, "obj", 2, "note.md", "abc")
        .start();
    let mut state = synced_notes(
        root.path(),
        &server.base_url,
        &[("note.md", "obj", "abc\n")],
    );
    // This device holds the object's earlier blob.
    state.object_map.get_mut("note.md").unwrap().blob_key = "obj-blob-earlier".into();
    checkpoint::save(root.path(), &state).unwrap();

    let state = run(&state, root.path()).await;
    assert_eq!(
        std::fs::read_to_string(root.path().join("note.md")).unwrap(),
        "abc"
    );
    let store = LocalNoteStore::new(root.path().to_owned());
    let mut editor = store.open_editor("note").unwrap();
    assert_eq!(editor.source_text(), "abc");
    assert_eq!(editor.checkpoint().unwrap().mutation, None);
    drop(editor);
    run(&state, root.path()).await;
    assert_eq!(
        server.requests(Route::UpdateObject),
        0,
        "nothing to push back"
    );
    assert_eq!(server.requests(Route::CreateObject), 0);
    assert_eq!(
        std::fs::read_to_string(root.path().join("note.md")).unwrap(),
        "abc"
    );
}
