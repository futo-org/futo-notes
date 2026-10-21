//! Pending creates and replay hydration: a restart pushes before any pull.

use super::*;

#[test]
fn pending_create_state_skips_bootstrap_pull() {
    let mut state = connected();
    assert!(needs_bootstrap(&state));
    state.pending_creates.insert(
        "note.md".into(),
        crate::checkpoint::PendingCreate {
            mutation_id: "01890000-0000-7000-8000-00000000f001".into(),
            original_name: "note.md".into(),
            hash: hash_sha256("local edit"),
            size_bytes: 10,
        },
    );
    assert!(!needs_bootstrap(&state));
}

#[tokio::test]
async fn pending_create_restart_pushes_before_any_pull() {
    use wiremock::matchers::{header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    let root = TempRoot::new();
    std::fs::write(root.path().join("note.md"), "newer local bytes").unwrap();
    let mutation_id = "01890000-0000-7000-8000-00000000f002";
    let object_id = "01890000-0000-7000-8000-00000000f102";
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/collections/collection/blob-objects"))
        .and(header("mutation-id", mutation_id))
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
                "blob_key": "successor-blob"
            },
            "collectionVersion": 2
        })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/collections/collection/objects"))
        .respond_with(ResponseTemplate::new(500))
        .expect(1)
        .mount(&server)
        .await;
    let mut state = connected();
    state.base_url = server.uri();
    state.pending_creates.insert(
        "note.md".into(),
        crate::checkpoint::PendingCreate {
            mutation_id: mutation_id.into(),
            original_name: "note.md".into(),
            hash: hash_sha256("older local bytes"),
            size_bytes: 17,
        },
    );

    let failure = cycle_with_checkpoint(
        &state,
        root.path(),
        &|_| {},
        &|_| {},
        &checkpoint::save,
        &crate::journal::SyncRunJournal::disabled(),
    )
    .await
    .expect_err("the injected pull failure should end the cycle after push");

    assert_eq!(failure.state.object_map["note.md"].version, 2);
    let requests = server.received_requests().await.unwrap();
    assert_eq!(
        requests
            .iter()
            .map(|request| request.url.path().to_owned())
            .collect::<Vec<_>>(),
        vec![
            "/api/collections/collection/blob-objects".to_owned(),
            format!("/api/collections/collection/blob-objects/{object_id}"),
            "/api/collections/collection/objects".to_owned(),
        ]
    );
}

#[tokio::test]
async fn never_committed_pending_create_is_cleared_before_pull() {
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    let root = TempRoot::new();
    let mutation_id = "01890000-0000-7000-8000-00000000f202";
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
    Mock::given(method("GET"))
        .and(path("/api/collections/collection/objects"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "objects": []
        })))
        .expect(1)
        .mount(&server)
        .await;
    let mut state = connected();
    state.base_url = server.uri();
    state.pending_creates.insert(
        "deleted.md".into(),
        crate::checkpoint::PendingCreate {
            mutation_id: mutation_id.into(),
            original_name: "deleted.md".into(),
            hash: hash_sha256("deleted locally"),
            size_bytes: 15,
        },
    );

    let Ok((_, settled)) = cycle_with_checkpoint(
        &state,
        root.path(),
        &|_| {},
        &no_pre,
        &checkpoint::save,
        &crate::journal::SyncRunJournal::disabled(),
    )
    .await
    else {
        panic!("the durable lookup proves the create never committed");
    };

    assert!(settled.pending_creates.is_empty());
    let requests = server.received_requests().await.unwrap();
    assert_eq!(
        requests
            .iter()
            .map(|request| request.url.path().to_owned())
            .collect::<Vec<_>>(),
        vec![
            format!("/api/collections/collection/create-mutations/{mutation_id}"),
            "/api/collections/collection/objects".to_owned(),
        ]
    );
}

