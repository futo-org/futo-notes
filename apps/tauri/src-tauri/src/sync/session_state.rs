//! Sync session state and the Tauri task-handle bridge.
//!
//! Thin wrapper around the shared `futo-notes-sync` crate. The crate owns the
//! orchestrator, the `ConnectedState` type, the on-disk `.e2ee-state.json`
//! format, all persistence/migration logic, AND — since Phase 3 — the
//! session-cell + sync-gate + live-task lifecycle (`SyncSession`). This module
//! is now just the Tauri-managed newtype holding that `SyncSession`, plus the
//! `AbortableTask` shim for the Tauri async-runtime join handle (the crate's
//! `stop_live` aborts through it).
//!
//! Persistence is the crate's concern: `connect` / `run_sync` persist
//! internally, and `e2ee_disconnect` calls
//! `futo_notes_sync::state::demote_state_to_ancestry`.

use std::ops::Deref;

use futo_notes_sync::{AbortableTask, SyncSession};

/// Desktop sync state cell. Derefs to the shared [`SyncSession`] so the
/// command handlers call its `snapshot`/`set_connected`/`lock_sync_gate`/
/// `start_live_with`/`stop_live`/`note_changed` methods directly.
#[derive(Default)]
pub struct SyncState {
    session: SyncSession,
}

impl Deref for SyncState {
    type Target = SyncSession;
    fn deref(&self) -> &SyncSession {
        &self.session
    }
}

/// Newtype so we can `impl AbortableTask` for the Tauri async-runtime join
/// handle (orphan rules forbid `impl ForeignTrait for ForeignType`). The
/// crate's `SyncSession::stop_live` aborts the live task through this.
pub struct TauriTask(pub tauri::async_runtime::JoinHandle<()>);

impl AbortableTask for TauriTask {
    fn abort(&self) {
        self.0.abort();
    }
}

#[cfg(test)]
mod tests {
    //! Tests for sync session state.
    use super::*;
    use futo_notes_sync::{ConnectedState, E2eeObjectMapEntry};
    use std::collections::HashMap;

    fn make_connected() -> ConnectedState {
        let mut map = HashMap::new();
        map.insert(
            "note.md".to_owned(),
            E2eeObjectMapEntry {
                object_id: "o1".into(),
                version: 3,
                blob_key: "bk1".into(),
                hash: Some("h".into()),
                mtime_ms: Some(1),
                size_bytes: Some(2),
            },
        );
        ConnectedState {
            base_url: "http://127.0.0.1:3100".into(),
            token: "tok".into(),
            user_id: "u1".into(),
            collection_id: "c1".into(),
            vault_key: [9u8; 32],
            object_map: map,
            max_version: 10,
            pull_cursor: 10,
            oversize_skip: HashMap::new(),
        }
    }

    #[tokio::test]
    async fn snapshot_set_clear_round_trip() {
        let state = SyncState::default();
        assert!(state.snapshot().await.is_none());
        assert!(!state.is_connected().await);
        state.set_connected(make_connected()).await;
        assert!(state.is_connected().await);
        let snapshot = state.snapshot().await.unwrap();
        assert_eq!(snapshot.max_version, 10);
        assert_eq!(snapshot.object_map.len(), 1);
        assert_eq!(snapshot.collection_id, "c1");
        state.clear().await;
        assert!(!state.is_connected().await);
        assert!(state.snapshot().await.is_none());
    }

    #[tokio::test]
    async fn stop_live_and_note_changed_are_safe_when_not_running() {
        let state = SyncState::default();
        state.stop_live();
        state.note_changed();
        state.stop_live();
    }
}
