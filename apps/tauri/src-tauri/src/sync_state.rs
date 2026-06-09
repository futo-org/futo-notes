//! Tauri-managed E2EE sync state.
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
//! internally, and `e2ee_disconnect` calls `futo_notes_sync::state::delete_state_file`.

use std::ops::Deref;

use futo_notes_sync::{AbortableTask, SyncSession};

/// Tauri-managed sync state cell. Derefs to the shared [`SyncSession`] so the
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
        }
    }

    #[tokio::test]
    async fn snapshot_set_clear_round_trip() {
        let s = SyncState::default();
        assert!(s.snapshot().await.is_none());
        assert!(!s.is_connected().await);

        s.set_connected(make_connected()).await;
        assert!(s.is_connected().await);
        let snap = s.snapshot().await.unwrap();
        assert_eq!(snap.max_version, 10);
        assert_eq!(snap.object_map.len(), 1);
        assert_eq!(snap.collection_id, "c1");

        s.clear().await;
        assert!(!s.is_connected().await);
        assert!(s.snapshot().await.is_none());
    }

    #[tokio::test]
    async fn stop_live_and_note_changed_are_safe_when_not_running() {
        let s = SyncState::default();
        // No live task: must be no-ops, not panic.
        s.stop_live();
        s.note_changed();
        s.stop_live();
    }
}
