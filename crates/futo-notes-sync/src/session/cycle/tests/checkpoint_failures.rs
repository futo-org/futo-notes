//! What survives in the running session when a checkpoint or a later step fails.

use super::*;

#[tokio::test]
async fn uploaded_state_survives_final_checkpoint_failure_in_the_running_session() {
    let root = TempRoot::new();
    std::fs::write(root.0.join("new.md"), "new body").unwrap();
    let server = MutationServer::new();
    let mut connected = connected();
    connected.base_url = server.base_url.clone();
    connected.max_version = 1;
    connected.pull_cursor = 1;
    let state = Arc::new(Mutex::new(Some(connected)));
    let gate = Arc::new(Mutex::new(()));
    let no_progress = |_: crate::sync::SyncProgress| {};
    let no_pre_write = |_: &str| {};
    let saves = AtomicUsize::new(0);
    let fail_push_checkpoint = move |root: &Path, state: &ConnectedState| {
        if saves.fetch_add(1, Ordering::Relaxed) == 0 {
            checkpoint::save(root, state)
        } else {
            Err("injected push checkpoint failure".into())
        }
    };

    let summary = run_with_checkpoint(
        &state,
        &gate,
        &root.0,
        &no_progress,
        &no_pre_write,
        &fail_push_checkpoint,
        &SyncRunJournal::disabled(),
    )
    .await
    .expect("checkpoint failure should be summarized");

    assert_eq!(summary.uploaded, 1);
    assert_eq!(
        summary
            .failures
            .iter()
            .filter(|failure| failure.kind == crate::sync::FailureKind::Checkpoint)
            .count(),
        1
    );
    assert!(state
        .lock()
        .await
        .as_ref()
        .unwrap()
        .object_map
        .contains_key("new.md"));

    run_with_checkpoint(
        &state,
        &gate,
        &root.0,
        &no_progress,
        &no_pre_write,
        &fail_push_checkpoint,
        &SyncRunJournal::disabled(),
    )
    .await
    .expect("retry should keep running");
    assert_eq!(server.posts.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn downloaded_state_survives_final_checkpoint_failure_in_the_running_session() {
    let root = TempRoot::new();
    std::fs::write(root.0.join("seed.md"), "seed body").unwrap();
    let seed_metadata = std::fs::metadata(root.0.join("seed.md")).unwrap();
    let mut connected = connected();
    let server = MutationServer::with_remote_note(&connected.vault_key, "remote.md", "peer body");
    connected.base_url = server.base_url.clone();
    connected.max_version = 1;
    connected.pull_cursor = 1;
    connected.object_map.insert(
        "seed.md".into(),
        crate::checkpoint::ObjectState {
            object_id: "seed-object".into(),
            version: 1,
            blob_key: "seed-blob".into(),
            hash: Some(futo_notes_core::hash::hash_sha256("seed body")),
            mtime_ms: Some(futo_notes_core::files::file_mtime_ms(&seed_metadata)),
            size_bytes: Some(seed_metadata.len()),
        },
    );
    let state = Arc::new(Mutex::new(Some(connected)));
    let gate = Arc::new(Mutex::new(()));
    let no_progress = |_: crate::sync::SyncProgress| {};
    let no_pre_write = |_: &str| {};
    let saves = AtomicUsize::new(0);
    let fail_pull_checkpoint = move |root: &Path, state: &ConnectedState| {
        if saves.fetch_add(1, Ordering::Relaxed) == 1 {
            Err("injected pull checkpoint failure".into())
        } else {
            checkpoint::save(root, state)
        }
    };

    let summary = run_with_checkpoint(
        &state,
        &gate,
        &root.0,
        &no_progress,
        &no_pre_write,
        &fail_pull_checkpoint,
        &SyncRunJournal::disabled(),
    )
    .await
    .unwrap();

    assert_eq!(summary.downloaded, 1);
    assert_eq!(
        summary
            .failures
            .iter()
            .filter(|failure| failure.kind == crate::sync::FailureKind::Checkpoint)
            .count(),
        1
    );
    assert!(state
        .lock()
        .await
        .as_ref()
        .unwrap()
        .object_map
        .contains_key("remote.md"));

    run_with_checkpoint(
        &state,
        &gate,
        &root.0,
        &no_progress,
        &no_pre_write,
        &fail_pull_checkpoint,
        &SyncRunJournal::disabled(),
    )
    .await
    .unwrap();
    assert_eq!(server.posts.load(Ordering::Relaxed), 0);
}

#[tokio::test]
async fn uploaded_state_survives_when_checkpoint_and_following_pull_fail() {
    let root = TempRoot::new();
    std::fs::write(root.0.join("new.md"), "new body").unwrap();
    let server = MutationServer::with_pull_failure();
    let mut connected = connected();
    connected.base_url = server.base_url.clone();
    connected.max_version = 1;
    connected.pull_cursor = 1;
    let state = Arc::new(Mutex::new(Some(connected)));
    let gate = Arc::new(Mutex::new(()));
    let no_progress = |_: crate::sync::SyncProgress| {};
    let no_pre_write = |_: &str| {};
    let saves = AtomicUsize::new(0);
    let fail_checkpoint = move |root: &Path, state: &ConnectedState| {
        if saves.fetch_add(1, Ordering::Relaxed) == 0 {
            checkpoint::save(root, state)
        } else {
            Err("injected checkpoint failure".into())
        }
    };

    run_with_checkpoint(
        &state,
        &gate,
        &root.0,
        &no_progress,
        &no_pre_write,
        &fail_checkpoint,
        &SyncRunJournal::disabled(),
    )
    .await
    .expect_err("the injected pull failure should abort the cycle");

    assert!(
        state
            .lock()
            .await
            .as_ref()
            .unwrap()
            .object_map
            .contains_key("new.md"),
        "the running session must retain the successful POST"
    );

    run_with_checkpoint(
        &state,
        &gate,
        &root.0,
        &no_progress,
        &no_pre_write,
        &fail_checkpoint,
        &SyncRunJournal::disabled(),
    )
    .await
    .expect_err("the pull remains intentionally unavailable");
    assert_eq!(
        server.posts.load(Ordering::Relaxed),
        1,
        "retrying the failed pull must not POST the same note again"
    );
}

#[tokio::test]
async fn uploaded_state_survives_a_later_fatal_delete_conflict() {
    let root = TempRoot::new();
    std::fs::write(root.0.join("new.md"), "new body").unwrap();
    let server = MutationServer::with_delete_conflict_failure();
    let mut connected = connected();
    connected.base_url = server.base_url.clone();
    connected.max_version = 1;
    connected.pull_cursor = 1;
    connected.object_map.insert(
        "deleted.md".into(),
        crate::checkpoint::ObjectState {
            object_id: "deleted-object".into(),
            version: 1,
            blob_key: "deleted-blob".into(),
            hash: Some(futo_notes_core::hash::hash_sha256("old body")),
            mtime_ms: Some(1),
            size_bytes: Some(8),
        },
    );
    let state = Arc::new(Mutex::new(Some(connected)));
    let gate = Arc::new(Mutex::new(()));
    let no_progress = |_: crate::sync::SyncProgress| {};
    let no_pre_write = |_: &str| {};

    run_with_checkpoint(
        &state,
        &gate,
        &root.0,
        &no_progress,
        &no_pre_write,
        &checkpoint::save,
        &SyncRunJournal::disabled(),
    )
    .await
    .expect_err("the injected delete-conflict fetch failure should abort the cycle");

    assert!(
        state
            .lock()
            .await
            .as_ref()
            .unwrap()
            .object_map
            .contains_key("new.md"),
        "the running session must retain the successful POST before the later error"
    );

    run_with_checkpoint(
        &state,
        &gate,
        &root.0,
        &no_progress,
        &no_pre_write,
        &checkpoint::save,
        &SyncRunJournal::disabled(),
    )
    .await
    .expect_err("the delete conflict remains intentionally unavailable");
    assert_eq!(
        server.posts.load(Ordering::Relaxed),
        1,
        "retrying the failed delete conflict must not POST the same note again"
    );
}
