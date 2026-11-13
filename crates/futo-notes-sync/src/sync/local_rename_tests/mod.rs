//! Journaled local renames (#214) at the failure boundaries a real server
//! cannot be made to produce: a failed rename PUT, a checkpoint that does not
//! save after it, and a rename landing between the scan and the pull's write.
//! The stub server is stateless, so each test asserts only what its single
//! object and the local journal must show; whole flows run against the real
//! server in `tests/server_integration/round_trip.rs`. `exact_saves` drives
//! store saves through the same harness.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};

use futo_notes_core::files::rename_journal::{set_rename_scope, with_rename_journal};
use futo_notes_core::hash::hash_sha256;

use crate::checkpoint::{self, ConnectedState, ObjectState};

mod exact_saves;
mod failures;
mod identity;

struct TempRoot(std::path::PathBuf);

impl TempRoot {
    fn new() -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "futo-sync-local-rename-test-{}-{}-{n}",
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

fn no_progress(_: crate::sync::SyncProgress) {}

fn no_pre_write(_: &str) {}

const KEY: [u8; 32] = [5; 32];

/// A vault whose `old.md` is synced as object `obj` (v1), with its checkpoint
/// saved and the rename journal scoped to the collection.
fn synced(root: &Path, base_url: &str) -> ConnectedState {
    std::fs::write(root.join("old.md"), "body").unwrap();
    let state = ConnectedState {
        base_url: base_url.to_owned(),
        token: "token".into(),
        user_id: "user".into(),
        collection_id: "collection".into(),
        vault_key: KEY,
        object_map: HashMap::from([(
            "old.md".to_owned(),
            ObjectState {
                object_id: "obj".into(),
                version: 1,
                blob_key: "obj-blob".into(),
                hash: Some(hash_sha256("body")),
                mtime_ms: None,
                size_bytes: Some(4),
            },
        )]),
        pending_creates: HashMap::new(),
        max_version: 1,
        pull_cursor: 1,
        oversize_skip: HashMap::new(),
    };
    checkpoint::save(root, &state).unwrap();
    set_rename_scope(root, Some("collection")).unwrap();
    state
}

fn intents(root: &Path) -> Vec<(String, String, Option<String>)> {
    with_rename_journal(root, |journal| {
        journal
            .intents()
            .into_iter()
            .map(|intent| (intent.from, intent.to, intent.object_id))
            .collect()
    })
    .unwrap()
}

fn carried(state: &ConnectedState) -> bool {
    !state.object_map.contains_key("old.md")
        && state
            .object_map
            .get("new.md")
            .is_some_and(|entry| entry.object_id == "obj")
}

/// Notes synced as `(name, object id, body)`, journal scoped.
fn synced_notes(root: &Path, base_url: &str, notes: &[(&str, &str, &str)]) -> ConnectedState {
    let mut state = synced(root, base_url);
    std::fs::remove_file(root.join("old.md")).unwrap();
    state.object_map.clear();
    for (name, object_id, body) in notes {
        std::fs::write(root.join(name), body).unwrap();
        state.object_map.insert(
            (*name).to_owned(),
            ObjectState {
                object_id: (*object_id).to_owned(),
                version: 1,
                blob_key: format!("{object_id}-blob"),
                hash: Some(hash_sha256(body)),
                mtime_ms: None,
                size_bytes: Some(body.len() as u64),
            },
        );
    }
    checkpoint::save(root, &state).unwrap();
    state
}

fn object_at<'a>(state: &'a ConnectedState, name: &str) -> Option<&'a str> {
    state
        .object_map
        .get(name)
        .map(|entry| entry.object_id.as_str())
}

fn write_note(root: &Path, name: &str, body: &str) {
    let path = root.join(name);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, body).unwrap();
}