#[tokio::test]
async fn in_progress_pending_create_stops_before_pull_and_remains_pending() {
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    let root = TempRoot::new();
    let mutation_id = "01890000-0000-7000-8000-00000000f203";
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(format!(
            "/api/collections/collection/create-mutations/{mutation_id}"
        )))
        .respond_with(ResponseTemplate::new(409))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/collections/collection/objects"))
        .respond_with(ResponseTemplate::new(500))
        .expect(0)
        .mount(&server)
        .await;
    let mut state = connected();
    state.base_url = server.uri();
    state.pending_creates.insert(
        "deleted.md".into(),
        crate::checkpoint::PendingCreate {
            mutation_id: mutation_id.into(),
            original_name: "deleted.md".into(),
            hash: hash_sha256("deleted locally"),
            size_bytes: 15,
        },
    );

    let failure = cycle_with_checkpoint(
        &state,
        root.path(),
        &|_| {},
        &no_pre,
        &checkpoint::save,
        &crate::journal::SyncRunJournal::disabled(),
    )
    .await
    .expect_err("an in-progress create must stop before pull");

    assert!(failure.state.pending_creates.contains_key("deleted.md"));
}

#[tokio::test]
async fn failed_mapped_upload_does_not_allow_pull_to_overwrite_the_dirty_path() {
    use futo_notes_core::e2ee;
    use wiremock::matchers::{method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    let root = TempRoot::new();
    std::fs::write(root.path().join("note.md"), "dirty local edit").unwrap();
    let server = MockServer::start().await;
    let remote = e2ee::aes_gcm_encrypt(
        &[5; 32],
        &e2ee::pack_note_v2("note.md", "newer remote edit"),
    )
    .unwrap();
    Mock::given(method("PUT"))
        .and(path(
            "/api/collections/collection/blob-objects/01890000-0000-7000-8000-00000000f003",
        ))
        .and(query_param("version", "2"))
        .respond_with(ResponseTemplate::new(500))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/collections/collection/objects"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "objects": [{
                "id": "01890000-0000-7000-8000-00000000f003",
                "version": 2,
                "change_seq": 2,
                "blob_key": "remote-blob",
                "updated_at": "2026-07-29T12:00:00Z"
            }]
        })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/blobs/remote-blob"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(remote))
        .expect(0)
        .mount(&server)
        .await;

    let mut state = connected();
    state.base_url = server.uri();
    state.max_version = 1;
    state.pull_cursor = 1;
    state.object_map.insert(
        "note.md".into(),
        ObjectState {
            object_id: "01890000-0000-7000-8000-00000000f003".into(),
            version: 1,
            blob_key: "base-blob".into(),
            hash: Some(hash_sha256("base bytes")),
            mtime_ms: None,
            size_bytes: Some(10),
        },
    );

    let result = cycle_with_checkpoint(
        &state,
        root.path(),
        &|_| {},
        &|_| {},
        &checkpoint::save,
        &crate::journal::SyncRunJournal::disabled(),
    )
    .await;
    let Ok((summary, next)) = result else {
        panic!("an item failure remains a completed cycle");
    };

    assert_eq!(
        std::fs::read_to_string(root.path().join("note.md")).unwrap(),
        "dirty local edit"
    );
    assert_eq!(summary.failures.len(), 1);
    assert_eq!(summary.failures[0].kind, FailureKind::Upload);
    assert_eq!(next.pull_cursor, 1);
}

#[test]
fn replay_hydration_rechecks_the_local_revision_before_writing() {
    let root = TempRoot::new();
    std::fs::write(root.path().join("note.md"), "edit made during replay").unwrap();
    let object_id = "01890000-0000-7000-8000-00000000f004";
    let mut state = connected();
    state.object_map.insert(
        "note.md".into(),
        ObjectState {
            object_id: object_id.into(),
            version: 0,
            blob_key: String::new(),
            hash: Some(hash_sha256("bytes from the original create")),
            mtime_ms: None,
            size_bytes: Some(30),
        },
    );
    let remote = remote(object_id, "note.md", "server replay bytes");
    let mut summary = SyncSummary::default();

    let result = apply_remote(
        &mut state,
        root.path(),
        &remote,
        &HashMap::new(),
        false,
        &no_pre,
        &mut summary,
    );

    assert!(result.is_err());
    assert_eq!(
        std::fs::read_to_string(root.path().join("note.md")).unwrap(),
        "edit made during replay"
    );
    assert_eq!(summary.downloaded, 0);
    assert_eq!(state.object_map["note.md"].version, 0);
}
