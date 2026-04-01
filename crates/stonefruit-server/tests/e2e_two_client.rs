//! End-to-end two-client integration tests.
//!
//! Uses a real Axum router (via `tower::ServiceExt::oneshot()`) and two
//! simulated clients with separate vault directories, exercising the full
//! HTTP path: auth → sync → blob → verify.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use tempfile::TempDir;
use tower::ServiceExt;

use stonefruit_core::hash::{hash_sha256, hash_sha256_bytes};
use stonefruit_server::app::{build_router, AppState};
use stonefruit_server::db;
use stonefruit_server::indexer::IndexerStatus;

// ── HTTP helpers ───────────────────────────────────────────────────────

struct TestServer {
    router: axum::Router,
    tmp: TempDir,
    token: Option<String>,
}

impl TestServer {
    fn new() -> Self {
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
        Self {
            router: build_router(state),
            tmp,
            token: None,
        }
    }

    #[allow(dead_code)]
    fn notes_dir(&self) -> PathBuf {
        self.tmp.path().join("notes")
    }

    async fn json_request(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut builder = Request::builder()
            .method(method)
            .uri(path)
            .header("content-type", "application/json");
        if let Some(t) = &self.token {
            builder = builder.header("authorization", format!("Bearer {t}"));
        }
        let body = match body {
            Some(v) => Body::from(serde_json::to_vec(&v).unwrap()),
            None => Body::empty(),
        };
        let req = builder.body(body).unwrap();
        let resp = self.router.clone().oneshot(req).await.unwrap();
        let status = resp.status();
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let value: Value = serde_json::from_slice(&bytes).unwrap_or(json!(null));
        (status, value)
    }

    async fn setup_auth(&mut self) {
        self.json_request("POST", "/setup", Some(json!({"password": "test12345"})))
            .await;
        let (_, body) = self
            .json_request("POST", "/login", Some(json!({"password": "test12345"})))
            .await;
        self.token = Some(body["token"].as_str().unwrap().to_string());
    }

    async fn sync(&self, _device_id: &str, req_body: Value) -> Value {
        let (status, body) = self.json_request("POST", "/sync", Some(req_body)).await;
        assert_eq!(status, StatusCode::OK, "sync failed: {body}");
        body
    }

    async fn upload_blob(&self, filename: &str, data: &[u8]) -> Value {
        let token = self.token.as_ref().unwrap();
        let req = Request::builder()
            .method("PUT")
            .uri(format!("/blob/{filename}"))
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/octet-stream")
            .body(Body::from(data.to_vec()))
            .unwrap();
        let resp = self.router.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        serde_json::from_slice(&bytes).unwrap()
    }

    async fn download_blob(&self, filename: &str) -> Vec<u8> {
        let token = self.token.as_ref().unwrap();
        let req = Request::builder()
            .method("GET")
            .uri(format!("/blob/{filename}"))
            .header("authorization", format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap();
        let resp = self.router.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        resp.into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .to_vec()
    }
}

// ── E2E client with HTTP ───────────────────────────────────────────────

struct E2EClient {
    device_id: String,
    vault_dir: PathBuf,
    file_hashes: HashMap<String, String>,
    last_version: u64,
}

impl E2EClient {
    fn new(device_id: &str, base: &std::path::Path) -> Self {
        let vault_dir = base.join(format!("e2e-vault-{device_id}"));
        std::fs::create_dir_all(&vault_dir).unwrap();
        Self {
            device_id: device_id.to_string(),
            vault_dir,
            file_hashes: HashMap::new(),
            last_version: 0,
        }
    }

    fn write_local(&self, filename: &str, content: &str) {
        std::fs::write(self.vault_dir.join(filename), content).unwrap();
    }

    fn read_local(&self, filename: &str) -> Option<String> {
        std::fs::read_to_string(self.vault_dir.join(filename)).ok()
    }

    fn delete_local(&self, filename: &str) {
        let _ = std::fs::remove_file(self.vault_dir.join(filename));
    }

    fn file_exists(&self, filename: &str) -> bool {
        self.vault_dir.join(filename).exists()
    }

    fn list_files(&self) -> Vec<String> {
        std::fs::read_dir(&self.vault_dir)
            .unwrap()
            .filter_map(|e| {
                let e = e.ok()?;
                let name = e.file_name().to_str()?.to_string();
                if name.ends_with(".md") {
                    Some(name)
                } else {
                    None
                }
            })
            .collect()
    }

