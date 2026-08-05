use super::super::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deletion_before_a_live_replay_response_keeps_the_server_version() {
    let root = TempRoot::new();
    std::fs::write(root.path().join("note.md"), "original bytes").unwrap();
    let object_id = "01890000-0000-7000-8000-00000000e005";
    let server = MockServer::start().await;
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
                    "version": 4,
                    "change_seq": 9,
                    "blob_key": "retained-blob"
                },
                "collectionVersion": 9,
                "replayed": true
            }))
        })
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("DELETE"))
        .and(path(format!(
            "/api/collections/collection/objects/{object_id}"
        )))
        .and(query_param("version", "4"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "object": {
                "id": object_id,
                "version": 5,
                "change_seq": 10,
                "deleted": true,
                "blob_key": "retained-blob"
            },
            "collectionVersion": 10
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
    let first_push = push(&state, root.path(), &no_progress, &no_pre_write);
    tokio::pin!(first_push);
    tokio::select! {
        _ = replay_response.wait_until_blocked() => {}
        result = &mut first_push => panic!("push finished before the replay response was blocked: {result:?}"),
    }
    std::fs::remove_file(root.path().join("note.md")).unwrap();
    replay_response.release();

    let (_, replayed) = first_push.await.unwrap();
    assert!(replayed.pending_creates.is_empty());
    assert_eq!(replayed.object_map["note.md"].version, 4);
    assert_eq!(replayed.object_map["note.md"].blob_key, "retained-blob");

    let (summary, settled) = push(&replayed, root.path(), &no_progress, &no_pre_write)
        .await
        .unwrap();

    server.verify().await;
    assert_eq!(summary.deleted, 1);
    assert!(settled.object_map.is_empty());
}

#[tokio::test]
async fn deleted_legacy_replay_placeholder_fetches_the_created_object_before_delete() {
    let root = TempRoot::new();
    let object_id = "01890000-0000-7000-8000-00000000e006";
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(format!(
            "/api/collections/collection/objects/{object_id}"
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "object": {
                "id": object_id,
                "version": 1,
                "change_seq": 1,
                "blob_key": "retained-blob"
            }
        })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("DELETE"))
        .and(path(format!(
            "/api/collections/collection/objects/{object_id}"
        )))
        .and(query_param("version", "1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "object": {
                "id": object_id,
                "version": 5,
                "change_seq": 10,
                "deleted": true,
                "blob_key": "retained-blob"
            },
            "collectionVersion": 10
        })))
        .expect(1)
        .mount(&server)
        .await;
    let mut state = connected();
    state.base_url = server.uri();
    state.object_map.insert(
        "note.md".into(),
        ObjectState {
            object_id: object_id.into(),
            version: 0,
            blob_key: String::new(),
            hash: Some(hash_sha256("original bytes")),
            mtime_ms: None,
            size_bytes: Some(14),
        },
    );

    let (summary, settled) = push(&state, root.path(), &no_progress, &no_pre_write)
        .await
        .unwrap();

    server.verify().await;
    assert_eq!(summary.deleted, 1);
    assert!(settled.object_map.is_empty());
}

#[tokio::test]
async fn deleted_legacy_replay_placeholder_does_not_claim_a_peer_edit() {
    use futo_notes_core::e2ee;

    let root = TempRoot::new();
    let object_id = "01890000-0000-7000-8000-00000000e011";
    let server = MockServer::start().await;
    let peer_blob = e2ee::aes_gcm_encrypt(
        &[5; 32],
        &e2ee::pack_note_v2("note.md", "peer edit after create"),
    )
    .unwrap();
    Mock::given(method("GET"))
        .and(path(format!(
            "/api/collections/collection/objects/{object_id}"
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "object": {
                "id": object_id,
                "version": 4,
                "change_seq": 9,
                "blob_key": "peer-blob",
                "size_bytes": peer_blob.len(),
                "updated_at": "2026-07-29T12:00:00Z"
            }
        })))
        .expect(2)
        .mount(&server)
        .await;
    Mock::given(method("DELETE"))
        .and(path(format!(
            "/api/collections/collection/objects/{object_id}"
        )))
        .and(query_param("version", "1"))
        .respond_with(ResponseTemplate::new(409).set_body_json(serde_json::json!({
            "currentVersion": 4,
            "currentBlobKey": "peer-blob"
        })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/blobs/peer-blob"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(peer_blob))
        .expect(1)
        .mount(&server)
        .await;
    let mut state = connected();
    state.base_url = server.uri();
    state.object_map.insert(
        "note.md".into(),
        ObjectState {
            object_id: object_id.into(),
            version: 0,
            blob_key: String::new(),
            hash: Some(hash_sha256("original bytes")),
            mtime_ms: None,
            size_bytes: Some(14),
        },
    );

    let (summary, settled) = push(&state, root.path(), &no_progress, &no_pre_write)
        .await
        .unwrap();

    server.verify().await;
    assert_eq!(
        std::fs::read_to_string(root.path().join("note.md")).unwrap(),
        "peer edit after create"
    );
    assert_eq!(summary.deleted, 0);
    assert_eq!(summary.downloaded, 1);
    assert_eq!(summary.conflicts, 1);
    assert_eq!(settled.object_map["note.md"].version, 4);
}
