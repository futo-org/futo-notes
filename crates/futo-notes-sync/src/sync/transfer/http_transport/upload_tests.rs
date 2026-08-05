use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use crate::checkpoint::PendingCreate;
use crate::server::Http;
use crate::sync::chunking::{MAX_BATCH_ENTRIES, TARGET_CHUNK_BYTES};
use crate::sync::transfer::{UploadCandidate, UploadTarget};
use crate::sync::vault::LocalFile;

use super::upload::*;
use super::upload_batch::{run_batch, BatchOutcome};

fn candidate(order: usize) -> UploadCandidate {
    candidate_with_ciphertext(order, 3)
}

fn candidate_with_ciphertext(order: usize, ciphertext_len: usize) -> UploadCandidate {
    UploadCandidate {
        file: LocalFile {
            name: format!("note-{order}.md"),
            mtime: 1,
            size: 4,
        },
        target: UploadTarget::Create(PendingCreate {
            mutation_id: format!("01890000-0000-7000-8000-{order:012x}"),
            original_name: format!("note-{order}.md"),
            hash: "hash".into(),
            size_bytes: 4,
        }),
        content: "body".into(),
        hash: "hash".into(),
        ciphertext: vec![1; ciphertext_len],
        local_was_rename: false,
    }
}

fn successful_batch_response(request: &wiremock::Request) -> ResponseTemplate {
    let mut offset = 0;
    let mut results = Vec::new();
    while offset < request.body.len() {
        offset += 1;
        let id_len = u16::from_be_bytes([request.body[offset], request.body[offset + 1]]) as usize;
        offset += 2;
        let id = String::from_utf8(request.body[offset..offset + id_len].to_vec()).unwrap();
        offset += id_len + 4;
        let ciphertext_len = u32::from_be_bytes([
            request.body[offset],
            request.body[offset + 1],
            request.body[offset + 2],
            request.body[offset + 3],
        ]) as usize;
        offset += 4 + ciphertext_len;
        results.push(serde_json::json!({
            "status": "created",
            "object": {
                "id": id,
                "version": 1,
                "change_seq": results.len() + 1,
                "blob_key": format!("blob-{}", results.len() + 1)
            },
            "collectionVersion": results.len() + 1
        }));
    }
    ResponseTemplate::new(200).set_body_json(serde_json::json!({ "results": results }))
}

#[tokio::test]
async fn batch_404_sets_the_push_wide_fallback_flag() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/collections/collection/blob-objects/batch"))
        .respond_with(ResponseTemplate::new(404))
        .expect(1)
        .mount(&server)
        .await;
    let http = Http::new(&server.uri()).unwrap();
    let unsupported = Arc::new(AtomicBool::new(false));

    let first = run_batch(
        http.clone(),
        "collection".into(),
        Arc::new(vec![candidate(0), candidate(1)]),
        unsupported.clone(),
    )
    .await;
    let second = run_batch(
        http,
        "collection".into(),
        Arc::new(vec![candidate(2), candidate(3)]),
        unsupported.clone(),
    )
    .await;

    assert!(unsupported.load(Ordering::Relaxed));
    assert!(matches!(first, BatchOutcome::Classic));
    assert!(matches!(second, BatchOutcome::Classic));
}

#[tokio::test]
async fn retryable_batch_failure_retries_twice_then_degrades_to_classic() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/collections/collection/blob-objects/batch"))
        .respond_with(ResponseTemplate::new(500))
        .expect(3)
        .mount(&server)
        .await;

    let dispatched = run_batch(
        Http::new(&server.uri()).unwrap(),
        "collection".into(),
        Arc::new(vec![candidate(0), candidate(1)]),
        Arc::new(AtomicBool::new(false)),
    )
    .await;
    assert!(matches!(dispatched, BatchOutcome::Classic));
}

#[tokio::test]
async fn encoded_batch_requests_never_exceed_the_wire_byte_cap() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/collections/collection/blob-objects/batch"))
        .respond_with(successful_batch_response)
        .mount(&server)
        .await;
    let mut dispatcher = UploadDispatcher::new(&Http::new(&server.uri()).unwrap(), "collection");
    let ciphertext_len = TARGET_CHUNK_BYTES as usize / MAX_BATCH_ENTRIES;

    for index in 0..MAX_BATCH_ENTRIES * 2 {
        let _ = dispatcher
            .push(candidate_with_ciphertext(index, ciphertext_len))
            .await;
    }
    let _ = dispatcher.flush().await;
    while dispatcher.next_completed().await.is_some() {}

    let requests = server.received_requests().await.unwrap();
    assert!(requests.len() > 1);
    assert!(requests
        .iter()
        .all(|request| request.body.len() as u64 <= TARGET_CHUNK_BYTES));
}
