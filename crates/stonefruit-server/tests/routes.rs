use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex, RwLock};
use tempfile::TempDir;
use tower::ServiceExt;

use stonefruit_core::hash::{hash_sha256, hash_sha256_bytes};
use stonefruit_server::app::{build_router, AppState};
use stonefruit_server::db;
use stonefruit_server::indexer::IndexerStatus;

fn test_env_with_handles() -> (
    axum::Router,
    TempDir,
    Arc<Mutex<rusqlite::Connection>>,
    Arc<RwLock<IndexerStatus>>,
) {
    let tmp = TempDir::new().unwrap();
    let notes_dir = tmp.path().join("notes");
    std::fs::create_dir_all(&notes_dir).unwrap();
    let conn = Arc::new(Mutex::new(db::open_memory_db().unwrap()));
    let (tx, _rx) = tokio::sync::mpsc::channel(1);
    let indexer_status = Arc::new(RwLock::new(IndexerStatus::default()));
    let state = AppState {
        db: conn.clone(),
        notes_dir,
        indexer_tx: tx,
        indexer_status: indexer_status.clone(),
    };
    (build_router(state), tmp, conn, indexer_status)
}

fn test_env() -> (axum::Router, TempDir) {
    let (router, tmp, _conn, _status) = test_env_with_handles();
    (router, tmp)
}

fn test_env_with_indexer_rx() -> (
    axum::Router,
    TempDir,
    tokio::sync::mpsc::Receiver<stonefruit_server::indexer::IndexerCommand>,
) {
    let tmp = TempDir::new().unwrap();
    let notes_dir = tmp.path().join("notes");
    std::fs::create_dir_all(&notes_dir).unwrap();
    let conn = Arc::new(Mutex::new(db::open_memory_db().unwrap()));
    let (tx, rx) = tokio::sync::mpsc::channel(4);
    let indexer_status = Arc::new(RwLock::new(IndexerStatus::default()));
    let state = AppState {
        db: conn,
        notes_dir,
        indexer_tx: tx,
        indexer_status,
    };
    (build_router(state), tmp, rx)
}

async fn json_request(
    router: &axum::Router,
    method: &str,
    path: &str,
    body: Option<Value>,
    token: Option<&str>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if let Some(t) = token {
        builder = builder.header("authorization", format!("Bearer {t}"));
    }
    let body = match body {
        Some(v) => Body::from(serde_json::to_vec(&v).unwrap()),
        None => Body::empty(),
    };
    let req = builder.body(body).unwrap();
    let resp = router.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let value: Value = serde_json::from_slice(&bytes).unwrap_or(json!(null));
    (status, value)
}

async fn text_request(
    router: &axum::Router,
    method: &str,
    path: &str,
    token: Option<&str>,
) -> (StatusCode, String) {
    let mut builder = Request::builder().method(method).uri(path);
    if let Some(t) = token {
        builder = builder.header("authorization", format!("Bearer {t}"));
    }
    let req = builder.body(Body::empty()).unwrap();
    let resp = router.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let body = String::from_utf8(bytes.to_vec()).unwrap();
    (status, body)
}

