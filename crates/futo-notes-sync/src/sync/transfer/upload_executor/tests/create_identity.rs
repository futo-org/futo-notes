use super::*;

#[tokio::test]
async fn create_identity_is_checkpointed_before_a_classic_request() {
    let root = TempRoot::new();
    std::fs::write(root.path().join("note.md"), "body").unwrap();
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/collections/collection/blob-objects"))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
            "object": {
                "id": "should-not-be-created",
                "version": 1,
                "change_seq": 1,
                "blob_key": "should-not-exist"
            },
            "collectionVersion": 1
        })))
        .expect(0)
        .mount(&server)
        .await;
    let mut state = connected();
    state.base_url = server.uri();
    let fail_checkpoint = |_: &Path, _: &ConnectedState| Err("disk full".into());

    let result = push_with_checkpoint(
        &state,
        root.path(),
        &no_progress,
        &no_pre_write,
        &fail_checkpoint,
    )
    .await;
    let failure = result.expect_err("an unpersisted create identity must stop the push");

    server.verify().await;
    assert!(matches!(failure.kind, SyncErrorKind::Io(_)));
    assert!(failure.state.object_map.is_empty());
    assert_eq!(failure.state.pending_creates.len(), 1);
    assert_eq!(
        failure.state.pending_creates["note.md"].original_name,
        "note.md"
    );
}
#[tokio::test]
async fn restart_reuses_the_persisted_identity_for_classic_create() {
    let root = TempRoot::new();
    std::fs::write(root.path().join("note.md"), "body").unwrap();
    let failing_server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/collections/collection/blob-objects"))
        .respond_with(ResponseTemplate::new(500))
        .expect(1)
        .mount(&failing_server)
        .await;
    let mut state = connected();
    state.base_url = failing_server.uri();

    let (first_summary, first_state) = push(&state, root.path(), &no_progress, &no_pre_write)
        .await
        .unwrap();
    assert_eq!(first_summary.uploaded, 0);
    assert_eq!(first_state.pending_creates.len(), 1);
    let persisted = checkpoint::load(root.path(), "collection");
    let mutation_id = persisted.pending_creates["note.md"].mutation_id.clone();

    let succeeding_server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/collections/collection/blob-objects"))
        .and(header("mutation-id", mutation_id.as_str()))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
            "object": {
                "id": "server-object",
                "version": 1,
                "change_seq": 1,
                "blob_key": "blob"
            },
            "collectionVersion": 1
        })))
        .expect(1)
        .mount(&succeeding_server)
        .await;
    let mut restarted = first_state;
    restarted.base_url = succeeding_server.uri();

    let (second_summary, settled) = push(&restarted, root.path(), &no_progress, &no_pre_write)
        .await
        .unwrap();

    assert_eq!(second_summary.uploaded, 1);
    assert!(settled.pending_creates.is_empty());
    assert_eq!(settled.object_map["note.md"].object_id, "server-object");
}

#[tokio::test]
async fn restart_after_a_lost_create_checkpoint_replays_without_a_new_identity() {
    let root = TempRoot::new();
    std::fs::write(root.path().join("note.md"), "body").unwrap();
    let first_server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/collections/collection/blob-objects"))
        .respond_with(|request: &Request| {
            let mutation_id = request
                .headers
                .get("mutation-id")
                .and_then(|value| value.to_str().ok())
                .expect("mutation id");
            ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "object": {
                    "id": format!("server-{mutation_id}"),
                    "version": 1,
                    "change_seq": 1,
                    "blob_key": "blob"
                },
                "collectionVersion": 1
            }))
        })
        .expect(1)
        .mount(&first_server)
        .await;
    let mut state = connected();
    state.base_url = first_server.uri();
    let saves = Arc::new(AtomicUsize::new(0));
    let observed_saves = Arc::clone(&saves);
    let lose_settlement_checkpoint = move |root: &Path, state: &ConnectedState| {
        if observed_saves.fetch_add(1, Ordering::Relaxed) == 0 {
            checkpoint::save(root, state)
        } else {
            Err("injected post-response checkpoint failure".into())
        }
    };

    let first = push_with_checkpoint(
        &state,
        root.path(),
        &no_progress,
        &no_pre_write,
        &lose_settlement_checkpoint,
    )
    .await;
    let (first_summary, first_state) = match first {
        Ok(result) => result,
        Err(_) => panic!("checkpoint failure should be summarized"),
    };
    assert_eq!(first_summary.uploaded, 1);
    assert!(first_state.pending_creates.is_empty());
    let disk = checkpoint::load(root.path(), "collection");
    assert!(disk.object_map.is_empty());
    let mutation_id = disk.pending_creates["note.md"].mutation_id.clone();

    let replay_server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/collections/collection/blob-objects"))
        .and(header("mutation-id", mutation_id.as_str()))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
            "object": {
                "id": "server-object",
                "version": 1,
                "change_seq": 1,
                "blob_key": "blob"
            },
            "collectionVersion": 1,
            "replayed": true
        })))
        .expect(1)
        .mount(&replay_server)
        .await;
    let mut restarted = connected();
    restarted.base_url = replay_server.uri();
    restarted.pending_creates = disk.pending_creates;

    let (replay_summary, replayed) = push(&restarted, root.path(), &no_progress, &no_pre_write)
        .await
        .unwrap();

    assert_eq!(replay_summary.uploaded, 1);
    assert!(replayed.pending_creates.is_empty());
    assert_eq!(replayed.object_map["note.md"].object_id, "server-object");
}

