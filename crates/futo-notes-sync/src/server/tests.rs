use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc};

use super::stalled_http::*;
use super::*;
use wiremock::matchers::{body_json, header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn batch_blob_frame(key: &str, status: u8, blob: &[u8]) -> Vec<u8> {
    let mut frame = Vec::new();
    frame.extend_from_slice(&(key.len() as u16).to_be_bytes());
    frame.extend_from_slice(key.as_bytes());
    frame.push(status);
    frame.extend_from_slice(&(blob.len() as u32).to_be_bytes());
    frame.extend_from_slice(blob);
    frame
}

fn batch_http(server: &MockServer) -> Http {
    Http::new(&server.uri()).unwrap().token("test-token")
}

struct KeepAliveServer {
    base_url: String,
    connections: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl KeepAliveServer {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let connections = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let server_connections = Arc::clone(&connections);
        let server_stop = Arc::clone(&stop);
        let handle = std::thread::spawn(move || {
            let mut handlers = Vec::new();
            while !server_stop.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        server_connections.fetch_add(1, Ordering::Relaxed);
                        let connection_stop = Arc::clone(&server_stop);
                        handlers.push(std::thread::spawn(move || {
                            serve_auth_mode_requests(stream, &connection_stop)
                        }));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::yield_now();
                    }
                    Err(error) => panic!("test server accept failed: {error}"),
                }
            }
            for handler in handlers {
                handler.join().unwrap();
            }
        });
        Self {
            base_url: format!("http://{address}"),
            connections,
            stop,
            handle: Some(handle),
        }
    }
}

impl Drop for KeepAliveServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = TcpStream::connect(self.base_url.trim_start_matches("http://"));
        if let Some(handle) = self.handle.take() {
            handle.join().unwrap();
        }
    }
}

