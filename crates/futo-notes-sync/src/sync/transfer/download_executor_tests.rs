use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futo_notes_core::e2ee;
use wiremock::matchers::{body_json, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use crate::sync::encrypted_note::RemoteNote;
use crate::sync::{SyncFailure, SyncProgress};

use super::*;

const KEY: [u8; 32] = [7; 32];

fn no_progress(_: SyncProgress) {}

fn object(id: &str, key: &str, size: u64) -> Object {
    Object {
        id: id.into(),
        version: 1,
        change_seq: 1,
        deleted: false,
        blob_key: Some(key.into()),
        size_bytes: Some(size),
        updated_at: String::new(),
    }
}

fn ciphertext(name: &str, content: &str) -> Vec<u8> {
    e2ee::aes_gcm_encrypt(&KEY, &e2ee::pack_note_v2(name, content)).unwrap()
}

fn frame(key: &str, status: u8, blob: &[u8]) -> Vec<u8> {
    let mut frame = Vec::new();
    frame.extend_from_slice(&(key.len() as u16).to_be_bytes());
    frame.extend_from_slice(key.as_bytes());
    frame.push(status);
    frame.extend_from_slice(&(blob.len() as u32).to_be_bytes());
    frame.extend_from_slice(blob);
    frame
}

async fn collect_downloads(
    server: &MockServer,
    objects: Vec<Object>,
) -> HashMap<String, Result<RemoteNote, SyncFailure>> {
    let mut results = HashMap::new();
    download_stage(
        &Http::new(&server.uri()).unwrap(),
        &KEY,
        objects,
        &no_progress,
        |completed| {
            results.extend(
                completed
                    .into_iter()
                    .map(|(object, result)| (object.id, result)),
            );
            Ok(())
        },
    )
    .await
    .unwrap();
    results
}

#[tokio::test]
async fn batch_404_sets_the_pull_wide_fallback_flag() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/blobs/batch"))
        .respond_with(ResponseTemplate::new(404))
        .expect(1)
        .mount(&server)
        .await;
    let http = Http::new(&server.uri()).unwrap();
    let unsupported = Arc::new(AtomicBool::new(false));
    let objects = vec![object("o1", "b1", 10), object("o2", "b2", 10)];

    let first = run_batch_job(http.clone(), KEY, objects.clone(), unsupported.clone()).await;
    let second = run_batch_job(http, KEY, objects, unsupported.clone()).await;

    assert!(unsupported.load(Ordering::Relaxed));
    assert_eq!(first.retry_as_singles.len(), 2);
    assert_eq!(second.retry_as_singles.len(), 2);
}

#[tokio::test]
async fn omitted_entries_are_requested_in_a_fresh_batch() {
    let server = MockServer::start().await;
    let first_ciphertext = ciphertext("one.md", "one");
    let second_ciphertext = ciphertext("two.md", "two");
    let mut first_response = frame("b1", 0, &first_ciphertext);
    first_response.extend(frame("b2", 2, b""));
    Mock::given(method("POST"))
        .and(path("/api/blobs/batch"))
        .and(body_json(serde_json::json!({"keys":["b1","b2"]})))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(first_response))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/blobs/batch"))
        .and(body_json(serde_json::json!({"keys":["b2"]})))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(frame("b2", 0, &second_ciphertext)))
        .expect(1)
        .mount(&server)
        .await;

    let results = collect_downloads(
        &server,
        vec![object("o1", "b1", 10), object("o2", "b2", 10)],
    )
    .await;

    assert_eq!(results.len(), 2);
    assert!(matches!(results["o1"], Ok(ref note) if note.content == "one"));
    assert!(matches!(results["o2"], Ok(ref note) if note.content == "two"));
}

#[tokio::test]
async fn retryable_batch_failure_retries_twice_then_degrades_to_singles() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/blobs/batch"))
        .respond_with(ResponseTemplate::new(500))
        .expect(3)
        .mount(&server)
        .await;
    for (blob_key, name, content) in [("b1", "one.md", "one"), ("b2", "two.md", "two")] {
        Mock::given(method("GET"))
            .and(path(format!("/api/blobs/{blob_key}")))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(ciphertext(name, content)))
            .expect(1)
            .mount(&server)
            .await;
    }

    let results = collect_downloads(
        &server,
        vec![object("o1", "b1", 10), object("o2", "b2", 10)],
    )
    .await;

    assert!(results.values().all(Result::is_ok));
}

#[tokio::test]
async fn non_retryable_batch_4xx_degrades_without_backoff() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/blobs/batch"))
        .respond_with(ResponseTemplate::new(401))
        .expect(1)
        .mount(&server)
        .await;
    for (blob_key, name) in [("b1", "one.md"), ("b2", "two.md")] {
        Mock::given(method("GET"))
            .and(path(format!("/api/blobs/{blob_key}")))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(ciphertext(name, name)))
            .mount(&server)
            .await;
    }
    let started = std::time::Instant::now();
    let results = collect_downloads(
        &server,
        vec![object("o1", "b1", 10), object("o2", "b2", 10)],
    )
    .await;
    assert!(results.values().all(Result::is_ok));
    assert!(started.elapsed() < Duration::from_secs(2));
}

#[test]
fn multi_chunk_download_reports_each_completed_blob() {
    let events = Arc::new(Mutex::new(Vec::new()));
    let recorded_events = events.clone();
    let record_progress = move |event| recorded_events.lock().unwrap().push(event);
    let mut progress = DownloadProgress::new(&record_progress, 102);

    progress.complete(100);
    progress.complete(2);

    let events = events.lock().unwrap();
    assert_eq!(events.len(), 103, "initial event plus one per blob");
    assert_eq!(
        events.iter().map(|event| event.current).collect::<Vec<_>>(),
        (0..=102).collect::<Vec<_>>()
    );
    assert!(events
        .iter()
        .all(|event| event.phase == "pulling" && event.total == 102));
}
