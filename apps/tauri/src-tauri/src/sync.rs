//! E2EE sync Tauri command surface.
//!
//! Thin wrapper over the shared `futo-notes-sync` crate, which owns the
//! orchestrator (connect / resume / pull / push / full reconcile), the
//! `ConnectedState` type, and the on-disk `.e2ee-state.json` persistence.
//! This module keeps ONLY the `#[tauri::command]` handlers plus the small
//! glue that adapts the crate's Tauri-free hooks (progress sink + pre-write)
//! to Tauri events and the filesystem-watcher suppression map. The JS↔Rust
//! IPC contract (command names, camelCase input/output shapes, emitted
//! events) is preserved byte-for-byte.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::collections::HashMap;

use futo_notes_sync::live::{LiveFuture, LiveHandle, SyncSessionListener};
use futo_notes_sync::{ConnectedState, SyncProgress};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::core::{notes_root, CoreState};
use crate::sync_state::{SyncState, TauriTask};

/// Watcher-suppression window. Mirrors `WATCHER_SUPPRESSION_MS` in core.rs
/// (kept private there); the sync writes register each touched filename with
/// `now_ms() + WATCHER_SUPPRESSION_MS` so the filesystem watcher ignores our
/// own writes for that window and doesn't echo them back as external edits.
const WATCHER_SUPPRESSION_MS: i64 = 5_000;