fn serve_auth_mode_requests(mut stream: TcpStream, stop: &AtomicBool) {
    stream
        .set_read_timeout(Some(Duration::from_millis(10)))
        .unwrap();
    let mut request = Vec::new();
    let mut chunk = [0; 1024];
    while !stop.load(Ordering::Relaxed) {
        match stream.read(&mut chunk) {
            Ok(0) => return,
            Ok(read) => {
                request.extend_from_slice(&chunk[..read]);
                if request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                    stream
                        .write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 19\r\n\r\n{\"auth_mode\":\"dev\"}",
                        )
                        .unwrap();
                    stream.flush().unwrap();
                    request.clear();
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(_) => return,
        }
    }
}

#[test]
fn timestamp_matches_javascript_date_milliseconds() {
    assert_eq!(timestamp_ms("2026-06-05T12:34:56.789Z"), 1_780_662_896_789);
    assert_eq!(timestamp_ms("not a timestamp"), 0);
}

#[test]
fn numeric_wire_fields_accept_numbers_and_decimal_strings() {
    for version in [serde_json::json!(7), serde_json::json!("7")] {
        let value = serde_json::json!({
            "id": "o1",
            "version": version,
            "change_seq": "9",
            "size_bytes": "12"
        });
        let object: Object = serde_json::from_value(value).unwrap();
        assert_eq!(object.version, 7);
        assert_eq!(object.change_seq, 9);
        assert_eq!(object.size_bytes, Some(12));
    }
    assert!(serde_json::from_value::<Object>(serde_json::json!({
        "id":"o1", "version":"nope", "change_seq":1
    }))
    .is_err());
}

#[test]
fn unparseable_size_bytes_degrades_to_none() {
    for size in [
        serde_json::json!(1.5),
        serde_json::json!(-1),
        serde_json::json!("nope"),
        serde_json::json!(null),
        serde_json::json!({}),
    ] {
        let object: Object = serde_json::from_value(serde_json::json!({
            "id": "o1",
            "version": 1,
            "change_seq": 1,
            "size_bytes": size
        }))
        .unwrap();
        assert_eq!(object.size_bytes, None);
    }
}

#[test]
fn base_url_is_trimmed_and_requires_http() {
    assert_eq!(
        Http::new("  http://example.test///  ").unwrap().base,
        "http://example.test"
    );
    assert!(Http::new("ftp://example.test").is_err());
    assert!(Http::new("example.test").is_err());
}

#[tokio::test]
async fn independent_http_owners_do_not_share_connections() {
    let server = KeepAliveServer::start();

    assert_eq!(
        Http::new(&server.base_url)
            .unwrap()
            .auth_mode()
            .await
            .unwrap(),
        "dev"
    );
    assert_eq!(
        Http::new(&server.base_url)
            .unwrap()
            .auth_mode()
            .await
            .unwrap(),
        "dev"
    );

    assert_eq!(server.connections.load(Ordering::Relaxed), 2);
}

#[tokio::test]
async fn one_http_owner_reuses_its_connection() {
    let server = KeepAliveServer::start();
    let clients = HttpClients::new().unwrap();

    assert_eq!(
        clients
            .for_base(&server.base_url)
            .unwrap()
            .auth_mode()
            .await
            .unwrap(),
        "dev"
    );
    assert_eq!(
        clients
            .for_base(&server.base_url)
            .unwrap()
            .auth_mode()
            .await
            .unwrap(),
        "dev"
    );

    assert_eq!(server.connections.load(Ordering::Relaxed), 1);
}

#[test]
fn delete_response_can_omit_blob_key_and_updated_at() {
    let body: WriteBody = serde_json::from_value(serde_json::json!({
        "object": {
            "id":"o1",
            "version":"2",
            "change_seq":"8",
            "deleted":true
        },
        "collectionVersion":"8"
    }))
    .unwrap();
    assert!(body.object.deleted);
    assert!(body.object.blob_key.is_none());
    assert_eq!(body.object.updated_at, "");
    assert_eq!(body.collection_version, 8);
}

#[test]
fn transfer_timeout_scales_with_expected_bytes() {
    assert_eq!(transfer_timeout(0), REQUEST_TIMEOUT);
    assert_eq!(transfer_timeout(32 * 1024 * 1024), Duration::from_secs(286));
    assert_eq!(
        transfer_timeout(100 * 1024 * 1024),
        Duration::from_secs(830)
    );
}

#[test]
fn download_timeout_caps_untrusted_expected_size() {
    assert_eq!(download_timeout(u64::MAX), Duration::from_secs(830));
}

#[test]
fn upload_timeout_scales_past_the_download_cap() {
    assert_eq!(
        transfer_timeout(200 * 1024 * 1024),
        Duration::from_secs(1630)
    );
}

#[test]
fn dropping_before_a_request_wakes_the_server_listener() {
    let server = HangingServer::new(StallPoint::ResponseHeaders);
    let (dropped_tx, dropped_rx) = mpsc::channel();
    let drop_task = std::thread::spawn(move || {
        drop(server);
        dropped_tx.send(()).unwrap();
    });

    dropped_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("server drop remained blocked in accept");
    drop_task.join().unwrap();
}

#[tokio::test(start_paused = true)]
async fn ordinary_requests_have_a_total_timeout() {
    let server = HangingServer::new(StallPoint::ResponseHeaders);
    let http = Http::new(&server.base_url).unwrap().token("token");
    let request = tokio::spawn(async move { http.collections().await });
    server.wait_for_request().await;

    tokio::time::advance(REQUEST_TIMEOUT + Duration::from_millis(1)).await;
    allow_timeout_task_to_finish(&request).await;

    assert!(
        request.is_finished(),
        "ordinary request remained pending past the shared timeout"
    );
    assert!(request.await.unwrap().is_err());
}

#[tokio::test(start_paused = true)]
async fn ordinary_response_bodies_have_a_total_timeout() {
    let server = HangingServer::new(StallPoint::SuccessfulResponseBody);
    let http = Http::new(&server.base_url).unwrap().token("token");
    let request = tokio::spawn(async move { http.collections().await });
    server.wait_for_request().await;
    allow_network_task_to_settle().await;

    tokio::time::advance(REQUEST_TIMEOUT + Duration::from_millis(1)).await;
    allow_timeout_task_to_finish(&request).await;

    assert!(
        request.is_finished(),
        "ordinary request remained pending while reading its response body"
    );
    assert!(request.await.unwrap().is_err());
}

#[tokio::test(start_paused = true)]
async fn auth_mode_uses_the_short_probe_timeout() {
    let server = HangingServer::new(StallPoint::ResponseHeaders);
    let http = Http::new(&server.base_url).unwrap();
    let request = tokio::spawn(async move { http.auth_mode().await });
    server.wait_for_request().await;

    tokio::time::advance(PROBE_TIMEOUT + Duration::from_millis(1)).await;
    allow_timeout_task_to_finish(&request).await;

    assert!(
        request.is_finished(),
        "auth-mode probe remained pending past its shorter timeout"
    );
    assert!(request.await.unwrap().is_err());
}

#[tokio::test(start_paused = true)]
async fn blob_download_without_known_size_uses_the_base_request_timeout() {
    let server = HangingServer::new(StallPoint::ResponseHeaders);
    let http = Http::new(&server.base_url).unwrap().token("token");
    let request = tokio::spawn(async move { http.blob("blob-key", 0).await });
    server.wait_for_request().await;

    tokio::time::advance(REQUEST_TIMEOUT + Duration::from_millis(1)).await;
    allow_timeout_task_to_finish(&request).await;

    assert!(
        request.is_finished(),
        "blob download remained pending past the shared timeout"
    );
    assert!(request.await.unwrap().is_err());
}

#[tokio::test(start_paused = true)]
async fn blob_download_timeout_scales_with_expected_size() {
    let server = HangingServer::new(StallPoint::ResponseHeaders);
    let http = Http::new(&server.base_url).unwrap().token("token");
    let request = tokio::spawn(async move { http.blob("blob-key", 128 * 1024).await });
    server.wait_for_request().await;
    allow_network_task_to_settle().await;

    tokio::time::advance(REQUEST_TIMEOUT + Duration::from_millis(1)).await;
    allow_timeout_task_to_finish(&request).await;
    assert!(
        !request.is_finished(),
        "blob download ignored its expected-size timeout"
    );

    tokio::time::advance(Duration::from_secs(1)).await;
    allow_timeout_task_to_finish(&request).await;
    assert!(request.is_finished(), "blob download had no finite timeout");
    assert!(request.await.unwrap().is_err());
}

#[tokio::test(start_paused = true)]
async fn blob_upload_timeout_scales_with_payload_size() {
    let server = HangingServer::new(StallPoint::ResponseHeaders);
    let http = Http::new(&server.base_url).unwrap().token("token");
    let request = tokio::spawn(async move {
        http.create_object(
            "collection",
            "01890000-0000-7000-8000-00000000a004",
            vec![0; 128 * 1024],
        )
        .await
    });
    server.wait_for_request().await;
    allow_network_task_to_settle().await;

    tokio::time::advance(REQUEST_TIMEOUT + Duration::from_millis(1)).await;
    allow_timeout_task_to_finish(&request).await;
    assert!(
        !request.is_finished(),
        "blob upload ignored its payload-scaled timeout"
    );

    tokio::time::advance(Duration::from_secs(1)).await;
    allow_timeout_task_to_finish(&request).await;
    assert!(request.is_finished(), "blob upload had no finite timeout");
    assert!(request.await.unwrap().is_err());
}

#[tokio::test(start_paused = true)]
async fn event_stream_has_no_total_request_timeout() {
    let mut server = HangingServer::new(StallPoint::EventStreamBody);
    let http = Http::new(&server.base_url).unwrap().token("token");
    let response = tokio::spawn(async move { http.events().await });
    server.wait_for_request().await;
    let mut response = response.await.unwrap().unwrap();

    tokio::time::advance(REQUEST_TIMEOUT + Duration::from_millis(1)).await;
    server.release();

    let chunk = response.chunk().await.unwrap().unwrap();
    assert_eq!(chunk, "event: ready\ndata:\n\n");
}

#[tokio::test(start_paused = true)]
async fn event_stream_response_headers_have_a_timeout() {
    let server = HangingServer::new(StallPoint::ResponseHeaders);
    let http = Http::new(&server.base_url).unwrap().token("token");
    let request = tokio::spawn(async move { http.events().await });
    server.wait_for_request().await;
    allow_network_task_to_settle().await;

    tokio::time::advance(REQUEST_TIMEOUT + Duration::from_millis(1)).await;
    allow_timeout_task_to_finish(&request).await;

    assert!(
        request.is_finished(),
        "event stream remained pending while waiting for response headers"
    );
    assert!(request.await.unwrap().is_err());
}

#[tokio::test(start_paused = true)]
async fn event_stream_error_body_has_a_timeout() {
    let server = HangingServer::new(StallPoint::ErrorBody);
    let http = Http::new(&server.base_url).unwrap().token("token");
    let request = tokio::spawn(async move { http.events().await });
    server.wait_for_request().await;
    allow_network_task_to_settle().await;

    tokio::time::advance(REQUEST_TIMEOUT + Duration::from_millis(1)).await;
    allow_timeout_task_to_finish(&request).await;

    assert!(
        request.is_finished(),
        "event stream remained pending while reading an error response body"
    );
    let error = request.await.unwrap().unwrap_err();
    assert_eq!(error.status, Some(500));
}

#[tokio::test]
async fn batch_blob_request_uses_json_and_preserves_server_order() {
    let server = MockServer::start().await;
    let mut response = batch_blob_frame("key-1", 0, b"one");
    response.extend(batch_blob_frame("key-2", 1, b""));
    Mock::given(method("POST"))
        .and(path("/api/blobs/batch"))
        .and(header("authorization", "Bearer test-token"))
        .and(body_json(serde_json::json!({"keys":["key-1","key-2"]})))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(response))
        .mount(&server)
        .await;

    let result = batch_http(&server)
        .blobs_batch(&["key-1".into(), "key-2".into()], 3)
        .await
        .unwrap();
    assert_eq!(result[0].key, "key-1");
    assert_eq!(result[1].status, BatchBlobStatus::Missing);
}

