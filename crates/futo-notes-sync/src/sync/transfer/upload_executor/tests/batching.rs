use super::*;

#[tokio::test]
async fn two_new_notes_use_one_batch_upload_request() {
    let root = TempRoot::new();
    std::fs::write(root.path().join("a.md"), "alpha").unwrap();
    std::fs::write(root.path().join("b.md"), "bravo").unwrap();
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/collections/collection/blob-objects/batch"))
        .respond_with(two_entry_batch_write_response)
        .expect(1)
        .mount(&server)
        .await;
    let mut state = connected();
    state.base_url = server.uri();

    let (summary, next) = push(&state, root.path(), &no_progress, &no_pre_write)
        .await
        .unwrap();

    assert_eq!(summary.uploaded, 2);
    assert!(summary.failures.is_empty());
    assert_eq!(next.object_map.len(), 2);
    assert!(next.pending_creates.is_empty());
    assert_eq!(next.max_version, 2);
}

#[tokio::test]
async fn update_is_not_skipped_when_the_final_checkpoint_fails() {
    let root = TempRoot::new();
    std::fs::write(root.path().join("note.md"), "changed").unwrap();
    let server = MockServer::start().await;
    Mock::given(method("PUT"))
        .and(path(
            "/api/collections/collection/blob-objects/01890000-0000-7000-8000-00000000a001",
        ))
        .and(query_param("version", "2"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "object": {
                "id": "01890000-0000-7000-8000-00000000a001",
                "version": 2,
                "change_seq": 2,
                "blob_key": "blob-2",
                "updated_at": "2026-07-29T12:00:00Z"
            },
            "collectionVersion": 2
        })))
        .expect(1)
        .mount(&server)
        .await;
    let mut state = connected();
    state.base_url = server.uri();
    state.object_map.insert(
        "note.md".into(),
        ObjectState {
            object_id: "01890000-0000-7000-8000-00000000a001".into(),
            version: 1,
            blob_key: "blob-1".into(),
            hash: Some(hash_sha256("before")),
            mtime_ms: None,
            size_bytes: Some(6),
        },
    );
    let fail_checkpoint = |_: &Path, _: &ConnectedState| Err("disk full".into());

    let result = push_with_checkpoint(
        &state,
        root.path(),
        &no_progress,
        &no_pre_write,
        &fail_checkpoint,
    )
    .await;
    let Ok((summary, next)) = result else {
        panic!("version-guarded updates do not require a pre-dispatch checkpoint");
    };

    assert_eq!(summary.uploaded, 1);
    assert_eq!(summary.failures.len(), 1);
    assert_eq!(summary.failures[0].kind, FailureKind::Checkpoint);
    assert_eq!(next.object_map["note.md"].version, 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn completed_batch_chunk_is_checkpointed_before_a_later_chunk_finishes() {
    let server = MockServer::start().await;
    let slow_batch = ResponseGate::default();
    let response_gate = slow_batch.clone();
    Mock::given(method("POST"))
        .and(path("/api/collections/collection/blob-objects/batch"))
        .respond_with(move |request: &Request| {
            let response = batch_write_response(request);
            if batch_object_ids(&request.body).len() == 2 {
                response_gate.block_response();
            }
            response
        })
        .mount(&server)
        .await;
    let root = TempRoot::new();
    for index in 0..102 {
        std::fs::write(root.path().join(format!("note-{index:03}.md")), "body").unwrap();
    }
    let mut state = connected();
    state.base_url = server.uri();
    let push_future = push(&state, root.path(), &no_progress, &no_pre_write);
    tokio::pin!(push_future);
    tokio::select! {
        _ = slow_batch.wait_until_blocked() => {}
        result = &mut push_future => panic!("push finished before the later chunk was blocked: {result:?}"),
    }

    let durable = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            tokio::select! {
                result = &mut push_future => {
                    let _ = result;
                    panic!("push finished while the later chunk was blocked");
                }
                _ = tokio::time::sleep(Duration::from_millis(10)) => {
                    let loaded = checkpoint::load(root.path(), "collection");
                    if loaded.object_map.len() == 100 {
                        return loaded;
                    }
                }
            }
        }
    })
    .await
    .expect("the completed 100-entry chunk was not checkpointed while the later chunk was blocked");

    assert_eq!(durable.object_map.len(), 100);
    assert_eq!(durable.max_version, 100);
    assert_eq!(durable.pull_cursor, 0);
    slow_batch.release();
    let (summary, _) = push_future.await.unwrap();
    assert_eq!(summary.uploaded, 102);
}