// ── Inputs / outputs (camelCase wire shapes — DO NOT CHANGE) ──────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct E2eeConnectInput {
    pub server_url: String,
    pub password: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct E2eeConnectOutput {
    pub user_id: String,
    pub collection_id: String,
    /// Bearer token; JS persists this so `e2ee_resume` can skip login on
    /// app restart. If it expires, `e2ee_resume` will surface the 401 and
    /// JS should fall back to `e2ee_connect`.
    pub token: String,
    /// Whether the server identified itself as `password` or `dev` mode.
    /// JS uses this to gate the UI affordances around the stored password.
    pub auth_mode: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct E2eeResumeInput {
    pub server_url: String,
    pub token: String,
    pub user_id: String,
    pub collection_id: String,
    pub password: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct E2eeStatusOutput {
    pub connected: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collection_id: Option<String>,
    pub max_version: u64,
    pub object_count: usize,
    pub migrated_legacy: bool,
}

/// Wire `SyncSummary` returned by `e2ee_sync_run` and emitted on
/// `sync:live-synced`. Identical to the pre-relocation shape so the JS
/// `SyncSummary` type in `syncServiceE2ee.ts` is unchanged. The crate's rich
/// `SyncSummary` carries ids already stripped of `.md`; this just copies
/// the count + id-list + rename fields out of it.
#[derive(Debug, Default, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyncSummary {
    pub uploaded: usize,
    pub downloaded: usize,
    pub deleted: usize,
    pub conflicts: usize,
    /// Per-item operations that failed without aborting the cycle. Non-empty
    /// drives the desktop failure indicator + toast.
    pub failures: Vec<SyncFailure>,
    /// User-facing one-liner describing `failures`, computed once in
    /// `futo-notes-sync` so every shell shows identical wording. `None` for
    /// a clean cycle.
    pub failure_message: Option<String>,
    pub updated_ids: Vec<String>,
    pub deleted_ids: Vec<String>,
    pub peer_updated_ids: Vec<String>,
    pub peer_deleted_ids: Vec<String>,
    pub renamed: Vec<RenamePair>,
}

/// Wire form of a per-item sync failure. `kind` is `"upload" | "delete" |
/// "checkpoint"`; `statusCode` is the server HTTP status when present.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncFailure {
    pub filename: String,
    pub kind: String,
    pub status_code: Option<u16>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenamePair {
    pub from_id: String,
    pub to_id: String,
}

// ── Glue ───────────────────────────────────────────────────────────────────

fn root_for(app: &AppHandle) -> Result<PathBuf, String> {
    notes_root(app)
}

/// Map the crate's rich `SyncSummary` to the wire shape. The crate's
/// `updated_ids` etc. are already ids (filename minus `.md`); counts are
/// `u32` and cast to `usize`. Renames map `from_id`/`to_id` -> `fromId`/`toId`.
fn to_wire_summary(s: &futo_notes_sync::SyncSummary) -> SyncSummary {
    SyncSummary {
        uploaded: s.uploaded as usize,
        downloaded: s.downloaded as usize,
        deleted: s.deleted as usize,
        conflicts: s.conflicts as usize,
        failure_message: s.failure_message(),
        failures: s
            .failures
            .iter()
            .map(|f| SyncFailure {
                filename: f.filename.clone(),
                kind: f.kind.as_str().to_owned(),
                status_code: f.status_code,
            })
            .collect(),
        updated_ids: s.updated_ids.clone(),
        deleted_ids: s.deleted_ids.clone(),
        peer_updated_ids: s.peer_updated_ids.clone(),
        peer_deleted_ids: s.peer_deleted_ids.clone(),
        renamed: s
            .renamed
            .iter()
            .map(|r| RenamePair {
                from_id: r.from_id.clone(),
                to_id: r.to_id.clone(),
            })
            .collect(),
    }
}

/// Register `filename` for watcher suppression: the filesystem watcher
/// ignores changes to it until `now_ms() + WATCHER_SUPPRESSION_MS`, so our
/// own sync writes don't echo back as external edits.
fn suppress_watcher(suppressed: &Arc<Mutex<HashMap<String, i64>>>, filename: &str) {
    if let Ok(mut map) = suppressed.lock() {
        let expires_at = futo_notes_core::files::now_ms() + WATCHER_SUPPRESSION_MS;
        map.insert(filename.to_owned(), expires_at);
    }
}

/// Bridges the shared [`SyncSessionListener`] (called by `live::watch`) onto
/// the Tauri `sync:live-state` event. The byte-for-byte `{live, status, ...}`
/// payloads match the pre-Phase-3 inline emits. The rich `sync:live-synced`
/// event (which carries the full `SyncSummary`, not just counts) is emitted
/// inside the pull/push closure, so `on_synced` here is intentionally inert.
struct TauriListener {
    app: AppHandle,
}

impl SyncSessionListener for TauriListener {
    fn on_synced(&self, _summary: futo_notes_sync::SyncSummary) {
        // Rich `sync:live-synced` is emitted in the pull/push closure.
    }
    fn on_connected(&self) {
        let _ = self.app.emit(
            "sync:live-state",
            serde_json::json!({ "live": true, "status": "connected" }),
        );
    }
    fn on_error(&self, message: String) {
        let _ = self.app.emit(
            "sync:live-state",
            serde_json::json!({
                "live": false,
                "status": "reconnecting",
                "message": message,
            }),
        );
    }
    fn on_cycle_error(&self, message: String) {
        // The stream is still connected — keep `live` up so the idle ✓ tick
        // survives a failing cycle; the message alone raises the error UI.
        let _ = self.app.emit(
            "sync:live-state",
            serde_json::json!({
                "live": true,
                "status": "cycle-error",
                "message": message,
            }),
        );
    }
    fn on_stopped(&self) {
        let _ = self.app.emit(
            "sync:live-state",
            serde_json::json!({ "live": false, "status": "stopped" }),
        );
    }
}

// ── Commands ─────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn e2ee_connect(
    app: AppHandle,
    state: State<'_, SyncState>,
    input: E2eeConnectInput,
) -> Result<E2eeConnectOutput, String> {
    let root = root_for(&app)?;
    // The crate persists the loaded/migrated map internally on connect.
    let (connected, result) =
        futo_notes_sync::connect(&root, &input.server_url, &input.password).await?;
    state.set_connected(connected).await;
    Ok(E2eeConnectOutput {
        user_id: result.user_id,
        collection_id: result.collection_id,
        token: result.token,
        auth_mode: result.auth_mode.to_owned(),
    })
}