#[tokio::test]
async fn batch_endpoint_404s_are_preserved_for_transfer_fallback() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(404))
        .mount(&server)
        .await;
    let http = batch_http(&server);
    assert!(http
        .blobs_batch(&["key".into()], 0)
        .await
        .unwrap_err()
        .is(404));
    assert!(http
        .write_objects_batch(
            "collection",
            &[BatchWriteEntry {
                operation: BatchWriteOperation::Create {
                    mutation_id: "01890000-0000-7000-8000-00000000a002".into(),
                },
                ciphertext: vec![1],
            }],
        )
        .await
        .unwrap_err()
        .is(404));
}

#[tokio::test]
async fn classic_create_sends_the_mutation_id_and_accepts_server_generated_object_ids() {
    let server = MockServer::start().await;
    let mutation_id = "01890000-0000-7000-8000-00000000a003";
    Mock::given(method("POST"))
        .and(path("/api/collections/collection/blob-objects"))
        .and(header("mutation-id", mutation_id))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
            "object": {
                "id": "legacy-server-id",
                "version": 1,
                "change_seq": 2,
                "blob_key": "legacy-blob"
            },
            "collectionVersion": 2,
            "replayed": false
        })))
        .expect(1)
        .mount(&server)
        .await;

    let result = batch_http(&server)
        .create_object("collection", mutation_id, vec![1, 2, 3])
        .await
        .unwrap();

    assert_eq!(result.replayed, Some(false));
    assert_eq!(result.write.object.id, "legacy-server-id");
}