#[tokio::test]
async fn completed_stale_upload_leaves_a_newer_local_edit_dirty() {
    let root = TempRoot::new();
    std::fs::write(root.path().join("note.md"), "newer local edit").unwrap();
    let http = Http::new("http://127.0.0.1:1").unwrap();
    let mut state = connected();
    let mut summary = SyncSummary::default();
    let uploaded_hash = hash_sha256("old upload");
    let candidate = UploadCandidate {
        file: LocalFile {
            name: "note.md".into(),
            mtime: 1,
            size: 10,
        },
        target: UploadTarget::Create(PendingCreate {
            mutation_id: "01890000-0000-7000-8000-00000000c001".into(),
            original_name: "note.md".into(),
            hash: uploaded_hash.clone(),
            size_bytes: 10,
        }),
        content: "old upload".into(),
        hash: uploaded_hash.clone(),
        ciphertext: vec![1, 2, 3],
        local_was_rename: false,
    };
    let write = crate::server::Write {
        object: crate::server::Object {
            id: "object".into(),
            version: 1,
            change_seq: 4,
            deleted: false,
            blob_key: Some("blob".into()),
            size_bytes: Some(3),
            updated_at: "2026-07-29T12:00:00Z".into(),
        },
        collection_version: 4,
    };

    let mut context = PushContext {
        http: &http,
        state: &mut state,
        root: root.path(),
        summary: &mut summary,
        pre_write: &no_pre_write,
        save_checkpoint: &checkpoint::save,
    };
    let _ = apply_candidate(&mut context, candidate, CandidateResult::Created(write)).await;

    assert_eq!(
        std::fs::read_to_string(root.path().join("note.md")).unwrap(),
        "newer local edit"
    );
    assert_eq!(summary.uploaded, 1);
    assert_eq!(
        state.object_map["note.md"].hash.as_deref(),
        Some(uploaded_hash.as_str())
    );
    assert!(state.object_map["note.md"].mtime_ms.is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edit_before_replay_response_still_runs_the_successor_update() {
    let root = TempRoot::new();
    std::fs::write(root.path().join("note.md"), "candidate content").unwrap();
    let server = MockServer::start().await;
    let object_id = "01890000-0000-7000-8000-00000000c003";
    let replay_response = ResponseGate::default();
    let response_gate = replay_response.clone();
    Mock::given(method("POST"))
        .and(path("/api/collections/collection/blob-objects"))
        .and(header("mutation-id", object_id))
        .respond_with(move |_: &Request| {
            response_gate.block_response();
            ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "object": {
                    "id": object_id,
                    "version": 1,
                    "change_seq": 1,
                    "blob_key": "original-blob"
                },
                "collectionVersion": 1,
                "replayed": true
            }))
        })
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("PUT"))
        .and(path(format!(
            "/api/collections/collection/blob-objects/{object_id}"
        )))
        .and(query_param("version", "2"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "object": {
                "id": object_id,
                "version": 2,
                "change_seq": 2,
                "blob_key": "candidate-blob"
            },
            "collectionVersion": 2
        })))
        .expect(1)
        .mount(&server)
        .await;
    let mut state = connected();
    state.base_url = server.uri();
    state.pending_creates.insert(
        "note.md".into(),
        PendingCreate {
            mutation_id: object_id.into(),
            original_name: "note.md".into(),
            hash: hash_sha256("original create"),
            size_bytes: 15,
        },
    );
    let push_future = push(&state, root.path(), &no_progress, &no_pre_write);
    tokio::pin!(push_future);
    tokio::select! {
        _ = replay_response.wait_until_blocked() => {}
        result = &mut push_future => panic!("push finished before the replay response was blocked: {result:?}"),
    }
    std::fs::write(root.path().join("note.md"), "newer disk edit").unwrap();
    replay_response.release();

    let (summary, settled) = push_future.await.unwrap();

    assert_eq!(summary.uploaded, 1);
    assert!(settled.pending_creates.is_empty());
    assert_eq!(settled.object_map["note.md"].version, 2);
    assert_eq!(
        settled.object_map["note.md"].hash.as_deref(),
        Some(hash_sha256("candidate content").as_str())
    );
    assert!(settled.object_map["note.md"].mtime_ms.is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edit_during_replay_successor_remains_dirty_for_the_next_push() {
    let root = TempRoot::new();
    std::fs::write(root.path().join("note.md"), "old content").unwrap();
    let file = local_files(root.path()).unwrap().remove(0);
    let server = MockServer::start().await;
    let object_id = "01890000-0000-7000-8000-00000000c002";
    let successor_response = ResponseGate::default();
    let response_gate = successor_response.clone();
    Mock::given(method("PUT"))
        .and(path(format!(
            "/api/collections/collection/blob-objects/{object_id}"
        )))
        .and(query_param("version", "2"))
        .respond_with(move |_: &Request| {
            response_gate.block_response();
            ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "object": {
                    "id": object_id,
                    "version": 2,
                    "change_seq": 2,
                    "blob_key": "successor-blob",
                    "updated_at": "2026-07-29T12:00:00Z"
                },
                "collectionVersion": 2
            }))
        })
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("PUT"))
        .and(path(format!(
            "/api/collections/collection/blob-objects/{object_id}"
        )))
        .and(query_param("version", "3"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "object": {
                "id": object_id,
                "version": 3,
                "change_seq": 3,
                "blob_key": "newer-blob",
                "updated_at": "2026-07-29T12:00:01Z"
            },
            "collectionVersion": 3
        })))
        .expect(1)
        .mount(&server)
        .await;
    let old_hash = hash_sha256("old content");
    let pending = PendingCreate {
        mutation_id: object_id.into(),
        original_name: "before-rename.md".into(),
        hash: hash_sha256("original create"),
        size_bytes: 15,
    };
    let candidate = UploadCandidate {
        file,
        target: UploadTarget::Create(pending.clone()),
        content: "old content".into(),
        hash: old_hash,
        ciphertext: vec![1, 2, 3],
        local_was_rename: false,
    };
    let replayed = crate::server::Write {
        object: crate::server::Object {
            id: object_id.into(),
            version: 1,
            change_seq: 1,
            deleted: false,
            blob_key: Some("created-blob".into()),
            size_bytes: Some(15),
            updated_at: "2026-07-29T11:59:59Z".into(),
        },
        collection_version: 1,
    };
    let http = Http::new(&server.uri()).unwrap();
    let mut state = connected();
    state.base_url = server.uri();
    state.pending_creates.insert("note.md".into(), pending);
    let mut summary = SyncSummary::default();

    {
        let mut context = PushContext {
            http: &http,
            state: &mut state,
            root: root.path(),
            summary: &mut summary,
            pre_write: &no_pre_write,
            save_checkpoint: &checkpoint::save,
        };
        let applied = apply_candidate(&mut context, candidate, CandidateResult::Replayed(replayed));
        tokio::pin!(applied);
        tokio::select! {
            _ = successor_response.wait_until_blocked() => {}
            result = &mut applied => panic!("successor finished before its response was blocked: {result:?}"),
        }
        std::fs::write(root.path().join("note.md"), "new content").unwrap();
        successor_response.release();
        applied.await.unwrap();
    }

    assert!(state.object_map["note.md"].mtime_ms.is_none());
    assert_eq!(
        std::fs::read_to_string(root.path().join("note.md")).unwrap(),
        "new content"
    );
    let (next_summary, next) = push(&state, root.path(), &no_progress, &no_pre_write)
        .await
        .unwrap();
    assert_eq!(next_summary.uploaded, 1);
    assert_eq!(
        next.object_map["note.md"].hash.as_deref(),
        Some(hash_sha256("new content").as_str())
    );
}
