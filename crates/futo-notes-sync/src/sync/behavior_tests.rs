use super::*;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc;
use std::time::Duration;

use futo_notes_core::conflict_names::collision_conflict_filename;
use futo_notes_core::hash::hash_sha256;

use crate::checkpoint::ObjectState;
use crate::server::Object;

use super::encrypted_note::RemoteNote;
use super::object_map::object_is_current;
use super::outcome::{derive_renames, note_id};
use super::pull::{apply_remote, cap_cursor};
use super::tombstones::{apply_tombstone, claim_local, claim_paths, recover_stale_claims};
use super::vault::{conflict_date, local_files, read_content};

mod failure_reports;
mod name_collisions;
mod pending_creates;
mod rename_inference;
mod tombstone_claims;

struct TempRoot(std::path::PathBuf);

impl TempRoot {
    fn new() -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "futo-sync-engine-test-{}-{}-{n}",
            std::process::id(),
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

fn no_pre(_: &str) {}

fn entry(object_id: &str, hash: Option<&str>) -> ObjectState {
    ObjectState {
        object_id: object_id.into(),
        version: 1,
        blob_key: format!("blob-{object_id}"),
        hash: hash.map(str::to_owned),
        mtime_ms: Some(1_700_000_000_000),
        size_bytes: Some(4),
    }
}

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

fn object(id: &str, change_seq: u64, deleted: bool) -> Object {
    Object {
        id: id.into(),
        version: 1,
        change_seq,
        deleted,
        blob_key: (!deleted).then(|| format!("blob-{id}")),
        size_bytes: None,
        updated_at: "2026-06-05T12:34:56.789Z".into(),
    }
}

fn remote(id: &str, name: &str, content: &str) -> RemoteNote {
    RemoteNote {
        object: object(id, 1, false),
        name: name.into(),
        content: content.into(),
    }
}

fn failure(kind: FailureKind, status_code: Option<u16>) -> SyncFailure {
    SyncFailure {
        filename: "note.md".into(),
        kind,
        status_code,
        detail: None,
    }
}