#[tauri::command]
pub async fn e2ee_resume(
    app: AppHandle,
    state: State<'_, SyncState>,
    input: E2eeResumeInput,
) -> Result<(), String> {
    let root = root_for(&app)?;
    // MUST re-derive the key from the passed password — the
    // `window.__testSync.syncE2ee` path depends on this. A 401 surfaces as
    // an error string.
    let connected = futo_notes_sync::resume(
        &root,
        &input.server_url,
        &input.token,
        &input.user_id,
        &input.collection_id,
        &input.password,
    )
    .await?;
    state.set_connected(connected).await;
    Ok(())
}

#[tauri::command]
pub async fn e2ee_disconnect(app: AppHandle, state: State<'_, SyncState>) -> Result<(), String> {
    let root = root_for(&app)?;
    state.stop_live();
    state.clear().await;
    // Demote rather than delete: keep last-synced {objectId, hash} ancestry in
    // `.e2ee-ancestry.json` so a later reconnect's empty-map reconcile can
    // fast-forward drifted-but-unedited notes instead of parking a
    // `(conflict <oid8>)` copy of each. Missing-file is not an error.
    futo_notes_sync::state::demote_state_to_ancestry(&root)
}

#[tauri::command]
pub async fn e2ee_status(state: State<'_, SyncState>) -> Result<E2eeStatusOutput, String> {
    let snapshot = state.snapshot().await;
    Ok(match snapshot {
        None => E2eeStatusOutput {
            connected: false,
            server_url: None,
            user_id: None,
            collection_id: None,
            max_version: 0,
            object_count: 0,
            migrated_legacy: false,
        },
        Some(c) => E2eeStatusOutput {
            connected: true,
            server_url: Some(c.base_url),
            user_id: Some(c.user_id),
            collection_id: Some(c.collection_id),
            max_version: c.max_version,
            object_count: c.object_map.len(),
            // JS only reads `connected`; kept hardcoded as before.
            migrated_legacy: false,
        },
    })
}

#[tauri::command]
pub async fn e2ee_sync_run(
    app: AppHandle,
    state: State<'_, SyncState>,
) -> Result<SyncSummary, String> {
    // Hold the sync gate for the whole cycle so a concurrent live pull can't
    // race the cursor.
    let _gate = state.lock_sync_gate().await;

    let snap = state.snapshot().await.ok_or("E2EE not connected")?;
    let root = root_for(&app)?;

    // Progress sink: forward to the `sync:progress` Tauri event. The crate
    // emits exactly the phases {"reconciling","pushing","pulling"}, which
    // drives the connect-modal progress in SettingsScreen.svelte.
    let progress_app = app.clone();
    let progress = move |p: SyncProgress| {
        let _ = progress_app.emit(
            "sync:progress",
            serde_json::json!({
                "phase": p.phase,
                "current": p.current,
                "total": p.total,
            }),
        );
    };

    // Pre-write hook: register each touched filename for watcher suppression
    // immediately before the crate writes/deletes it on disk.
    let suppressed = app.state::<CoreState>().suppressed_watcher_events.clone();
    let pre_write = move |filename: &str| {
        suppress_watcher(&suppressed, filename);
    };

    let (summary, next) = futo_notes_sync::run_sync(&snap, &root, &progress, &pre_write).await?;
    state.set_connected(next).await;

    Ok(to_wire_summary(&summary))
}

// ── Live sync (SSE) ────────────────────────────────────────────────────────

