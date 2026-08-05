use super::*;

#[tokio::test]
async fn tombstone_recreate_persists_its_new_identity_before_create() {
    let root = TempRoot::new();
    std::fs::write(root.path().join("note.md"), "edited").unwrap();
    let server = MockServer::start().await;
    Mock::given(method("PUT"))
        .and(path(
            "/api/collections/collection/blob-objects/original-object",
        ))
        .and(query_param("version", "2"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "object": {
                "id": "original-object",
                "version": 2,
                "change_seq": 2,
                "deleted": true,
                "blob_key": "old-blob"
            },
            "collectionVersion": 2
        })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/collections/collection/blob-objects"))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
            "object": {
                "id": "should-not-commit",
                "version": 1,
                "change_seq": 3,
                "blob_key": "new-blob"
            },
            "collectionVersion": 3
        })))
        .expect(0)
        .mount(&server)
        .await;
    let file = local_files(root.path()).unwrap().remove(0);
    let mut state = connected();
    state.base_url = server.uri();
    state.object_map.insert(
        "note.md".into(),
        ObjectState {
            object_id: "original-object".into(),
            version: 1,
            blob_key: "old-blob".into(),
            hash: Some(hash_sha256("before")),
            mtime_ms: Some(file.mtime - 1),
            size_bytes: Some(6),
        },
    );
    let fail_recreate_checkpoint = |_: &Path, state: &ConnectedState| {
        if state.pending_creates.contains_key("note.md") {
            return Err("disk full".into());
        }
        Ok(())
    };

    let result = push_with_checkpoint(
        &state,
        root.path(),
        &no_progress,
        &no_pre_write,
        &fail_recreate_checkpoint,
    )
    .await;
    let failure = match result {
        Err(failure) => failure,
        Ok(_) => panic!("an unpersisted create identity must stop the cycle"),
    };

    server.verify().await;
    assert!(matches!(failure.kind, SyncErrorKind::Io(_)));
    assert_eq!(failure.state.pending_creates.len(), 1);
    assert_eq!(
        failure.state.pending_creates["note.md"].original_name,
        "note.md"
    );
}

#[tokio::test]
async fn failed_tombstone_replay_successor_stops_before_pull() {
    let root = TempRoot::new();
    std::fs::write(root.path().join("note.md"), "newer local bytes").unwrap();
    let replayed_id = "01890000-0000-7000-8000-00000000e008";
    let server = MockServer::start().await;
    Mock::given(method("PUT"))
        .and(path(
            "/api/collections/collection/blob-objects/original-object",
        ))
        .and(query_param("version", "2"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "object": {
                "id": "original-object",
                "version": 2,
                "change_seq": 2,
                "deleted": true,
                "blob_key": "old-blob"
            },
            "collectionVersion": 2
        })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/collections/collection/blob-objects"))
        .and(header("mutation-id", replayed_id))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "object": {
                "id": replayed_id,
                "version": 1,
                "change_seq": 3,
                "blob_key": "replayed-blob"
            },
            "collectionVersion": 3,
            "replayed": true
        })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("PUT"))
        .and(path(format!(
            "/api/collections/collection/blob-objects/{replayed_id}"
        )))
        .and(query_param("version", "2"))
        .respond_with(ResponseTemplate::new(503))
        .expect(1)
        .mount(&server)
        .await;
    let file = local_files(root.path()).unwrap().remove(0);
    let mut state = connected();
    state.base_url = server.uri();
    state.object_map.insert(
        "note.md".into(),
        ObjectState {
            object_id: "original-object".into(),
            version: 1,
            blob_key: "old-blob".into(),
            hash: Some(hash_sha256("before")),
            mtime_ms: Some(file.mtime - 1),
            size_bytes: Some(6),
        },
    );
    state.pending_creates.insert(
        "note.md".into(),
        PendingCreate {
            mutation_id: replayed_id.into(),
            original_name: "note.md".into(),
            hash: hash_sha256("older local bytes"),
            size_bytes: 17,
        },
    );

    let failure = match push_with_checkpoint(
        &state,
        root.path(),
        &no_progress,
        &no_pre_write,
        &checkpoint::save,
    )
    .await
    {
        Err(failure) => failure,
        Ok(_) => panic!("unsafe tombstone replay successor failure must stop the cycle"),
    };

    server.verify().await;
    assert_eq!(
        failure.state.pending_creates["note.md"].mutation_id,
        replayed_id
    );
    assert_eq!(
        failure.state.object_map["note.md"].object_id,
        "original-object"
    );
}

