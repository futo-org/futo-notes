use super::*;

#[tokio::test]
async fn incomplete_root_scan_stops_before_remote_deletion() {
    let root = TempRoot::new();
    std::fs::remove_dir(root.path()).unwrap();
    let (base_url, mutations, server) = mutation_server();
    let mut state = connected();
    state.base_url = base_url;
    state.object_map.insert(
        "healthy.md".into(),
        ObjectState {
            object_id: "healthy-object".into(),
            version: 1,
            blob_key: "healthy-blob".into(),
            hash: Some(hash_sha256("healthy")),
            mtime_ms: Some(1),
            size_bytes: Some(7),
        },
    );

    let result = push(&state, root.path(), &no_progress, &no_pre_write).await;
    server.join().unwrap();

    assert!(matches!(result, Err(SyncErrorKind::Io(_))));
    assert_eq!(mutations.load(Ordering::Relaxed), 0);
}

#[tokio::test]
async fn rename_read_failure_stops_before_remote_deletion() {
    let root = TempRoot::new();
    std::fs::write(root.path().join("note.md"), [0xff]).unwrap();
    let (base_url, mutations, server) = mutation_server();
    let mut state = connected();
    state.base_url = base_url;
    state.object_map.insert(
        "folder/note.md".into(),
        ObjectState {
            object_id: "healthy-object".into(),
            version: 1,
            blob_key: "healthy-blob".into(),
            hash: Some(hash_sha256("healthy")),
            mtime_ms: Some(1),
            size_bytes: Some(7),
        },
    );

    let result = push(&state, root.path(), &no_progress, &no_pre_write).await;
    server.join().unwrap();

    assert!(matches!(result, Err(SyncErrorKind::Io(_))));
    assert_eq!(mutations.load(Ordering::Relaxed), 0);
}

#[tokio::test]
async fn push_skips_an_oversize_flagged_file_without_uploading_or_deleting_it() {
    let root = TempRoot::new();
    std::fs::write(root.path().join("big.md"), "too big for the server").unwrap();
    let file = local_files(root.path()).unwrap().remove(0);
    let mut state = connected();
    state.oversize_skip.insert(file.name.clone(), file.mtime);

    let (summary, next) = push(&state, root.path(), &no_progress, &no_pre_write)
        .await
        .unwrap();

    assert_eq!(summary.uploaded, 0);
    assert_eq!(summary.conflicts, 1);
    assert!(summary.failures.is_empty());
    assert!(root.path().join("big.md").exists());
    assert!(!next.object_map.contains_key(&file.name));
}

#[tokio::test]
async fn push_retries_an_oversize_flagged_file_after_its_mtime_changes() {
    let root = TempRoot::new();
    std::fs::write(root.path().join("big.md"), "shrunk").unwrap();
    let file = local_files(root.path()).unwrap().remove(0);
    let mut state = connected();
    state
        .oversize_skip
        .insert(file.name.clone(), file.mtime - 1);

    let (summary, _) = push(&state, root.path(), &no_progress, &no_pre_write)
        .await
        .unwrap();

    assert_eq!(summary.conflicts, 0);
    assert!(summary
        .failures
        .iter()
        .any(|failure| failure.kind == FailureKind::Upload));
    assert!(root.path().join("big.md").exists());
}

#[tokio::test]
async fn push_preserves_the_pull_cursor() {
    let root = TempRoot::new();
    std::fs::write(root.path().join("note.md"), "synced body").unwrap();
    let file = local_files(root.path()).unwrap().remove(0);
    let mut state = connected();
    state.pull_cursor = 42;
    state.max_version = 99;
    state.object_map.insert(
        file.name.clone(),
        ObjectState {
            object_id: "o1".into(),
            version: 1,
            blob_key: "bk".into(),
            hash: Some(hash_sha256("synced body")),
            mtime_ms: Some(file.mtime),
            size_bytes: Some(file.size),
        },
    );

    let (summary, next) = push(&state, root.path(), &no_progress, &no_pre_write)
        .await
        .unwrap();

    assert!(summary.failures.is_empty());
    assert_eq!(summary.uploaded, 0);
    assert_eq!(next.pull_cursor, 42);
}