    /// Build the JSON sync request body.
    fn build_sync_body(&self) -> Value {
        let mut inventory = Vec::new();
        let mut changed = Vec::new();
        let mut new = Vec::new();
        let mut deleted = Vec::new();

        // Current files
        let current: HashMap<String, (String, String)> = self
            .list_files()
            .into_iter()
            .map(|name| {
                let content = self.read_local(&name).unwrap();
                let hash = hash_sha256(&content);
                (name, (content, hash))
            })
            .collect();

        for (filename, (content, hash)) in &current {
            inventory.push(json!({"filename": filename, "hash": hash}));
            match self.file_hashes.get(filename) {
                Some(old) if old != hash => {
                    changed.push(json!({
                        "filename": filename,
                        "content": content,
                        "hash": hash,
                        "modified_at": 0
                    }));
                }
                None => {
                    new.push(json!({
                        "filename": filename,
                        "content": content,
                        "hash": hash,
                        "modified_at": 0
                    }));
                }
                _ => {}
            }
        }

        for filename in self.file_hashes.keys() {
            if !current.contains_key(filename) {
                deleted.push(json!(filename));
            }
        }

        json!({
            "device_id": self.device_id,
            "inventory": inventory,
            "changed": changed,
            "new": new,
            "deleted": deleted
        })
    }

    /// Apply sync response JSON to local state.
    fn apply_response(&mut self, resp: &Value) {
        if let Some(updates) = resp["update"].as_array() {
            for update in updates {
                let filename = update["filename"].as_str().unwrap();
                let content = update["content"].as_str().unwrap();
                let hash = update["hash"].as_str().unwrap();
                if !content.is_empty() {
                    self.write_local(filename, content);
                }
                self.file_hashes
                    .insert(filename.to_string(), hash.to_string());
            }
        }
        if let Some(deletes) = resp["delete"].as_array() {
            for d in deletes {
                let filename = d.as_str().unwrap();
                self.delete_local(filename);
                self.file_hashes.remove(filename);
            }
        }
        if let Some(conflicts) = resp["conflicts"].as_array() {
            for conflict in conflicts {
                let filename = conflict["filename"].as_str().unwrap();
                let content = conflict["content"].as_str().unwrap();
                self.write_local(filename, content);
                self.file_hashes
                    .insert(filename.to_string(), hash_sha256(content));
            }
        }

        // Re-snapshot local state
        let current: HashMap<String, String> = self
            .list_files()
            .into_iter()
            .map(|name| {
                let content = self.read_local(&name).unwrap();
                (name, hash_sha256(&content))
            })
            .collect();
        for (filename, hash) in &current {
            self.file_hashes.insert(filename.clone(), hash.clone());
        }
        self.file_hashes.retain(|f, _| current.contains_key(f));

        if let Some(v) = resp["version"].as_u64() {
            self.last_version = v;
        }
    }

