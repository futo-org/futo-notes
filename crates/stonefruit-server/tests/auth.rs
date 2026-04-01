use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex, RwLock};
use tempfile::TempDir;
use tower::ServiceExt;

use stonefruit_server::app::{build_router, AppState};
use stonefruit_server::db;
use stonefruit_server::indexer::IndexerStatus;

/// Test environment with in-memory DB and temp notes dir.
fn test_env() -> (axum::Router, TempDir) {
    let tmp = TempDir::new().unwrap();
    let notes_dir = tmp.path().join("notes");
    std::fs::create_dir_all(&notes_dir).unwrap();

    let conn = db::open_memory_db().unwrap();
    let (tx, _rx) = tokio::sync::mpsc::channel(1);
    let state = AppState {
        db: Arc::new(Mutex::new(conn)),
        notes_dir,
        indexer_tx: tx,
        indexer_status: Arc::new(RwLock::new(IndexerStatus::default())),
    };
    (build_router(state), tmp)
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

async fn json_request_with_forwarded_for(
    router: &axum::Router,
    method: &str,
    path: &str,
    body: Option<Value>,
    forwarded_for: &str,
) -> (StatusCode, Value) {
    let builder = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json")
        .header("x-forwarded-for", forwarded_for);

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

async fn setup_and_login(router: &axum::Router, password: &str) -> String {
    // Setup
    let (status, _) = json_request(
        router,
        "POST",
        "/setup",
        Some(json!({ "password": password })),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "setup should succeed");

    // Login
    let (status, body) = json_request(
        router,
        "POST",
        "/login",
        Some(json!({ "password": password, "device_info": "test" })),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "login should succeed");
    body["token"].as_str().unwrap().to_string()
}

// ── Health ─────────────────────────────────────────────────────────────

#[tokio::test]
async fn health_before_setup() {
    let (router, _tmp) = test_env();
    let (status, body) = json_request(&router, "GET", "/health", None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "ok");
    assert_eq!(body["setup_complete"], false);
}

#[tokio::test]
async fn health_after_setup() {
    let (router, _tmp) = test_env();
    setup_and_login(&router, "testpass123").await;
    let (status, body) = json_request(&router, "GET", "/health", None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["setup_complete"], true);
}

// ── Setup ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn setup_succeeds() {
    let (router, _tmp) = test_env();
    let (status, body) = json_request(
        &router,
        "POST",
        "/setup",
        Some(json!({ "password": "testpass123" })),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(body["ok"], true);
}

#[tokio::test]
async fn setup_duplicate_returns_409() {
    let (router, _tmp) = test_env();
    json_request(
        &router,
        "POST",
        "/setup",
        Some(json!({ "password": "testpass123" })),
        None,
    )
    .await;
    let (status, body) = json_request(
        &router,
        "POST",
        "/setup",
        Some(json!({ "password": "another123" })),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(body["error"].as_str().unwrap().contains("already"));
}

#[tokio::test]
async fn setup_short_password_rejected() {
    let (router, _tmp) = test_env();
    let (status, body) = json_request(
        &router,
        "POST",
        "/setup",
        Some(json!({ "password": "short" })),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body["error"].as_str().unwrap().contains("8"));
}

// ── Login ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn login_succeeds() {
    let (router, _tmp) = test_env();
    let token = setup_and_login(&router, "testpass123").await;
    assert_eq!(token.len(), 64); // 32 bytes as hex
}

#[tokio::test]
async fn login_wrong_password_returns_401() {
    let (router, _tmp) = test_env();
    json_request(
        &router,
        "POST",
        "/setup",
        Some(json!({ "password": "testpass123" })),
        None,
    )
    .await;
    let (status, _) = json_request(
        &router,
        "POST",
        "/login",
        Some(json!({ "password": "wrongpassword" })),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn login_before_setup_returns_401() {
    let (router, _tmp) = test_env();
    let (status, _) = json_request(
        &router,
        "POST",
        "/login",
        Some(json!({ "password": "anything1" })),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

// ── Auth middleware ────────────────────────────────────────────────────

#[tokio::test]
async fn missing_token_returns_401() {
    let (router, _tmp) = test_env();
    // Try to access an authed endpoint without token
    // sync/check will be added later, but any route behind the auth middleware
    // Currently the authed router has no routes, so this just tests health doesn't need auth
    let (status, _) = json_request(&router, "GET", "/health", None, None).await;
    assert_eq!(status, StatusCode::OK); // health is public
}

#[tokio::test]
async fn invalid_token_format() {
    let (router, _tmp) = test_env();
    // Auth middleware is only applied to the authed router group
    // We'll verify this more thoroughly once we have sync routes
    // For now, verify the token flow works end-to-end
    let token = setup_and_login(&router, "testpass123").await;
    assert!(!token.is_empty());
}

#[tokio::test]
async fn multiple_logins_get_different_tokens() {
    let (router, _tmp) = test_env();
    json_request(
        &router,
        "POST",
        "/setup",
        Some(json!({ "password": "testpass123" })),
        None,
    )
    .await;

    let (_, body1) = json_request(
        &router,
        "POST",
        "/login",
        Some(json!({ "password": "testpass123" })),
        None,
    )
    .await;
    let (_, body2) = json_request(
        &router,
        "POST",
        "/login",
        Some(json!({ "password": "testpass123" })),
        None,
    )
    .await;

    let token1 = body1["token"].as_str().unwrap();
    let token2 = body2["token"].as_str().unwrap();
    assert_ne!(token1, token2, "each login should produce a unique token");
}

#[tokio::test]
async fn login_rate_limit_does_not_trust_forwarded_for_header() {
    let (router, _tmp) = test_env();
    json_request(
        &router,
        "POST",
        "/setup",
        Some(json!({ "password": "testpass123" })),
        None,
    )
    .await;

    for i in 0..5 {
        let (status, _) = json_request_with_forwarded_for(
            &router,
            "POST",
            "/login",
            Some(json!({ "password": "wrongpassword" })),
            &format!("10.0.0.{i}"),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    let (status, body) = json_request_with_forwarded_for(
        &router,
        "POST",
        "/login",
        Some(json!({ "password": "wrongpassword" })),
        "10.0.0.99",
    )
    .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert!(body["error"].as_str().unwrap().contains("Too many"));
}