#[tokio::test]
async fn restart_discards_a_replayed_tombstone_identity_before_retrying() {
    let root = TempRoot::new();
    std::fs::write(root.path().join("note.md"), "local edit").unwrap();
    let replayed_id = "01890000-0000-7000-8000-00000000e009";
    let server = MockServer::start().await;
    Mock::given(method("PUT"))
        .and(path(
            "/api/collections/collection/blob-objects/original-object",
        ))
        .and(query_param("version", "2"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "object": {
                "id": "original-object",
                "version": 2,
                "change_seq": 2,
                "deleted": true,
                "blob_key": "old-blob"
            },
            "collectionVersion": 2
        })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/collections/collection/blob-objects"))
        .and(header("mutation-id", replayed_id))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
            "object": {
                "id": replayed_id,
                "version": 2,
                "change_seq": 3,
                "deleted": true,
                "blob_key": "replayed-blob"
            },
            "collectionVersion": 3,
            "replayed": true
        })))
        .expect(1)
        .mount(&server)
        .await;

    let file = local_files(root.path()).unwrap().remove(0);
    let current_hash = hash_sha256("local edit");
    let mut state = connected();
    state.base_url = server.uri();
    state.object_map.insert(
        "note.md".into(),
        ObjectState {
            object_id: "original-object".into(),
            version: 1,
            blob_key: "old-blob".into(),
            hash: Some(hash_sha256("before")),
            mtime_ms: Some(file.mtime - 1),
            size_bytes: Some(6),
        },
    );
    state.pending_creates.insert(
        "note.md".into(),
        PendingCreate {
            mutation_id: replayed_id.into(),
            original_name: "note.md".into(),
            hash: current_hash,
            size_bytes: file.size,
        },
    );

    let failure = push_with_checkpoint(
        &state,
        root.path(),
        &no_progress,
        &no_pre_write,
        &checkpoint::save,
    )
    .await
    .expect_err("a replayed tombstone must stop the push-first cycle");

    server.verify().await;
    assert!(failure.state.pending_creates.is_empty());
    assert!(failure.state.object_map.is_empty());
    let checkpointed = checkpoint::load(root.path(), "collection");
    assert!(checkpointed.pending_creates.is_empty());
    assert!(checkpointed.object_map.is_empty());
    assert_eq!(
        std::fs::read_to_string(root.path().join("note.md")).unwrap(),
        "local edit"
    );

    let retry_server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/collections/collection/blob-objects"))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
            "object": {
                "id": "fresh-server-object",
                "version": 1,
                "change_seq": 4,
                "blob_key": "fresh-blob"
            },
            "collectionVersion": 4,
            "replayed": false
        })))
        .expect(1)
        .mount(&retry_server)
        .await;
    let mut retry_state = failure.state;
    retry_state.base_url = retry_server.uri();

    let (_, settled) = push(&retry_state, root.path(), &no_progress, &no_pre_write)
        .await
        .unwrap();

    retry_server.verify().await;
    let requests = retry_server.received_requests().await.unwrap();
    let fresh_id = requests[0]
        .headers
        .get("mutation-id")
        .and_then(|value| value.to_str().ok())
        .expect("fresh mutation id");
    assert_ne!(fresh_id, replayed_id);
    assert!(settled.pending_creates.is_empty());
    assert_eq!(
        settled.object_map["note.md"].object_id,
        "fresh-server-object"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deletion_before_a_tombstoned_replay_response_clears_the_create_identity() {
    let root = TempRoot::new();
    std::fs::write(root.path().join("note.md"), "local edit").unwrap();
    let replayed_id = "01890000-0000-7000-8000-00000000e010";
    let server = MockServer::start().await;
    Mock::given(method("PUT"))
        .and(path(
            "/api/collections/collection/blob-objects/original-object",
        ))
        .and(query_param("version", "2"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "object": {
                "id": "original-object",
                "version": 2,
                "change_seq": 2,
                "deleted": true,
                "blob_key": "old-blob"
            },
            "collectionVersion": 2
        })))
        .expect(1)
        .mount(&server)
        .await;
    let replay_response = ResponseGate::default();
    let response_gate = replay_response.clone();
    Mock::given(method("POST"))
        .and(path("/api/collections/collection/blob-objects"))
        .and(header("mutation-id", replayed_id))
        .respond_with(move |_: &Request| {
            response_gate.block_response();
            ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "object": {
                    "id": replayed_id,
                    "version": 2,
                    "change_seq": 3,
                    "deleted": true,
                    "blob_key": "replayed-blob"
                },
                "collectionVersion": 3,
                "replayed": true
            }))
        })
        .expect(1)
        .mount(&server)
        .await;
    let file = local_files(root.path()).unwrap().remove(0);
    let mut state = connected();
    state.base_url = server.uri();
    state.object_map.insert(
        "note.md".into(),
        ObjectState {
            object_id: "original-object".into(),
            version: 1,
            blob_key: "old-blob".into(),
            hash: Some(hash_sha256("before")),
            mtime_ms: Some(file.mtime - 1),
            size_bytes: Some(6),
        },
    );
    state.pending_creates.insert(
        "note.md".into(),
        PendingCreate {
            mutation_id: replayed_id.into(),
            original_name: "note.md".into(),
            hash: hash_sha256("local edit"),
            size_bytes: file.size,
        },
    );
    let push_future = push_with_checkpoint(
        &state,
        root.path(),
        &no_progress,
        &no_pre_write,
        &checkpoint::save,
    );
    tokio::pin!(push_future);
    tokio::select! {
        _ = replay_response.wait_until_blocked() => {}
        _ = &mut push_future => panic!("push finished before the replay response was blocked"),
    }
    std::fs::remove_file(root.path().join("note.md")).unwrap();
    replay_response.release();

    let (_, settled) = match push_future.await {
        Ok(result) => result,
        Err(_) => panic!("a deleted replay should settle without a replacement identity"),
    };

    server.verify().await;
    assert!(!root.path().join("note.md").exists());
    assert!(settled.pending_creates.is_empty());
    assert!(settled.object_map.is_empty());
}