    /// Full sync cycle over HTTP.
    async fn sync(&mut self, server: &TestServer) -> Value {
        let body = self.build_sync_body();
        let resp = server.sync(&self.device_id, body).await;
        self.apply_response(&resp);
        resp
    }
}

// ── E2E Tests ──────────────────────────────────────────────────────────

#[tokio::test]
async fn e2e_five_notes_roundtrip() {
    let mut server = TestServer::new();
    server.setup_auth().await;
    let mut a = E2EClient::new("a", server.tmp.path());
    let mut b = E2EClient::new("b", server.tmp.path());

    // A creates 5 notes
    for i in 0..5 {
        a.write_local(&format!("note-{i}.md"), &format!("# Note {i}\nContent {i}"));
    }

    // A syncs
    let resp = a.sync(&server).await;
    assert!(resp["version"].as_u64().unwrap() > 0);

    // B syncs — gets all 5
    let resp = b.sync(&server).await;
    assert_eq!(resp["update"].as_array().unwrap().len(), 5);

    for i in 0..5 {
        let filename = format!("note-{i}.md");
        assert!(b.file_exists(&filename));
        assert_eq!(
            b.read_local(&filename).unwrap(),
            format!("# Note {i}\nContent {i}")
        );
    }
}

#[tokio::test]
async fn e2e_concurrent_edit_conflict() {
    let mut server = TestServer::new();
    server.setup_auth().await;
    let mut a = E2EClient::new("a", server.tmp.path());
    let mut b = E2EClient::new("b", server.tmp.path());

    // Both get the same note
    a.write_local("shared.md", "# Original");
    a.sync(&server).await;
    b.sync(&server).await;
    assert!(b.file_exists("shared.md"));

    // Both edit
    a.write_local("shared.md", "# A's version");
    b.write_local("shared.md", "# B's version");

    // A syncs first
    a.sync(&server).await;

    // B syncs — conflict
    let resp = b.sync(&server).await;
    let conflicts = resp["conflicts"].as_array().unwrap();
    assert_eq!(conflicts.len(), 1);
    assert!(conflicts[0]["filename"]
        .as_str()
        .unwrap()
        .contains("conflict"));

    // B should have A's version as the canonical
    assert_eq!(b.read_local("shared.md").unwrap(), "# A's version");

    // A picks up conflict copy
    a.sync(&server).await;

    // Both have identical file sets
    let a_files: HashSet<String> = a.list_files().into_iter().collect();
    let b_files: HashSet<String> = b.list_files().into_iter().collect();
    assert_eq!(a_files, b_files);
}

#[tokio::test]
async fn e2e_rename_propagation() {
    let mut server = TestServer::new();
    server.setup_auth().await;
    let mut a = E2EClient::new("a", server.tmp.path());
    let mut b = E2EClient::new("b", server.tmp.path());

    // A creates and syncs
    a.write_local("old.md", "# My Note");
    a.sync(&server).await;
    b.sync(&server).await;

    // A renames
    a.delete_local("old.md");
    a.write_local("new.md", "# My Note");
    a.sync(&server).await;

    // B syncs — sees rename
    b.sync(&server).await;
    assert!(!b.file_exists("old.md"));
    assert!(b.file_exists("new.md"));
    assert_eq!(b.read_local("new.md").unwrap(), "# My Note");
}

#[tokio::test]
async fn e2e_blob_roundtrip() {
    let mut server = TestServer::new();
    server.setup_auth().await;

    let image_data = b"PNG-fake-image-data-for-testing-12345";
    let expected_hash = hash_sha256_bytes(image_data);

    // A uploads a blob
    let upload_resp = server.upload_blob("screenshot.png", image_data).await;
    assert_eq!(upload_resp["content_hash"], expected_hash);

    // B downloads it
    let downloaded = server.download_blob("screenshot.png").await;
    assert_eq!(downloaded, image_data);

    // Blob appears in sync as an update with empty content
    let mut b = E2EClient::new("b", server.tmp.path());
    let resp = b.sync(&server).await;
    let blob_update = resp["update"]
        .as_array()
        .unwrap()
        .iter()
        .find(|u| u["filename"] == "screenshot.png");
    assert!(blob_update.is_some(), "blob should appear in sync updates");
    assert_eq!(
        blob_update.unwrap()["content"].as_str().unwrap(),
        "",
        "blob content should be empty in sync (downloaded separately)"
    );
}

#[tokio::test]
async fn e2e_lost_state_recovery() {
    let mut server = TestServer::new();
    server.setup_auth().await;
    let mut a = E2EClient::new("a", server.tmp.path());

    // A creates notes and syncs
    a.write_local("note1.md", "# Note 1");
    a.write_local("note2.md", "# Note 2");
    a.write_local("note3.md", "# Note 3");
    a.sync(&server).await;

    // Simulate lost app-state
    a.file_hashes.clear();
    a.last_version = 0;

    // A syncs again — should recover
    let resp = a.sync(&server).await;

    // No conflicts (content matches)
    let conflicts = resp["conflicts"].as_array().unwrap();
    assert!(conflicts.is_empty(), "recovery should not create conflicts");

    // All notes still exist
    assert!(a.file_exists("note1.md"));
    assert!(a.file_exists("note2.md"));
    assert!(a.file_exists("note3.md"));

    // Re-sync is a no-op
    let resp2 = a.sync(&server).await;
    assert!(resp2["update"].as_array().unwrap().is_empty());
    assert!(resp2["delete"].as_array().unwrap().is_empty());
    assert!(resp2["conflicts"].as_array().unwrap().is_empty());
}