async fn setup_and_login(router: &axum::Router) -> String {
    json_request(
        router,
        "POST",
        "/setup",
        Some(json!({ "password": "testpass123" })),
        None,
    )
    .await;
    let (_, body) = json_request(
        router,
        "POST",
        "/login",
        Some(json!({ "password": "testpass123" })),
        None,
    )
    .await;
    body["token"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn dashboard_root_returns_old_html_with_theme_toggle() {
    let (router, _tmp) = test_env();

    let (status, body) = text_request(&router, "GET", "/", None).await;

    assert_eq!(status, StatusCode::OK);
    assert!(body.contains("<!DOCTYPE html>"));
    assert!(body.contains("<title>Stonefruit — Server Dashboard</title>"));
    assert!(body.contains("Server Dashboard"));
    assert!(body.contains("id=\"theme-auto-btn\""));
    assert!(body.contains("id=\"theme-dark-btn\""));
    assert!(body.contains("id=\"theme-light-btn\""));
    assert!(body.contains("function handleThemeChange()"));
    assert!(body.contains("localStorage.getItem('dashboard_theme')"));
    assert!(body.contains("@media (prefers-color-scheme: light)"));
}

#[tokio::test]
async fn dashboard_status_requires_auth() {
    let (router, _tmp) = test_env();

    let (status, body) = json_request(&router, "GET", "/dashboard/status", None, None).await;

    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"], "Missing Authorization header");
}

#[tokio::test]
async fn dashboard_status_returns_metrics_for_authenticated_session() {
    let (router, _tmp) = test_env();
    let token = setup_and_login(&router).await;

    let (sync_status, _) = json_request(
        &router,
        "POST",
        "/sync",
        Some(json!({
            "device_id": "dashboard-dev",
            "inventory": [],
            "changed": [],
            "new": [{ "filename": "dashboard-note.md", "content": "# Dashboard", "hash": hash_sha256("# Dashboard") }],
            "deleted": []
        })),
        Some(&token),
    )
    .await;
    assert_eq!(sync_status, StatusCode::OK);

    let (status, body) =
        json_request(&router, "GET", "/dashboard/status", None, Some(&token)).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["notes_count"], 1);
    assert_eq!(body["sessions_count"], 1);
    assert_eq!(body["setup_complete"], true);
    assert_eq!(body["search"]["enabled"], false);
    assert!(body["plugins"].is_null());
    assert!(body["uptime_seconds"].as_u64().is_some());
}

// ── Sync route tests ───────────────────────────────────────────────────

#[tokio::test]
async fn sync_requires_auth() {
    let (router, _tmp) = test_env();
    let (status, body) = json_request(
        &router,
        "POST",
        "/sync",
        Some(json!({
            "device_id": "d",
            "inventory": [],
            "changed": [],
            "new": [],
            "deleted": []
        })),
        None, // no token
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(body["error"].as_str().is_some());
}

#[tokio::test]
async fn sync_roundtrip_over_http() {
    let (router, tmp) = test_env();
    let token = setup_and_login(&router).await;

    let content = "# Hello HTTP";
    let hash = hash_sha256(content);

    // Create a note via sync
    let (status, body) = json_request(
        &router,
        "POST",
        "/sync",
        Some(json!({
            "device_id": "dev-1",
            "inventory": [],
            "changed": [],
            "new": [{ "filename": "hello.md", "content": content, "hash": hash }],
            "deleted": []
        })),
        Some(&token),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["version"].as_u64().unwrap() > 0);

    // Verify file exists on disk
    let file_content = std::fs::read_to_string(tmp.path().join("notes/hello.md")).unwrap();
    assert_eq!(file_content, content);

    // Another device syncs — should get the note
    let (status, body) = json_request(
        &router,
        "POST",
        "/sync",
        Some(json!({
            "device_id": "dev-2",
            "inventory": [],
            "changed": [],
            "new": [],
            "deleted": []
        })),
        Some(&token),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let updates = body["update"].as_array().unwrap();
    assert_eq!(updates.len(), 1);
    assert_eq!(updates[0]["filename"], "hello.md");
    assert_eq!(updates[0]["content"], content);
}

#[tokio::test]
async fn sync_triggers_reindex_signal() {
    let (router, _tmp, mut rx) = test_env_with_indexer_rx();
    let token = setup_and_login(&router).await;

    let (status, _) = json_request(
        &router,
        "POST",
        "/sync",
        Some(json!({
            "device_id": "dev-1",
            "inventory": [],
            "changed": [],
            "new": [{ "filename": "hello.md", "content": "# Hello", "hash": hash_sha256("# Hello") }],
            "deleted": []
        })),
        Some(&token),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let msg = tokio::time::timeout(std::time::Duration::from_secs(1), rx.recv())
        .await
        .expect("sync should queue a reindex")
        .expect("indexer channel should stay open");
    assert!(matches!(
        msg,
        stonefruit_server::indexer::IndexerCommand::Reindex
    ));
}

#[tokio::test]
async fn sync_check_up_to_date() {
    let (router, _tmp) = test_env();
    let token = setup_and_login(&router).await;

    // Get current version
    let (status, body) = json_request(
        &router,
        "POST",
        "/sync/check",
        Some(json!({ "version": 0 })),
        Some(&token),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "up_to_date");

    // Create a note to bump version
    json_request(
        &router,
        "POST",
        "/sync",
        Some(json!({
            "device_id": "d",
            "inventory": [],
            "changed": [],
            "new": [{ "filename": "x.md", "content": "x", "hash": hash_sha256("x") }],
            "deleted": []
        })),
        Some(&token),
    )
    .await;

    // Now version 0 should show changes available
    let (status, body) = json_request(
        &router,
        "POST",
        "/sync/check",
        Some(json!({ "version": 0 })),
        Some(&token),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "changes_available");
}

#[tokio::test]
async fn sync_rejects_empty_device_id() {
    let (router, _tmp) = test_env();
    let token = setup_and_login(&router).await;

    let (status, _) = json_request(
        &router,
        "POST",
        "/sync",
        Some(json!({
            "device_id": "",
            "inventory": [],
            "changed": [],
            "new": [],
            "deleted": []
        })),
        Some(&token),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn sync_rejects_path_traversal() {
    let (router, _tmp) = test_env();
    let token = setup_and_login(&router).await;

    let (status, _) = json_request(
        &router,
        "POST",
        "/sync",
        Some(json!({
            "device_id": "d",
            "inventory": [],
            "changed": [],
            "new": [{ "filename": "../etc/passwd", "content": "x", "hash": "x" }],
            "deleted": []
        })),
        Some(&token),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

// ── Blob route tests ───────────────────────────────────────────────────

#[tokio::test]
async fn blob_upload_download_roundtrip() {
    let (router, _tmp) = test_env();
    let token = setup_and_login(&router).await;

    let image_data = b"fake-png-data-1234567890";
    let expected_hash = hash_sha256_bytes(image_data);

    // Upload
    let req = Request::builder()
        .method("PUT")
        .uri("/blob/test.png")
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/octet-stream")
        .body(Body::from(image_data.to_vec()))
        .unwrap();
    let resp = router.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::CREATED);
    let body: Value =
        serde_json::from_slice(&resp.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(body["content_hash"], expected_hash);
    assert_eq!(body["filename"], "test.png");

    // Download
    let req = Request::builder()
        .method("GET")
        .uri("/blob/test.png")
        .header("authorization", format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap();
    let resp = router.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(bytes.as_ref(), image_data);
}

#[tokio::test]
async fn blob_requires_auth() {
    let (router, _tmp) = test_env();

    let req = Request::builder()
        .method("PUT")
        .uri("/blob/test.png")
        .header("content-type", "application/octet-stream")
        .body(Body::from(vec![1, 2, 3]))
        .unwrap();
    let resp = router.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn blob_rejects_non_image() {
    let (router, _tmp) = test_env();
    let token = setup_and_login(&router).await;

    let req = Request::builder()
        .method("PUT")
        .uri("/blob/script.js")
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/octet-stream")
        .body(Body::from(vec![1, 2, 3]))
        .unwrap();
    let resp = router.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn blob_404_for_missing() {
    let (router, _tmp) = test_env();
    let token = setup_and_login(&router).await;

    let req = Request::builder()
        .method("GET")
        .uri("/blob/nonexistent.png")
        .header("authorization", format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap();
    let resp = router.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn blob_rejects_path_traversal() {
    let (router, _tmp) = test_env();
    let token = setup_and_login(&router).await;

    let req = Request::builder()
        .method("PUT")
        .uri("/blob/..%2F..%2Fetc%2Fpasswd.png")
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/octet-stream")
        .body(Body::from(vec![1, 2, 3]))
        .unwrap();
    let resp = router.clone().oneshot(req).await.unwrap();
    // Should reject due to path traversal or non-image filename
    assert!(resp.status() == StatusCode::BAD_REQUEST || resp.status() == StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn search_sanitizes_punctuation_queries() {
    let (router, _tmp, conn, _status) = test_env_with_handles();
    let token = setup_and_login(&router).await;

    {
        let conn = conn.lock().unwrap();
        conn.execute(
            "INSERT INTO note_chunks (chunk_id, filename, chunk_text) VALUES (1, 'hello.md', 'hello world c plus plus')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO note_chunks_fts(rowid, filename, chunk_text) VALUES (1, 'hello.md', 'hello world c plus plus')",
            [],
        )
        .unwrap();
    }

    let (status, body) = json_request(&router, "GET", "/search?q=%22", None, Some(&token)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["results"].as_array().unwrap().len(), 0);

    let (status, body) =
        json_request(&router, "GET", "/search?q=C%2B%2B", None, Some(&token)).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["results"].as_array().is_some());

    let (status, body) =
        json_request(&router, "GET", "/search?q=foo-bar", None, Some(&token)).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["results"].as_array().is_some());
}

#[tokio::test]
async fn search_status_returns_flat_phase_shape() {
    let (router, _tmp, conn, status_handle) = test_env_with_handles();
    let token = setup_and_login(&router).await;

    conn.lock()
        .unwrap()
        .execute(
            "INSERT INTO note_meta (filename, content_hash, modified_at, is_blob) VALUES ('a.md', 'h1', 1, 0)",
            [],
        )
        .unwrap();
    conn.lock()
        .unwrap()
        .execute(
            "INSERT INTO note_meta (filename, content_hash, modified_at, is_blob) VALUES ('b.md', 'h2', 2, 0)",
            [],
        )
        .unwrap();
    conn.lock()
        .unwrap()
        .execute(
            "INSERT INTO index_state (filename, content_hash, indexed_at) VALUES ('a.md', 'h1', 1)",
            [],
        )
        .unwrap();

    {
        let mut status = status_handle.write().unwrap();
        status.phase = stonefruit_server::indexer::IndexerPhase::LoadingModel;
        status.model_ready = false;
        status.notes_total = 12;
        status.notes_processed = 3;
        status.model_id = Some("qwen3-embedding-0.6b".to_string());
    }

    let (status, body) = json_request(&router, "GET", "/search/status", None, Some(&token)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["phase"], "loading_model");
    assert_eq!(body["model_ready"], false);
    assert_eq!(body["notes_total"], 2);
    assert_eq!(body["notes_indexed"], 1);
    assert_eq!(body["model_id"], "qwen3-embedding-0.6b");
    assert!(body.get("scheduler").is_none());
}

#[tokio::test]
async fn graph_layout_returns_empty_when_no_vectors_exist() {
    let (router, _tmp) = test_env();
    let token = setup_and_login(&router).await;

    let (status, body) = json_request(&router, "GET", "/graph/layout", None, Some(&token)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["note_count"], 0);
    assert_eq!(body["indexed_count"], 0);
    assert_eq!(body["nodes"], serde_json::json!([]));
    assert_eq!(body["clusters"], serde_json::json!([]));
}
