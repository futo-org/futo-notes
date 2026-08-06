use super::*;

#[tokio::test]
async fn restart_rebinds_a_uniquely_renamed_pending_create() {
    let root = TempRoot::new();
    std::fs::create_dir(root.path().join("new")).unwrap();
    std::fs::write(root.path().join("new/note.md"), "original bytes").unwrap();
    let mutation_id = "01890000-0000-7000-8000-00000000e004";
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/collections/collection/blob-objects"))
        .and(header("mutation-id", mutation_id))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
            "object": {
                "id": "server-object",
                "version": 1,
                "change_seq": 1,
                "blob_key": "blob"
            },
            "collectionVersion": 1,
            "replayed": false
        })))
        .expect(1)
        .mount(&server)
        .await;
    let mut state = connected();
    state.base_url = server.uri();
    state.pending_creates.insert(
        "old/note.md".into(),
        PendingCreate {
            mutation_id: mutation_id.into(),
            original_name: "old/note.md".into(),
            hash: hash_sha256("original bytes"),
            size_bytes: 14,
        },
    );

    let (summary, settled) = push(&state, root.path(), &no_progress, &no_pre_write)
        .await
        .unwrap();

    assert_eq!(summary.uploaded, 1);
    assert!(settled.pending_creates.is_empty());
    assert_eq!(settled.object_map["new/note.md"].object_id, "server-object");
}

#[tokio::test]
async fn restart_does_not_guess_between_ambiguous_pending_rename_matches() {
    let root = TempRoot::new();
    for folder in ["one", "two"] {
        std::fs::create_dir(root.path().join(folder)).unwrap();
        std::fs::write(root.path().join(format!("{folder}/note.md")), "same bytes").unwrap();
    }
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(500))
        .expect(0)
        .mount(&server)
        .await;
    let mut state = connected();
    state.base_url = server.uri();
    state.pending_creates.insert(
        "old/note.md".into(),
        PendingCreate {
            mutation_id: "01890000-0000-7000-8000-00000000e005".into(),
            original_name: "old/note.md".into(),
            hash: hash_sha256("same bytes"),
            size_bytes: 10,
        },
    );

    let (summary, next) = push(&state, root.path(), &no_progress, &no_pre_write)
        .await
        .unwrap();

    server.verify().await;
    assert_eq!(summary.uploaded, 0);
    assert_eq!(summary.failures.len(), 1);
    assert_eq!(summary.failures[0].kind, FailureKind::Upload);
    assert_eq!(next.pending_creates.len(), 1);
    assert!(next.object_map.is_empty());
}

#[tokio::test]
async fn restart_drops_pending_create_the_server_never_committed() {
    let root = TempRoot::new();
    let mutation_id = "01890000-0000-7000-8000-00000000e007";
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(format!(
            "/api/collections/collection/create-mutations/{mutation_id}"
        )))
        .respond_with(ResponseTemplate::new(404))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path(format!(
            "/api/collections/collection/objects/{mutation_id}"
        )))
        .respond_with(ResponseTemplate::new(404))
        .expect(0)
        .mount(&server)
        .await;
    let mut state = connected();
    state.base_url = server.uri();
    state.pending_creates.insert(
        "gone.md".into(),
        PendingCreate {
            mutation_id: mutation_id.into(),
            original_name: "gone.md".into(),
            hash: hash_sha256("never uploaded"),
            size_bytes: 14,
        },
    );

    let (_, settled) = push(&state, root.path(), &no_progress, &no_pre_write)
        .await
        .expect("a never-committed create must not fail the push");

    assert!(settled.pending_creates.is_empty());
    assert!(settled.object_map.is_empty());

    let (_, again) = push(&settled, root.path(), &no_progress, &no_pre_write)
        .await
        .expect("the next sync must not inherit the pending create");
    assert!(again.pending_creates.is_empty());
}

#[tokio::test]
async fn restart_deletes_a_committed_pending_create_removed_locally() {
    let root = TempRoot::new();
    let mutation_id = "01890000-0000-7000-8000-00000000e006";
    let object_id = "01890000-0000-7000-8000-00000000f006";
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(format!(
            "/api/collections/collection/create-mutations/{mutation_id}"
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "object": {
                "id": object_id,
                "version": 1,
                "change_seq": 1,
                "blob_key": "created-blob"
            },
            "collectionVersion": 1,
            "replayed": true
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
                "version": 2,
                "change_seq": 2,
                "deleted": true
            },
            "collectionVersion": 2
        })))
        .expect(1)
        .mount(&server)
        .await;
    let mut state = connected();
    state.base_url = server.uri();
    state.pending_creates.insert(
        "deleted.md".into(),
        PendingCreate {
            mutation_id: mutation_id.into(),
            original_name: "deleted.md".into(),
            hash: hash_sha256("deleted locally"),
            size_bytes: 15,
        },
    );

    let (summary, settled) = push(&state, root.path(), &no_progress, &no_pre_write)
        .await
        .unwrap();

    assert_eq!(summary.deleted, 1);
    assert!(settled.pending_creates.is_empty());
    assert!(settled.object_map.is_empty());
}
