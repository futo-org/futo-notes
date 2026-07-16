use std::fs;

use futo_notes_ffi::{
    ConnectInfo, SyncClient, SyncError, SyncEventListener, SyncFailure, SyncStatus, SyncSummary,
};

mod support;

use support::{path_string, TempTree};

#[test]
fn sync_records_errors_callbacks_and_threading_keep_the_full_semantic_shape() {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<SyncClient>();
    assert_send_sync::<ContractListener>();

    let ConnectInfo {
        user_id,
        collection_id,
        auth_mode,
    } = ConnectInfo {
        user_id: "user".to_owned(),
        collection_id: "collection".to_owned(),
        auth_mode: "password".to_owned(),
    };
    assert_eq!(
        (user_id.as_str(), collection_id.as_str(), auth_mode.as_str()),
        ("user", "collection", "password")
    );

    let SyncFailure {
        filename,
        kind,
        status_code,
    } = SyncFailure {
        filename: "note.md".to_owned(),
        kind: "upload".to_owned(),
        status_code: Some(409),
    };
    assert_eq!(
        (filename.as_str(), kind.as_str(), status_code),
        ("note.md", "upload", Some(409))
    );

    let SyncSummary {
        uploaded,
        downloaded,
        deleted,
        conflicts,
        local_writes_applied,
        failures,
        failure_message,
    } = SyncSummary {
        uploaded: 1,
        downloaded: 2,
        deleted: 3,
        conflicts: 4,
        local_writes_applied: 5,
        failures: Vec::new(),
        failure_message: Some("failure".to_owned()),
    };
    assert_eq!(
        (
            uploaded,
            downloaded,
            deleted,
            conflicts,
            local_writes_applied,
            failures.len(),
            failure_message.as_deref(),
        ),
        (1, 2, 3, 4, 5, 0, Some("failure"))
    );

    let SyncStatus {
        connected,
        server_url,
        user_id,
        collection_id,
        max_version,
        object_count,
    } = SyncStatus {
        connected: true,
        server_url: Some("https://sync.example".to_owned()),
        user_id: Some("user".to_owned()),
        collection_id: Some("collection".to_owned()),
        max_version: 9,
        object_count: 10,
    };
    assert!(connected);
    assert_eq!(server_url.as_deref(), Some("https://sync.example"));
    assert_eq!(user_id.as_deref(), Some("user"));
    assert_eq!(collection_id.as_deref(), Some("collection"));
    assert_eq!((max_version, object_count), (9, 10));

    assert_eq!(SyncError::Http("x".to_owned()).to_string(), "HTTP error: x");
    assert_eq!(
        SyncError::Crypto("x".to_owned()).to_string(),
        "crypto error: x"
    );
    assert_eq!(SyncError::Io("x".to_owned()).to_string(), "I/O error: x");
    assert_eq!(SyncError::Auth("x".to_owned()).to_string(), "auth error: x");
    assert_eq!(
        SyncError::CollectionGone("collection-gone: x".to_owned()).to_string(),
        "collection-gone: x"
    );
    assert_eq!(SyncError::NotConnected.to_string(), "not connected");
}

struct ContractListener;

impl SyncEventListener for ContractListener {
    fn on_synced(&self, _summary: SyncSummary) {}

    fn on_connected(&self) {}

    fn on_error(&self, _message: String) {}

    fn on_stopped(&self) {}
}

#[tokio::test]
async fn disconnected_sync_client_has_stable_lifecycle_semantics() {
    let temp = TempTree::new();
    let notes_root = temp.path("vault");
    fs::create_dir_all(&notes_root).unwrap();

    let client = SyncClient::new(path_string(&notes_root), "https://sync.example".to_owned());
    let SyncStatus {
        connected,
        server_url,
        user_id,
        collection_id,
        max_version,
        object_count,
    } = client.status();
    assert!(!connected);
    assert!(server_url.is_none());
    assert!(user_id.is_none());
    assert!(collection_id.is_none());
    assert_eq!(max_version, 0);
    assert_eq!(object_count, 0);

    client.note_changed();
    client.stop_live();
    assert!(matches!(
        client.sync_now().await,
        Err(SyncError::NotConnected)
    ));
    assert!(matches!(
        client.clone().start_live(Box::new(ContractListener)).await,
        Err(SyncError::NotConnected)
    ));
    client.disconnect().await.unwrap();
}
