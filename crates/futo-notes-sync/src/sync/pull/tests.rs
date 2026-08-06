use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futo_notes_core::e2ee;
use futo_notes_core::hash::hash_sha256;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use super::*;
use crate::checkpoint::ObjectState;
use crate::sync::test_support::ResponseGate;

struct TempRoot(PathBuf);

impl TempRoot {
    fn new() -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let sequence = COUNTER.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "futo-sync-pull-test-{}-{sequence}",
            futo_notes_core::files::now_ms()
        ));
        std::fs::create_dir_all(&root).unwrap();
        Self(root)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn connected_state(server: &MockServer, vault_key: [u8; 32]) -> ConnectedState {
    ConnectedState {
        base_url: server.uri(),
        token: "token".into(),
        user_id: "user".into(),
        collection_id: "collection".into(),
        vault_key,
        object_map: HashMap::new(),
        pending_creates: HashMap::new(),
        max_version: 0,
        pull_cursor: 0,
        oversize_skip: HashMap::new(),
    }
}

fn batch_frame(key: &str, ciphertext: &[u8]) -> Vec<u8> {
    let mut frame = Vec::new();
    frame.extend_from_slice(&(key.len() as u16).to_be_bytes());
    frame.extend_from_slice(key.as_bytes());
    frame.push(0);
    frame.extend_from_slice(&(ciphertext.len() as u32).to_be_bytes());
    frame.extend_from_slice(ciphertext);
    frame
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn completed_batch_is_applied_and_checkpointed_before_a_slow_single_finishes() {
    const KEY: [u8; 32] = [5; 32];
    let server = MockServer::start().await;
    let root = TempRoot::new();
    let first = e2ee::aes_gcm_encrypt(&KEY, &e2ee::pack_note_v2("first.md", "one")).unwrap();
    let second = e2ee::aes_gcm_encrypt(&KEY, &e2ee::pack_note_v2("second.md", "two")).unwrap();
    let slow = e2ee::aes_gcm_encrypt(&KEY, &e2ee::pack_note_v2("slow.md", "three")).unwrap();

    Mock::given(method("GET"))
        .and(path("/api/collections/collection/objects"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "objects": [
                {"id":"o1","version":1,"change_seq":1,"blob_key":"b1","size_bytes":first.len(),"updated_at":""},
                {"id":"o2","version":1,"change_seq":2,"blob_key":"b2","size_bytes":second.len(),"updated_at":""},
                {"id":"o3","version":1,"change_seq":3,"blob_key":"b3","updated_at":""}
            ]
        })))
        .mount(&server)
        .await;
    let mut batch = batch_frame("b1", &first);
    batch.extend(batch_frame("b2", &second));
    Mock::given(method("POST"))
        .and(path("/api/blobs/batch"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(batch))
        .mount(&server)
        .await;
    let slow_download = ResponseGate::default();
    let response_gate = slow_download.clone();
    Mock::given(method("GET"))
        .and(path("/api/blobs/b3"))
        .respond_with(move |_: &wiremock::Request| {
            response_gate.block_response();
            ResponseTemplate::new(200).set_body_bytes(slow.clone())
        })
        .mount(&server)
        .await;

    let state = connected_state(&server, KEY);
    let pull_future = pull(&state, root.path(), 0, &|_| {}, &|_| {});
    tokio::pin!(pull_future);
    tokio::select! {
        _ = slow_download.wait_until_blocked() => {}
        result = &mut pull_future => {
            panic!("pull finished before the single response was blocked: {result:?}")
        }
    }

    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            tokio::select! {
                result = &mut pull_future => {
                    panic!("pull finished while the single download was blocked: {result:?}")
                }
                _ = tokio::time::sleep(Duration::from_millis(5)) => {
                    if root.path().join("first.md").exists()
                        && root.path().join("second.md").exists()
                    {
                        return;
                    }
                }
            }
        }
    })
    .await
    .expect("the completed batch was not applied while the single download was blocked");

    let interim = checkpoint::load(root.path(), "collection");
    assert_eq!(interim.pull_cursor, 0, "interim cursor must force a relist");
    assert_eq!(interim.object_map.len(), 2);

    slow_download.release();
    let (summary, next) = pull_future.await.unwrap();
    assert!(summary.failures.is_empty());
    assert_eq!(next.pull_cursor, 3);
    assert_eq!(next.object_map.len(), 3);
}

#[tokio::test]
async fn pull_skips_current_objects_before_download() {
    const KEY: [u8; 32] = [5; 32];
    let server = MockServer::start().await;
    let root = TempRoot::new();
    std::fs::write(root.path().join("note.md"), "body").unwrap();
    let local = super::super::vault::local_files(root.path())
        .unwrap()
        .remove(0);
    let ciphertext = e2ee::aes_gcm_encrypt(&KEY, &e2ee::pack_note_v2("note.md", "body")).unwrap();

    Mock::given(method("GET"))
        .and(path("/api/collections/collection/objects"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "objects": [{
                "id": "o1",
                "version": 1,
                "change_seq": 1,
                "blob_key": "b1",
                "size_bytes": ciphertext.len(),
                "updated_at": "2026-06-05T12:34:56.789Z"
            }]
        })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/blobs/b1"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(ciphertext))
        .expect(0)
        .mount(&server)
        .await;

    let mut state = connected_state(&server, KEY);
    state.object_map.insert(
        "note.md".into(),
        ObjectState {
            object_id: "o1".into(),
            version: 1,
            blob_key: "b1".into(),
            hash: Some(hash_sha256("body")),
            mtime_ms: Some(local.mtime),
            size_bytes: Some(local.size),
        },
    );
    state.max_version = 1;
    let events = Arc::new(Mutex::new(Vec::new()));
    let recorded_events = events.clone();
    let progress = move |event| recorded_events.lock().unwrap().push(event);

    let (summary, next) = pull(&state, root.path(), 0, &progress, &|_| {})
        .await
        .unwrap();

    assert!(summary.failures.is_empty());
    assert_eq!(next.pull_cursor, 1);
    let events = events.lock().unwrap();
    assert_eq!(
        events
            .iter()
            .map(|event| (event.current, event.total))
            .collect::<Vec<_>>(),
        [(0, 0)]
    );
}
