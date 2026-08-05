use super::super::*;

#[tokio::test]
async fn replayed_create_with_newer_local_bytes_is_followed_by_an_update() {
    let root = TempRoot::new();
    std::fs::write(root.path().join("note.md"), "edited after first attempt").unwrap();
    let object_id = "01890000-0000-7000-8000-00000000e001";
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/collections/collection/blob-objects"))
        .and(header("mutation-id", object_id))
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
                "blob_key": "edited-blob"
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
            hash: hash_sha256("original bytes"),
            size_bytes: 14,
        },
    );

    let (summary, settled) = push(&state, root.path(), &no_progress, &no_pre_write)
        .await
        .unwrap();

    assert_eq!(summary.uploaded, 1);
    assert!(settled.pending_creates.is_empty());
    assert_eq!(settled.object_map["note.md"].version, 2);
    assert_eq!(
        settled.object_map["note.md"].hash.as_deref(),
        Some(hash_sha256("edited after first attempt").as_str())
    );
}

#[tokio::test]
async fn legacy_create_response_with_newer_local_bytes_is_followed_by_an_update() {
    let root = TempRoot::new();
    std::fs::write(root.path().join("note.md"), "edited after first attempt").unwrap();
    let object_id = "01890000-0000-7000-8000-00000000e004";
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/collections/collection/blob-objects"))
        .and(header("mutation-id", object_id))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
            "object": {
                "id": object_id,
                "version": 1,
                "change_seq": 1,
                "blob_key": "original-blob"
            },
            "collectionVersion": 1
        })))
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
                "blob_key": "edited-blob"
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
            hash: hash_sha256("original bytes"),
            size_bytes: 14,
        },
    );

    let (summary, settled) = push(&state, root.path(), &no_progress, &no_pre_write)
        .await
        .unwrap();

    assert_eq!(summary.uploaded, 1);
    assert!(settled.pending_creates.is_empty());
    assert_eq!(settled.object_map["note.md"].version, 2);
    assert_eq!(
        settled.object_map["note.md"].hash.as_deref(),
        Some(hash_sha256("edited after first attempt").as_str())
    );
}

#[tokio::test]
async fn unchanged_replayed_create_keeps_the_returned_server_version() {
    let root = TempRoot::new();
    std::fs::write(root.path().join("note.md"), "original bytes").unwrap();
    let object_id = "01890000-0000-7000-8000-00000000e002";
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/collections/collection/blob-objects"))
        .and(header("mutation-id", object_id))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
            "object": {
                "id": object_id,
                "version": 4,
                "change_seq": 9,
                "blob_key": "possibly-newer-peer-blob"
            },
            "collectionVersion": 9,
            "replayed": true
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

    let (summary, settled) = push(&state, root.path(), &no_progress, &no_pre_write)
        .await
        .unwrap();

    assert_eq!(summary.uploaded, 1);
    assert!(settled.pending_creates.is_empty());
    assert_eq!(settled.object_map["note.md"].object_id, object_id);
    assert_eq!(settled.object_map["note.md"].version, 4);
    assert_eq!(
        settled.object_map["note.md"].blob_key,
        "possibly-newer-peer-blob"
    );
}