/// Build the gated full-cycle (`run_sync`) closure that drives the live loop's
/// single `cycle`. A fresh SSE event and a debounced local edit are just
/// different triggers for "reconcile with the server now", so both run the same
/// push+pull cycle. Holds the sync-gate for the whole cycle (so the cursor
/// can't regress against a manual sync), suppresses the watcher for every
/// touched file, and emits the rich `sync:live-synced` event with the full
/// `SyncSummary`.
fn gated_run_sync_closure(
    inner: Arc<tokio::sync::Mutex<Option<ConnectedState>>>,
    sync_gate: Arc<tokio::sync::Mutex<()>>,
    suppressed: Arc<Mutex<HashMap<String, i64>>>,
    app: AppHandle,
    root: PathBuf,
) -> Box<dyn Fn() -> LiveFuture<Result<Option<futo_notes_sync::SyncSummary>, String>> + Send + Sync> {
    Box::new(move || -> LiveFuture<Result<Option<futo_notes_sync::SyncSummary>, String>> {
        // Capture owned clones so the returned future is 'static.
        let inner = Arc::clone(&inner);
        let sync_gate = Arc::clone(&sync_gate);
        let suppressed = suppressed.clone();
        let app = app.clone();
        let root = root.clone();
        Box::pin(async move {
            // Gate first, then brief inner locks — same discipline as
            // `e2ee_sync_run`, so the cursor can't regress.
            let _gate = sync_gate.lock().await;
            let snap = match inner.lock().await.clone() {
                Some(s) => s,
                None => return Ok(None),
            };
            // No progress UI during the live loop.
            let progress = |_p: SyncProgress| {};
            let pre_write = move |filename: &str| {
                suppress_watcher(&suppressed, filename);
            };
            let (summary, next) = futo_notes_sync::run_sync(&snap, &root, &progress, &pre_write)
                .await
                .map_err(|e| e.to_string())?;
            *inner.lock().await = Some(next);
            let _ = app.emit("sync:live-synced", to_wire_summary(&summary));
            Ok(Some(summary))
        })
    })
}

#[tauri::command]
pub async fn e2ee_start_live(app: AppHandle, state: State<'_, SyncState>) -> Result<(), String> {
    if !state.is_connected().await {
        return Err("E2EE not connected".to_owned());
    }

    let root = root_for(&app)?;
    let inner = state.inner_arc();
    let sync_gate = state.sync_gate_arc();
    let suppressed = app.state::<CoreState>().suppressed_watcher_events.clone();

    let listener: Arc<dyn SyncSessionListener> = Arc::new(TauriListener { app: app.clone() });

    state.start_live_with(
        listener,
        |listener| LiveHandle {
            snapshot: {
                let inner = Arc::clone(&inner);
                Box::new(move || -> LiveFuture<Option<ConnectedState>> {
                    let inner = Arc::clone(&inner);
                    Box::pin(async move { inner.lock().await.clone() })
                })
            },
            // One gated full cycle drives both triggers: the live loop fires it
            // on SSE events and on debounced local edits alike.
            cycle: gated_run_sync_closure(
                Arc::clone(&inner),
                Arc::clone(&sync_gate),
                suppressed.clone(),
                app.clone(),
                root.clone(),
            ),
            listener,
        },
        |handle, cancel_rx, note_rx| {
            TauriTask(tauri::async_runtime::spawn(async move {
                futo_notes_sync::live::watch(handle, cancel_rx, note_rx).await;
            }))
        },
    );
    Ok(())
}

#[tauri::command]
pub async fn e2ee_stop_live(_app: AppHandle, state: State<'_, SyncState>) -> Result<(), String> {
    state.stop_live();
    Ok(())
}

/// Signal that a local note changed (the write-once auto-push input). The TS
/// save path calls this; the live loop debounces and pushes the edit to peers.
/// No-op when no live task is running (disconnected) — so this is safe to call
/// unconditionally after every save. Replaces the desktop's
/// `notifySavedV2 → performSync('local-save')` path with a single Rust-side
/// debounce shared with native.
#[tauri::command]
pub async fn e2ee_note_changed(state: State<'_, SyncState>) -> Result<(), String> {
    state.note_changed();
    Ok(())
}

// ── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use futo_notes_sync::E2eeObjectMapEntry;
    use std::collections::HashMap;

    fn sample_state() -> ConnectedState {
        let mut map = HashMap::new();
        map.insert(
            "alpha.md".to_owned(),
            E2eeObjectMapEntry {
                object_id: "oA".into(),
                version: 2,
                blob_key: "bkA".into(),
                hash: None,
                mtime_ms: None,
                size_bytes: None,
            },
        );
        ConnectedState {
            base_url: "http://x".into(),
            token: "tok".into(),
            user_id: "uX".into(),
            collection_id: "cY".into(),
            vault_key: [1u8; 32],
            object_map: map,
            max_version: 12,
            oversize_skip: HashMap::new(),
        }
    }

    /// Pure projection mirroring what `e2ee_status` does, so the status
    /// logic is unit-tested without a Tauri runtime.
    fn project_status(snap: Option<ConnectedState>) -> E2eeStatusOutput {
        match snap {
            None => E2eeStatusOutput {
                connected: false,
                server_url: None,
                user_id: None,
                collection_id: None,
                max_version: 0,
                object_count: 0,
                migrated_legacy: false,
            },
            Some(c) => E2eeStatusOutput {
                connected: true,
                server_url: Some(c.base_url),
                user_id: Some(c.user_id),
                collection_id: Some(c.collection_id),
                max_version: c.max_version,
                object_count: c.object_map.len(),
                migrated_legacy: false,
            },
        }
    }

    #[tokio::test]
    async fn status_when_disconnected_reports_defaults() {
        let s = SyncState::default();
        let out = project_status(s.snapshot().await);
        assert!(!out.connected);
        assert_eq!(out.max_version, 0);
        assert_eq!(out.object_count, 0);
        assert!(!out.migrated_legacy);
    }

    #[tokio::test]
    async fn status_when_connected_reflects_snapshot() {
        let s = SyncState::default();
        s.set_connected(sample_state()).await;
        let out = project_status(s.snapshot().await);
        assert!(out.connected);
        assert_eq!(out.max_version, 12);
        assert_eq!(out.object_count, 1);
        assert_eq!(out.collection_id.as_deref(), Some("cY"));
    }

    #[test]
    fn input_output_serde_camel_case() {
        // e2ee_connect input: serverUrl/password
        let raw = r#"{"serverUrl":"http://x","password":"p"}"#;
        let parsed: E2eeConnectInput = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.server_url, "http://x");

        // e2ee_resume input: serverUrl/token/userId/collectionId/password
        let raw = r#"{"serverUrl":"u","token":"t","userId":"id","collectionId":"c","password":"p"}"#;
        let parsed: E2eeResumeInput = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.user_id, "id");

        // status output: camelCase keys
        let out = E2eeStatusOutput {
            connected: true,
            server_url: Some("u".into()),
            user_id: Some("uid".into()),
            collection_id: Some("cid".into()),
            max_version: 7,
            object_count: 3,
            migrated_legacy: false,
        };
        let j = serde_json::to_string(&out).unwrap();
        assert!(j.contains("\"serverUrl\""));
        assert!(j.contains("\"userId\""));
        assert!(j.contains("\"collectionId\""));
        assert!(j.contains("\"maxVersion\""));
        assert!(j.contains("\"objectCount\""));

        // wire SyncSummary: camelCase keys + RenamePair {fromId,toId}
        let summary = SyncSummary {
            uploaded: 1,
            downloaded: 2,
            deleted: 3,
            conflicts: 4,
            failures: vec![SyncFailure {
                filename: "note.md".into(),
                kind: "upload".into(),
                status_code: Some(500),
            }],
            failure_message: Some("1 change couldn't reach the server (HTTP 500)".into()),
            updated_ids: vec!["a".into()],
            deleted_ids: vec!["b".into()],
            peer_updated_ids: vec!["c".into()],
            peer_deleted_ids: vec!["d".into()],
            renamed: vec![RenamePair {
                from_id: "old".into(),
                to_id: "new".into(),
            }],
        };
        let j = serde_json::to_string(&summary).unwrap();
        assert!(j.contains("\"updatedIds\""));
        assert!(j.contains("\"peerUpdatedIds\""));
        assert!(j.contains("\"peerDeletedIds\""));
        assert!(j.contains("\"fromId\""));
        assert!(j.contains("\"toId\""));
        // Failure channel: core-computed message + per-item detail with
        // camelCase statusCode.
        assert!(j.contains("\"failureMessage\""));
        assert!(j.contains("\"statusCode\":500"));
    }
}
