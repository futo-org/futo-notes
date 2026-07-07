//! Shared sync-session wrapper.
//!
//! Hoisted out of the per-adapter wrappers (`futo-notes-ffi`'s `SyncClient`
//! and `futo-notes-tauri`'s `SyncState`), which both held an identical
//! triple — an optional `ConnectedState` behind an async mutex, a `sync_gate`,
//! and a live-task handle — plus identical start/stop/gate plumbing. That
//! machinery now lives here once; each adapter wraps it with its own listener
//! (a UniFFI callback interface, or Tauri events) and supplies the
//! orchestrator work (pull-only vs full cycle, watcher suppression, progress)
//! via the [`crate::live::LiveHandle`] closures it already builds.
//!
//! ## Invariants this type owns
//!
//! - `inner` (the session) is locked only briefly — to clone for a snapshot or
//!   commit an advanced state — and NEVER across network I/O, so a concurrent
//!   `status()` snapshot never blocks behind a sync.
//! - `sync_gate` serializes every snapshot→sync→commit critical section
//!   (manual sync AND the live loop's pull AND the auto-push branch) so the
//!   persisted `max_version` cursor can never regress.
//! - `live` holds the running SSE task; `stop_live` is a sync no-op when not
//!   running and is called for idempotent restart.

use std::sync::Arc;

use tokio::sync::{mpsc, Mutex, OwnedMutexGuard};

use crate::live::{LiveHandle, SyncSessionListener};
use crate::state::ConnectedState;

/// A spawned join handle that can be aborted. Both adapters spawn on a tokio
/// runtime, but FFI uses `tokio::spawn` (→ `tokio::task::JoinHandle`) while
/// Tauri uses `tauri::async_runtime::spawn` (→ its own handle). We abstract
/// over "can be aborted" so the session doesn't depend on either crate's
/// concrete handle type.
pub trait AbortableTask: Send + 'static {
    fn abort(&self);
}

impl AbortableTask for tokio::task::JoinHandle<()> {
    fn abort(&self) {
        tokio::task::JoinHandle::abort(self);
    }
}

/// A running live-sync task: a cancel channel, the note-changed signal sender
/// (the write-once auto-push input), and the spawned task's join handle.
struct LiveTask {
    cancel: mpsc::Sender<()>,
    note_changed: mpsc::Sender<()>,
    join: Box<dyn AbortableTask>,
}

/// The shared session cell + live-task lifecycle. One instance per vault.
#[derive(Default)]
pub struct SyncSession {
    inner: Arc<Mutex<Option<ConnectedState>>>,
    /// Serializes manual sync vs. live pull vs. auto-push so the object-map
    /// cursor can't regress when they race.
    sync_gate: Arc<Mutex<()>>,
    /// The running live-sync task, if any. `std::sync::Mutex` so `stop_live`
    /// (sync) and `note_changed` (sync) can touch it without an executor.
    live: std::sync::Mutex<Option<LiveTask>>,
}

impl SyncSession {
    pub fn new() -> Self {
        Self::default()
    }

    // ── Session-cell access ──────────────────────────────────────────────

    /// Read-only clone of the connected state. `None` if disconnected.
    pub async fn snapshot(&self) -> Option<ConnectedState> {
        self.inner.lock().await.clone()
    }

    /// Replace the entire connected state.
    pub async fn set_connected(&self, state: ConnectedState) {
        *self.inner.lock().await = Some(state);
    }

    /// Clear the in-memory state. Does NOT touch the on-disk file — callers
    /// do that via [`crate::state::demote_state_to_ancestry`] so disconnect
    /// ordering stays explicit.
    pub async fn clear(&self) {
        *self.inner.lock().await = None;
    }

    /// Whether a session is currently connected.
    pub async fn is_connected(&self) -> bool {
        self.inner.lock().await.is_some()
    }

    /// Synchronous status snapshot. NEVER panics or blocks, so it is safe to
    /// call from any thread — including a tokio worker, where the old
    /// `blocking_lock()` would `panic!` (and abort the native app) per tokio's
    /// "no blocking_lock inside a runtime" rule. The inner mutex is only ever
    /// held briefly for a clone/commit, so a `try_lock` miss is rare and
    /// transient; on a miss we degrade to `None` (a momentary
    /// disconnected-shaped snapshot) rather than aborting the process. FFI's
    /// `status()` already maps `None` to the disconnected status.
    pub fn status_blocking(&self) -> Option<ConnectedState> {
        match self.inner.try_lock() {
            Ok(guard) => guard.clone(),
            Err(_) => None,
        }
    }

    /// The inner `Arc<Mutex<Option<ConnectedState>>>` — adapters clone it into
    /// their [`LiveHandle`] `snapshot`/`pull`/`push` closures.
    pub fn inner_arc(&self) -> Arc<Mutex<Option<ConnectedState>>> {
        Arc::clone(&self.inner)
    }

    /// The `sync_gate` `Arc` — adapters clone it into the gated pull/push
    /// closures to serialize against manual sync.
    pub fn sync_gate_arc(&self) -> Arc<Mutex<()>> {
        Arc::clone(&self.sync_gate)
    }

