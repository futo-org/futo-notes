use super::super::*;

#[tokio::test]
async fn occupied_delete_conflict_rename_uses_the_original_path() {
    use futo_notes_core::e2ee;

    let root = TempRoot::new();
    std::fs::write(root.path().join("occupied.md"), "independent target").unwrap();
    let occupied_file = local_files(root.path())
        .unwrap()
        .into_iter()
        .find(|file| file.name == "occupied.md")
        .unwrap();
    let object_id = "01890000-0000-7000-8000-00000000e014";
    let server = MockServer::start().await;
    let peer_blob =
        e2ee::aes_gcm_encrypt(&[5; 32], &e2ee::pack_note_v2("occupied.md", "peer winner")).unwrap();
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
        "gone.md".into(),
        ObjectState {
            object_id: object_id.into(),
            version: 0,
            blob_key: String::new(),
            hash: Some(hash_sha256("original bytes")),
            mtime_ms: None,
            size_bytes: Some(14),
        },
    );
    state.object_map.insert(
        occupied_file.name.clone(),
        ObjectState {
            object_id: "01890000-0000-7000-8000-00000000e015".into(),
            version: 1,
            blob_key: "occupied-blob".into(),
            hash: Some(hash_sha256("independent target")),
            mtime_ms: Some(occupied_file.mtime),
            size_bytes: Some(occupied_file.size),
        },
    );

    let (summary, settled) = push(&state, root.path(), &no_progress, &no_pre_write)
        .await
        .unwrap();

    server.verify().await;
    assert_eq!(
        std::fs::read_to_string(root.path().join("occupied.md")).unwrap(),
        "independent target"
    );
    assert_eq!(
        std::fs::read_to_string(root.path().join("gone.md")).unwrap(),
        "peer winner"
    );
    assert_eq!(summary.downloaded, 1);
    assert_eq!(summary.conflicts, 1);
    assert_eq!(settled.object_map["gone.md"].version, 4);
    assert_eq!(
        settled.object_map["occupied.md"].object_id,
        "01890000-0000-7000-8000-00000000e015"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recreated_note_during_delete_conflict_recovery_is_not_overwritten() {
    use futo_notes_core::e2ee;

    let root = TempRoot::new();
    let object_id = "01890000-0000-7000-8000-00000000e013";
    let server = MockServer::start().await;
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
    let peer_blob = e2ee::aes_gcm_encrypt(
        &[5; 32],
        &e2ee::pack_note_v2("note.md", "peer edit after create"),
    )
    .unwrap();
    let blob_response = ResponseGate::default();
    let response_gate = blob_response.clone();
    Mock::given(method("GET"))
        .and(path("/api/blobs/peer-blob"))
        .respond_with(move |_: &Request| {
            response_gate.block_response();
            ResponseTemplate::new(200).set_body_bytes(peer_blob.clone())
        })
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
    let push_future = push(&state, root.path(), &no_progress, &no_pre_write);
    tokio::pin!(push_future);
    tokio::select! {
        _ = blob_response.wait_until_blocked() => {}
        result = &mut push_future => panic!("push finished before delete-conflict hydration was blocked: {result:?}"),
    }
    std::fs::write(root.path().join("note.md"), "new local note").unwrap();
    blob_response.release();

    let (summary, settled) = push_future.await.unwrap();

    server.verify().await;
    assert_eq!(
        std::fs::read_to_string(root.path().join("note.md")).unwrap(),
        "new local note"
    );
    assert_eq!(summary.downloaded, 0);
    assert_eq!(summary.conflicts, 1);
    assert_eq!(settled.object_map["note.md"].version, 1);
    assert!(settled.object_map["note.md"].mtime_ms.is_none());
}
