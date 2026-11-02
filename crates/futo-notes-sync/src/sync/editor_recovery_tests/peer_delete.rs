//! A peer's delete of a note whose unsaved editor draft exists only in recovery.
use super::*;
use crate::fault_injection::Route;

fn mapped_to_peer(base_url: String, base: &str) -> ConnectedState {
    ConnectedState {
        base_url,
        token: "token".into(),
        user_id: "user".into(),
        collection_id: "collection".into(),
        vault_key: [5; 32],
        object_map: HashMap::from([(
            "plain.md".into(),
            E2eeObjectMapEntry {
                object_id: "peer".into(),
                version: 1,
                blob_key: "peer-blob".into(),
                hash: Some(hash_sha256(base)),
                mtime_ms: None,
                size_bytes: None,
            },
        )]),
        pending_creates: HashMap::new(),
        max_version: 0,
        pull_cursor: 0,
        oversize_skip: HashMap::new(),
    }
}

/// Edit wins over a peer delete: a detached draft is a local edit, so the note
/// stays under its own name, is re-uploaded as a fresh object, and its draft
/// checkpoints and syncs as an ordinary edit afterwards.
#[tokio::test]
async fn peer_delete_keeps_a_note_whose_only_edit_is_a_pending_editor_draft() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalNoteStore::new(root.path().to_owned());
    store.create("", "plain", "base").unwrap();
    {
        let mut editor = store.open_editor("plain").unwrap();
        editor
            .replace(
                Revision(0),
                DisplayRange {
                    start: DisplayOffset(4),
                    end: DisplayOffset(4),
                },
                "!",
            )
            .unwrap();
    }
    // Markdown still holds the base; the accepted edit lives only in recovery.
    assert_eq!(store.read("plain").unwrap(), "base");
    let server = FaultServer::new().tombstone("peer", 5).start();
    let state = mapped_to_peer(server.base_url.clone(), "base");

    let (summary, next) = crate::run_sync(&state, root.path(), &|_| {}, &|_| {})
        .await
        .unwrap();
    assert!(summary.failures.is_empty(), "{summary:?}");
    assert!(summary.deleted_ids.is_empty(), "{summary:?}");
    assert!(summary.peer_deleted_ids.is_empty(), "{summary:?}");
    assert_eq!(store.read("plain").unwrap(), "base");
    assert!(!next.object_map.contains_key("plain.md"));
    assert_eq!(
        next.pull_cursor, 5,
        "the tombstone is consumed, not retried"
    );
    let mut editor = store.open_editor("plain").unwrap();
    assert_eq!(editor.source_text(), "base!");

    // Next cycle re-creates it for the fleet; the delete never re-applies.
    let (summary, next) = crate::run_sync(&next, root.path(), &|_| {}, &|_| {})
        .await
        .unwrap();
    assert!(summary.failures.is_empty(), "{summary:?}");
    assert!(summary.deleted_ids.is_empty(), "{summary:?}");
    assert_eq!(server.requests(Route::CreateObject), 1);
    assert!(next.object_map.contains_key("plain.md"));
    assert_eq!(store.read("plain").unwrap(), "base");

    // The draft then checkpoints and syncs as a normal edit of the new object.
    editor.checkpoint().unwrap();
    assert_eq!(store.read("plain").unwrap(), "base!");
    let (summary, _) = crate::run_sync(&next, root.path(), &|_| {}, &|_| {})
        .await
        .unwrap();
    assert!(summary.failures.is_empty(), "{summary:?}");
    assert_eq!(server.requests(Route::UpdateObject), 1);
    assert_eq!(store.read("plain").unwrap(), "base!");
}

/// Without a pending draft the peer's delete still applies.
#[tokio::test]
async fn peer_delete_still_removes_a_note_with_no_pending_draft() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalNoteStore::new(root.path().to_owned());
    store.create("", "plain", "base").unwrap();
    let server = FaultServer::new().tombstone("peer", 5).start();
    let state = mapped_to_peer(server.base_url.clone(), "base");
    let (summary, _) = crate::run_sync(&state, root.path(), &|_| {}, &|_| {})
        .await
        .unwrap();
    assert_eq!(summary.deleted_ids, ["plain"]);
    assert!(!root.path().join("plain.md").exists());
}
