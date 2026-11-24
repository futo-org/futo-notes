//! A peer's rename arriving in a live cycle, onto a name the client already
//! holds as an unmapped copy of the note.

use super::*;

fn mapped(object_id: &str, content: &str) -> crate::checkpoint::ObjectState {
    crate::checkpoint::ObjectState {
        object_id: object_id.into(),
        version: 0,
        blob_key: "old-blob".into(),
        hash: Some(futo_notes_core::hash::hash_sha256(content)),
        mtime_ms: None,
        size_bytes: None,
    }
}

async fn cycle(state: ConnectedState, root: &Path) -> (SyncSummary, ConnectedState) {
    let state = Arc::new(Mutex::new(Some(state)));
    let gate = Arc::new(Mutex::new(()));
    let summary = run_with_checkpoint(
        &state,
        &gate,
        root,
        &|_: crate::sync::SyncProgress| {},
        &|_: &str| {},
        &checkpoint::save,
        &SyncRunJournal::disabled(),
    )
    .await
    .unwrap();
    let next = state.lock().await.clone().unwrap();
    (summary, next)
}

/// Push runs before pull, and cannot see that the server renamed the note: the
/// unmapped copy at the new name went up as a second object, which a fresh
/// client then downloaded beside the renamed note as a conflict copy.
#[tokio::test]
async fn a_peers_rename_onto_an_unmapped_copy_adopts_it_without_a_second_object() {
    let root = TempRoot::new();
    std::fs::write(root.0.join("old.md"), "body").unwrap();
    std::fs::write(root.0.join("new.md"), "body").unwrap();
    let mut state = connected();
    let server = MutationServer::with_remote_note(&state.vault_key, "new.md", "body");
    state.base_url = server.base_url.clone();
    state
        .object_map
        .insert("old.md".into(), mapped("remote-object", "body"));

    let (summary, next) = cycle(state, &root.0).await;

    assert_eq!(server.posts.load(Ordering::Relaxed), 0);
    assert!(summary.failures.is_empty(), "{:?}", summary.failures);
    assert!(!root.0.join("old.md").exists());
    assert_eq!(
        std::fs::read_to_string(root.0.join("new.md")).unwrap(),
        "body"
    );
    assert_eq!(next.object_map.keys().collect::<Vec<_>>(), ["new.md"]);
    assert!(next.pending_creates.is_empty());
}

/// The copy is held back only until the pull has said whether the server moved
/// the note: when it did not, the same cycle uploads it as the new note it is.
#[tokio::test]
async fn an_unmapped_copy_nobody_renamed_is_still_uploaded_in_the_same_cycle() {
    let root = TempRoot::new();
    std::fs::write(root.0.join("old.md"), "body").unwrap();
    std::fs::write(root.0.join("copy.md"), "body").unwrap();
    let mut state = connected();
    let server = MutationServer::new();
    state.base_url = server.base_url.clone();
    state
        .object_map
        .insert("old.md".into(), mapped("remote-object", "body"));

    let (_, next) = cycle(state, &root.0).await;

    assert_eq!(server.posts.load(Ordering::Relaxed), 1);
    assert!(root.0.join("old.md").exists());
    assert!(root.0.join("copy.md").exists());
    assert_eq!(next.object_map.len(), 2);
}

/// A different file at the new name is never adopted or held back: it is
/// uploaded as before, and the rename parks it rather than losing it.
#[tokio::test]
async fn a_differing_file_at_the_renamed_name_is_kept() {
    let root = TempRoot::new();
    std::fs::write(root.0.join("old.md"), "body").unwrap();
    std::fs::write(root.0.join("new.md"), "mine").unwrap();
    let mut state = connected();
    let server = MutationServer::with_remote_note(&state.vault_key, "new.md", "body");
    state.base_url = server.base_url.clone();
    state
        .object_map
        .insert("old.md".into(), mapped("remote-object", "body"));

    cycle(state, &root.0).await;

    let contents: Vec<_> = std::fs::read_dir(&root.0)
        .unwrap()
        .map(|entry| std::fs::read_to_string(entry.unwrap().path()).unwrap_or_default())
        .collect();
    assert!(contents.iter().any(|body| body == "mine"), "{contents:?}");
}

/// A note moved to another folder outside the app, while a byte-identical twin
/// is still mapped on disk: the moved file is a copy by bytes, but it is a
/// rename destination, so its PUT must go out in the first push. Held back, the
/// rebound map entry made the late push see it as unchanged and no PUT was ever
/// sent: peers kept the old path while the cycle reported success.
#[tokio::test]
async fn a_folder_move_with_a_byte_identical_twin_is_put_before_the_pull() {
    let root = TempRoot::new();
    for folder in ["a", "c"] {
        std::fs::create_dir_all(root.0.join(folder)).unwrap();
        std::fs::write(root.0.join(folder).join("x.md"), "body").unwrap();
    }
    let mut state = connected();
    let server = MutationServer::new();
    state.base_url = server.base_url.clone();
    state
        .object_map
        .insert("a/x.md".into(), mapped("twin-object", "body"));
    state
        .object_map
        .insert("b/x.md".into(), mapped("moved-object", "body"));

    cycle(state, &root.0).await;

    let requests = server.requests.lock().unwrap().clone();
    let put = requests
        .iter()
        .position(|line| {
            line.starts_with("PUT /api/collections/collection/blob-objects/moved-object?")
        })
        .unwrap_or_else(|| panic!("the move never reached the server: {requests:?}"));
    let pull = requests
        .iter()
        .position(|line| line.starts_with("GET /api/collections/collection/objects?sinceVersion="))
        .unwrap_or_else(|| panic!("no pull: {requests:?}"));
    assert!(put < pull, "the move went out after the pull: {requests:?}");
}