/// A stand-in for the hyper/h2/io layers reqwest nests underneath itself.
#[derive(Debug)]
struct Layer(&'static str, Option<Box<Layer>>);

impl std::fmt::Display for Layer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}

impl std::error::Error for Layer {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.1
            .as_deref()
            .map(|layer| layer as &dyn std::error::Error)
    }
}

#[test]
fn error_chain_keeps_the_root_cause_and_drops_repeated_layers() {
    let nested = Layer(
        "error sending request",
        Some(Box::new(Layer(
            "client error (Connect)",
            Some(Box::new(Layer(
                "tcp connect error: No route to host (os error 65)",
                None,
            ))),
        ))),
    );
    assert_eq!(
        error_chain(&nested),
        "error sending request: client error (Connect): \
         tcp connect error: No route to host (os error 65)"
    );

    // hyper prints its source verbatim inside its own Display; appending it
    // again would say the same thing twice.
    let echoed = Layer(
        "error sending request: connection closed",
        Some(Box::new(Layer("connection closed", None))),
    );
    assert_eq!(
        error_chain(&echoed),
        "error sending request: connection closed"
    );
}

/// The regression this pairs with: a real transport failure used to reach the
/// user and the instance journal as the bare "error sending request for url
/// (…)" line, which named no cause. Port 1 on loopback refuses instantly.
#[tokio::test]
async fn a_refused_connection_names_its_cause_not_just_the_url() {
    let error = Http::new("http://127.0.0.1:1")
        .unwrap()
        .auth_mode()
        .await
        .expect_err("nothing listens on port 1");

    assert_eq!(error.status, None);
    let message = error.message.to_lowercase();
    assert!(
        message.contains("refused") || message.contains("os error"),
        "transport error must name its cause, got: {}",
        error.message
    );
}