    /// Acquire the sync gate as an owned guard. Held for a whole manual-sync
    /// cycle so a concurrent live pull/push can't race the cursor.
    pub async fn lock_sync_gate(&self) -> OwnedMutexGuard<()> {
        Arc::clone(&self.sync_gate).lock_owned().await
    }

    // ── Live-task lifecycle ──────────────────────────────────────────────

    /// Spawn the SSE live loop with an adapter-provided spawner.
    ///
    /// `make_handle(note_changed_for_loop)` builds the [`LiveHandle`] (the
    /// caller threads `inner_arc`/`sync_gate_arc` into its closures). `spawn`
    /// runs `live::watch(handle, cancel_rx, note_rx)` on the adapter's runtime
    /// and returns an abortable join handle.
    ///
    /// Idempotent: stops any prior live task first.
    pub fn start_live_with<H, SpawnFn, T>(
        &self,
        listener: Arc<dyn SyncSessionListener>,
        make_handle: H,
        spawn: SpawnFn,
    ) where
        H: FnOnce(Arc<dyn SyncSessionListener>) -> LiveHandle,
        SpawnFn: FnOnce(LiveHandle, mpsc::Receiver<()>, mpsc::Receiver<()>) -> T,
        T: AbortableTask,
    {
        // Idempotent restart: tear down any prior live task first.
        self.stop_live();

        let (cancel_tx, cancel_rx) = mpsc::channel::<()>(1);
        // Buffer of 1 + drop-on-full coalescing: a flood of edits collapses to
        // a single pending signal; the loop's PUSH_DEBOUNCE handles the rest.
        let (note_tx, note_rx) = mpsc::channel::<()>(1);

        let handle = make_handle(listener);
        let join = spawn(handle, cancel_rx, note_rx);

        *self.live.lock().unwrap() = Some(LiveTask {
            cancel: cancel_tx,
            note_changed: note_tx,
            join: Box::new(join),
        });
    }

    /// Signal the live loop that a local note changed (the write-once
    /// auto-push input). No-op when no live task is running. Non-blocking and
    /// lossy-by-design: a full channel means a push is already pending, so the
    /// debounce will coalesce this edit into it.
    pub fn note_changed(&self) {
        if let Ok(guard) = self.live.lock() {
            if let Some(task) = guard.as_ref() {
                let _ = task.note_changed.try_send(());
            }
        }
    }

    /// Stop live sync if running. Safe to call when not running. Best-effort
    /// graceful cancel, then abort as a backstop in case the task is parked in
    /// a network read between cancel checkpoints.
    pub fn stop_live(&self) {
        if let Some(task) = self.live.lock().unwrap().take() {
            let _ = task.cancel.try_send(());
            task.join.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::E2eeObjectMapEntry;
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
            oversize_skip: HashMap::new(),
        }
    }

    #[tokio::test]
    async fn snapshot_set_clear_round_trip() {
        let s = SyncSession::new();
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

    #[test]
    fn status_blocking_matches_async_snapshot() {
        // `status_blocking` now uses `try_lock` and never panics, so it is safe
        // from any thread. We use a scoped runtime only to drive the async
        // `set_connected`, then read the snapshot back.
        let rt = tokio::runtime::Runtime::new().unwrap();
        let s = SyncSession::new();
        assert!(s.status_blocking().is_none());
        rt.block_on(s.set_connected(make_connected()));
        let snap = s.status_blocking().unwrap();
        assert_eq!(snap.max_version, 10);
    }

    // F2 regression: the old `status_blocking` used `tokio::sync::Mutex::
    // blocking_lock`, which `panic!`s when called from inside a tokio runtime
    // worker thread — the native shell's `SyncEventListener` callbacks fire on
    // exactly such a worker, so a status() call from a listener aborted the
    // whole app. `try_lock` must degrade gracefully instead of panicking.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn status_blocking_does_not_panic_on_runtime_worker() {
        let s = SyncSession::new();
        s.set_connected(make_connected()).await;
        // Called from within a runtime worker. The OLD code panics here; the
        // new try_lock-based code returns a real snapshot (uncontended) without
        // aborting.
        let snap = tokio::task::spawn_blocking({
            let s2 = Arc::new(s);
            move || s2.status_blocking()
        })
        .await
        .expect("status_blocking must not panic on a runtime worker");
        assert!(snap.is_some());
    }

    // F2 regression: when the inner mutex is held (e.g. a sync is mid-commit),
    // `status_blocking` must return None rather than block/panic.
    #[tokio::test]
    async fn status_blocking_returns_none_while_inner_locked() {
        let s = Arc::new(SyncSession::new());
        s.set_connected(make_connected()).await;
        // Hold the inner guard for the whole probe so status_blocking's
        // try_lock is guaranteed to miss.
        let guard = s.inner_arc().lock_owned().await;
        let probe = tokio::task::spawn_blocking({
            let s2 = Arc::clone(&s);
            move || s2.status_blocking()
        })
        .await
        .expect("probe must not panic");
        assert!(probe.is_none(), "held inner lock must yield None, not block");
        drop(guard);
    }

    #[test]
    fn stop_live_and_note_changed_are_safe_when_not_running() {
        let s = SyncSession::new();
        // No live task: both must be no-ops, not panic.
        s.stop_live();
        s.note_changed();
        s.note_changed();
        s.stop_live();
    }
}
