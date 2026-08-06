use super::super::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn replay_successor_conflict_does_not_merge_over_a_newer_disk_edit() {
    let root = TempRoot::new();
    std::fs::write(root.path().join("note.md"), "candidate bytes").unwrap();
    let object_id = "01890000-0000-7000-8000-00000000e007";
    let server = MockServer::start().await;
    let replay_response = ResponseGate::default();
    let response_gate = replay_response.clone();
    Mock::given(method("POST"))
        .and(path("/api/collections/collection/blob-objects"))
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
        .respond_with(ResponseTemplate::new(409).set_body_json(serde_json::json!({
            "currentVersion": 2,
            "currentBlobKey": "peer-blob"
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
            hash: hash_sha256("original bytes"),
            size_bytes: 14,
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
    std::fs::write(root.path().join("note.md"), "newest disk edit").unwrap();
    replay_response.release();

    let failure = push_future
        .await
        .expect_err("stale replay conflict resolution must stop before pull");

    assert_eq!(
        std::fs::read_to_string(root.path().join("note.md")).unwrap(),
        "newest disk edit"
    );
    assert_eq!(
        failure.state.pending_creates["note.md"].mutation_id,
        object_id
    );
    assert!(failure.state.object_map.is_empty());
    assert_eq!(server.received_requests().await.unwrap().len(), 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edit_during_replay_conflict_resolution_is_not_overwritten() {
    use futo_notes_core::e2ee;

    let root = TempRoot::new();
    std::fs::write(root.path().join("note.md"), "local line\n").unwrap();
    let file = local_files(root.path()).unwrap().remove(0);
    let object_id = "01890000-0000-7000-8000-00000000e012";
    let server = MockServer::start().await;
    Mock::given(method("PUT"))
        .and(path(format!(
            "/api/collections/collection/blob-objects/{object_id}"
        )))
        .and(query_param("version", "2"))
        .respond_with(ResponseTemplate::new(409).set_body_json(serde_json::json!({
            "currentVersion": 2,
            "currentBlobKey": "remote-blob"
        })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path(format!(
            "/api/collections/collection/objects/{object_id}"
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "object": {
                "id": object_id,
                "version": 2,
                "change_seq": 2,
                "blob_key": "remote-blob",
                "updated_at": "2026-07-29T12:00:00Z"
            }
        })))
        .expect(1)
        .mount(&server)
        .await;
    let remote =
        e2ee::aes_gcm_encrypt(&[5; 32], &e2ee::pack_note_v2("note.md", "remote line\n")).unwrap();
    let base =
        e2ee::aes_gcm_encrypt(&[5; 32], &e2ee::pack_note_v2("note.md", "base line\n")).unwrap();
    Mock::given(method("GET"))
        .and(path("/api/blobs/remote-blob"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(remote))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/blobs/base-blob"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(base))
        .expect(1)
        .mount(&server)
        .await;
    let conflict_copy_response = ResponseGate::default();
    let response_gate = conflict_copy_response.clone();
    Mock::given(method("POST"))
        .and(path("/api/collections/collection/blob-objects"))
        .respond_with(move |_: &Request| {
            response_gate.block_response();
            ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "object": {
                    "id": "conflict-copy-object",
                    "version": 1,
                    "change_seq": 3,
                    "blob_key": "conflict-copy-blob",
                    "updated_at": "2026-07-29T12:00:01Z"
                },
                "collectionVersion": 3,
                "replayed": false
            }))
        })
        .expect(1)
        .mount(&server)
        .await;
    let pending = PendingCreate {
        mutation_id: object_id.into(),
        original_name: "before-retry.md".into(),
        hash: hash_sha256("base line\n"),
        size_bytes: 10,
    };
    let candidate = UploadCandidate {
        file,
        target: UploadTarget::Create(pending.clone()),
        content: "local line\n".into(),
        hash: hash_sha256("local line\n"),
        ciphertext: vec![1, 2, 3],
        local_was_rename: false,
    };
    let replayed = crate::server::Write {
        object: crate::server::Object {
            id: object_id.into(),
            version: 1,
            change_seq: 1,
            deleted: false,
            blob_key: Some("base-blob".into()),
            size_bytes: Some(10),
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
            _ = conflict_copy_response.wait_until_blocked() => {}
            _ = &mut applied => panic!("conflict resolution finished before the copy response was blocked"),
        }
        std::fs::write(root.path().join("note.md"), "newest disk edit\n").unwrap();
        conflict_copy_response.release();
        applied.await.unwrap();
    }

    server.verify().await;
    assert_eq!(
        std::fs::read_to_string(root.path().join("note.md")).unwrap(),
        "newest disk edit\n"
    );
    assert!(state.pending_creates.is_empty());
    assert_eq!(state.object_map["note.md"].version, 2);
    assert!(state.object_map["note.md"].mtime_ms.is_none());
    assert_eq!(summary.local_writes_applied, 1);
}

#[tokio::test]
async fn failed_successor_update_after_replay_stops_before_pull() {
    let root = TempRoot::new();
    std::fs::write(root.path().join("note.md"), "edited after first attempt").unwrap();
    let object_id = "01890000-0000-7000-8000-00000000e003";
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/collections/collection/blob-objects"))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
            "object": {
                "id": object_id,
                "version": 1,
                "change_seq": 1,
                "blob_key": "original-blob"
            },
            "collectionVersion": 1,
            "replayed": true
        })))
        .mount(&server)
        .await;
    Mock::given(method("PUT"))
        .and(path(format!(
            "/api/collections/collection/blob-objects/{object_id}"
        )))
        .respond_with(ResponseTemplate::new(500))
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
            hash: hash_sha256("original bytes"),
            size_bytes: 14,
        },
    );

    let result = push_with_checkpoint(
        &state,
        root.path(),
        &no_progress,
        &no_pre_write,
        &checkpoint::save,
    )
    .await;

    let failure = match result {
        Err(failure) => failure,
        Ok(_) => panic!("unsafe replay successor failure must stop the push-first cycle"),
    };
    assert_eq!(
        failure.state.pending_creates["note.md"].mutation_id,
        object_id
    );
    assert!(failure.state.object_map.is_empty());
}
