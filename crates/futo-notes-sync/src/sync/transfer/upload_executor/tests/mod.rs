use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futo_notes_core::hash::hash_sha256;
use wiremock::matchers::{header, method, path, query_param};
use wiremock::{Mock, MockServer, Request, ResponseTemplate};

use super::settlement::apply_candidate;
use crate::checkpoint::{self, ConnectedState, ObjectState, PendingCreate};
use crate::server::Http;
use crate::sync::push::{push, push_with_checkpoint, PushContext};
use crate::sync::test_support::ResponseGate;
use crate::sync::transfer::{CandidateResult, UploadCandidate, UploadTarget};
use crate::sync::vault::{local_files, LocalFile};
use crate::sync::{FailureKind, SyncErrorKind, SyncProgress, SyncSummary};

struct TempRoot(PathBuf);

impl TempRoot {
    fn new() -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "futo-sync-upload-executor-test-{}-{n}",
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

fn no_progress(_: SyncProgress) {}

fn no_pre_write(_: &str) {}

fn connected() -> ConnectedState {
    ConnectedState {
        base_url: "http://127.0.0.1:1".into(),
        token: "token".into(),
        user_id: "user".into(),
        collection_id: "collection".into(),
        vault_key: [5; 32],
        object_map: HashMap::new(),
        pending_creates: HashMap::new(),
        max_version: 0,
        pull_cursor: 0,
        oversize_skip: HashMap::new(),
    }
}

fn batch_object_ids(body: &[u8]) -> Vec<String> {
    let mut offset = 0;
    let mut ids = Vec::new();
    while offset < body.len() {
        offset += 1;
        let object_id_len = u16::from_be_bytes([body[offset], body[offset + 1]]) as usize;
        offset += 2;
        ids.push(String::from_utf8(body[offset..offset + object_id_len].to_vec()).unwrap());
        offset += object_id_len + 4;
        let ciphertext_len = u32::from_be_bytes([
            body[offset],
            body[offset + 1],
            body[offset + 2],
            body[offset + 3],
        ]) as usize;
        offset += 4 + ciphertext_len;
    }
    ids
}

fn batch_write_response(request: &Request) -> ResponseTemplate {
    let object_ids = batch_object_ids(&request.body);
    let version_base = if object_ids.len() == 100 { 0 } else { 100 };
    let results = object_ids
        .into_iter()
        .enumerate()
        .map(|(index, object_id)| {
            let version = version_base + index + 1;
            serde_json::json!({
                "status": "created",
                "object": {
                    "id": object_id,
                    "version": 1,
                    "change_seq": version,
                    "blob_key": format!("blob-{version}"),
                    "updated_at": "2026-07-29T12:00:00Z"
                },
                "collectionVersion": version
            })
        })
        .collect::<Vec<_>>();
    ResponseTemplate::new(200).set_body_json(serde_json::json!({"results": results}))
}

fn two_entry_batch_write_response(request: &Request) -> ResponseTemplate {
    let results = batch_object_ids(&request.body)
        .into_iter()
        .enumerate()
        .map(|(index, object_id)| {
            let version = index + 1;
            serde_json::json!({
                "status": "created",
                "object": {
                    "id": object_id,
                    "version": 1,
                    "change_seq": version,
                    "blob_key": format!("blob-{version}"),
                    "updated_at": "2026-07-29T12:00:00Z"
                },
                "collectionVersion": version
            })
        })
        .collect::<Vec<_>>();
    ResponseTemplate::new(200).set_body_json(serde_json::json!({"results": results}))
}

mod batching;
mod create_identity;
mod pending_restart;
mod replay_successor;
mod tombstone_recovery;
