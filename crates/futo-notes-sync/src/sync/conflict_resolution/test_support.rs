use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use crate::checkpoint::ConnectedState;
use crate::server::Object;
use crate::sync::encrypted_note::RemoteNote;

pub(super) fn no_pre(_: &str) {}

pub(super) struct TempRoot(PathBuf);

impl TempRoot {
    pub(super) fn new() -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "futo-sync-conflict-resolution-test-{}-{n}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).unwrap();
        Self(root)
    }

    pub(super) fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub(super) fn connected_state(base_url: String) -> ConnectedState {
    ConnectedState {
        base_url,
        token: "token".into(),
        user_id: "user".into(),
        collection_id: "collection".into(),
        vault_key: [5; 32],
        object_map: HashMap::new(),
        max_version: 0,
        pull_cursor: 0,
        oversize_skip: HashMap::new(),
        pending_creates: HashMap::new(),
    }
}

pub(super) fn remote_note(name: &str, content: &str) -> RemoteNote {
    RemoteNote {
        object: Object {
            id: "remote-object".into(),
            version: 2,
            change_seq: 2,
            deleted: false,
            blob_key: Some("remote-blob".into()),
            size_bytes: Some(content.len() as u64),
            updated_at: "2026-07-29T12:00:00Z".into(),
        },
        name: name.into(),
        content: content.into(),
    }
}