#[tokio::test]
async fn batch_404_classic_fallback_keeps_each_create_identity() {
    let root = TempRoot::new();
    std::fs::write(root.path().join("a.md"), "alpha").unwrap();
    std::fs::write(root.path().join("b.md"), "bravo").unwrap();
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/collections/collection/blob-objects/batch"))
        .respond_with(ResponseTemplate::new(404))
        .expect(1)
        .mount(&server)
        .await;
    for (object_id, change_seq) in [
        ("01890000-0000-7000-8000-00000000d001", 1),
        ("01890000-0000-7000-8000-00000000d002", 2),
    ] {
        Mock::given(method("POST"))
            .and(path("/api/collections/collection/blob-objects"))
            .and(header("mutation-id", object_id))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "object": {
                    "id": object_id,
                    "version": 1,
                    "change_seq": change_seq,
                    "blob_key": format!("blob-{change_seq}")
                },
                "collectionVersion": change_seq
            })))
            .expect(1)
            .mount(&server)
            .await;
    }
    let mut state = connected();
    state.base_url = server.uri();
    for (name, object_id) in [
        ("a.md", "01890000-0000-7000-8000-00000000d001"),
        ("b.md", "01890000-0000-7000-8000-00000000d002"),
    ] {
        let content = std::fs::read_to_string(root.path().join(name)).unwrap();
        state.pending_creates.insert(
            name.into(),
            PendingCreate {
                mutation_id: object_id.into(),
                original_name: name.into(),
                hash: hash_sha256(&content),
                size_bytes: content.len() as u64,
            },
        );
    }

    let (summary, settled) = push(&state, root.path(), &no_progress, &no_pre_write)
        .await
        .unwrap();

    assert_eq!(summary.uploaded, 2);
    assert!(settled.pending_creates.is_empty());
    assert_eq!(
        settled.object_map["a.md"].object_id,
        "01890000-0000-7000-8000-00000000d001"
    );
    assert_eq!(
        settled.object_map["b.md"].object_id,
        "01890000-0000-7000-8000-00000000d002"
    );
}

#[tokio::test]
async fn legacy_server_fallback_accepts_server_generated_create_ids() {
    let root = TempRoot::new();
    std::fs::write(root.path().join("a.md"), "alpha").unwrap();
    std::fs::write(root.path().join("b.md"), "bravo").unwrap();
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/collections/collection/blob-objects/batch"))
        .respond_with(ResponseTemplate::new(404))
        .expect(1)
        .mount(&server)
        .await;
    for (pending_id, returned_id, change_seq) in [
        ("01890000-0000-7000-8000-00000000d011", "legacy-object-a", 1),
        ("01890000-0000-7000-8000-00000000d012", "legacy-object-b", 2),
    ] {
        Mock::given(method("POST"))
            .and(path("/api/collections/collection/blob-objects"))
            .and(header("mutation-id", pending_id))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "object": {
                    "id": returned_id,
                    "version": 1,
                    "change_seq": change_seq,
                    "blob_key": format!("legacy-blob-{change_seq}")
                },
                "collectionVersion": change_seq
            })))
            .expect(1)
            .mount(&server)
            .await;
    }
    let mut state = connected();
    state.base_url = server.uri();
    for (name, pending_id) in [
        ("a.md", "01890000-0000-7000-8000-00000000d011"),
        ("b.md", "01890000-0000-7000-8000-00000000d012"),
    ] {
        let content = std::fs::read_to_string(root.path().join(name)).unwrap();
        state.pending_creates.insert(
            name.into(),
            PendingCreate {
                mutation_id: pending_id.into(),
                original_name: name.into(),
                hash: hash_sha256(&content),
                size_bytes: content.len() as u64,
            },
        );
    }

    let (summary, settled) = push(&state, root.path(), &no_progress, &no_pre_write)
        .await
        .unwrap();

    assert_eq!(summary.uploaded, 2);
    assert!(settled.pending_creates.is_empty());
    assert_eq!(settled.object_map["a.md"].object_id, "legacy-object-a");
    assert_eq!(settled.object_map["b.md"].object_id, "legacy-object-b");
}
