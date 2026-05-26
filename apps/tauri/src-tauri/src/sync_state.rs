//! Tauri-managed E2EE sync state.
//!
//! Owns the in-memory connection (URL, token, derived key, object map,
//! `change_seq` cursor) plus disk persistence for the bookkeeping that
//! must survive restarts: the object map and the highest `change_seq`
//! we've seen.
//!
//! Layout choice (per AGENTS.md "file-first" policy and the Feb-4
//! `931fdcf` no-database decision): the object map + max version live in
//! a Rust-owned `.e2ee-state.json` next to the JS-owned `.app-state.json`,
//! inside the notes root. JS continues to own server URL, token, user/
//! collection IDs, salt, and the remembered password.
//!
//! Cold-start migration: if `.e2ee-state.json` is missing AND the legacy
//! `e2eeObjectMap` field still exists in `.app-state.json` (from before
//! the port), we import it on first load and the next JS app-state save
//! will drop the legacy fields.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use futo_notes_core::files::write_atomic_text;
use serde::{Deserialize, Serialize};

const STATE_FILENAME: &str = ".e2ee-state.json";
const LEGACY_APP_STATE_FILENAME: &str = ".app-state.json";
const STATE_FORMAT_VERSION: u8 = 1;

// ── Object map entry ─────────────────────────────────────────────────────

/// Per-filename bookkeeping for E2EE sync. Mirrors the TS shape in
/// `src/lib/appState.ts:42` so the legacy import is a direct deserialize.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct E2eeObjectMapEntry {
    pub object_id: String,
    pub version: u64,
    /// Blob key of the last version we observed locally. Used as the
    /// common ancestor in 3-way merges; the server retains orphaned blobs
    /// for 1 year specifically for this.
    pub blob_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
    /// On-disk mtime at the last successful push — fast-path filter that
    /// lets push skip read+sha256 when both mtime and size still match.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mtime_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
}

// ── On-disk shape ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedState {
    #[serde(default = "default_format_version")]
    version: u8,
    #[serde(default)]
    object_map: HashMap<String, E2eeObjectMapEntry>,
    #[serde(default)]
    max_version: u64,
}

fn default_format_version() -> u8 {
    STATE_FORMAT_VERSION
}

impl Default for PersistedState {
    fn default() -> Self {
        Self {
            version: STATE_FORMAT_VERSION,
            object_map: HashMap::new(),
            max_version: 0,
        }
    }
}

// ── In-memory connected state ────────────────────────────────────────────

/// Set once on `e2ee_connect` / `e2ee_resume`. Cleared on `e2ee_disconnect`.
#[derive(Clone)]
pub struct ConnectedState {
    pub base_url: String,
    pub token: String,
    pub user_id: String,
    pub collection_id: String,
    pub vault_key: [u8; 32],
    pub object_map: HashMap<String, E2eeObjectMapEntry>,
    pub max_version: u64,
}

impl std::fmt::Debug for ConnectedState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Avoid leaking the vault key into logs / panics.
        f.debug_struct("ConnectedState")
            .field("base_url", &self.base_url)
            .field("user_id", &self.user_id)
            .field("collection_id", &self.collection_id)
            .field("object_map_size", &self.object_map.len())
            .field("max_version", &self.max_version)
            .field("token", &"<redacted>")
            .field("vault_key", &"<redacted>")
            .finish()
    }
}

// ── Tauri-managed state cell ─────────────────────────────────────────────

#[derive(Default)]
pub struct SyncState {
    inner: Arc<RwLock<Option<ConnectedState>>>,
    persist_lock: Arc<tokio::sync::Mutex<()>>,
}

impl SyncState {
    pub fn is_connected(&self) -> bool {
        self.inner.read().map(|g| g.is_some()).unwrap_or(false)
    }

    /// Read-only snapshot of the connected state. None if disconnected.
    pub fn snapshot(&self) -> Option<ConnectedState> {
        self.inner.read().ok().and_then(|g| g.clone())
    }

    /// Replace the entire connected state.
    pub fn set_connected(&self, state: ConnectedState) {
        if let Ok(mut g) = self.inner.write() {
            *g = Some(state);
        }
    }

    /// Clear the in-memory state (does not delete the file on disk —
    /// callers do that via `delete_state_file` so disconnect ordering is
    /// explicit).
    pub fn clear(&self) {
        if let Ok(mut g) = self.inner.write() {
            *g = None;
        }
    }

    /// Mutate the object map + max version under the write lock. Returns
    /// false if not connected.
    pub fn with_map_mut<F>(&self, f: F) -> bool
    where
        F: FnOnce(&mut HashMap<String, E2eeObjectMapEntry>, &mut u64),
    {
        match self.inner.write() {
            Ok(mut g) => match g.as_mut() {
                Some(c) => {
                    f(&mut c.object_map, &mut c.max_version);
                    true
                }
                None => false,
            },
            Err(_) => false,
        }
    }

    /// Persist the current object map + max version to `.e2ee-state.json`
    /// in `notes_root`. Coalesces concurrent saves via `persist_lock` so
    /// only one write is in flight at a time.
    pub async fn persist(&self, notes_root: &Path) -> Result<(), String> {
        let _guard = self.persist_lock.lock().await;
        let snapshot = match self.snapshot() {
            Some(s) => s,
            None => return Ok(()), // disconnected, nothing to write
        };
        let persisted = PersistedState {
            version: STATE_FORMAT_VERSION,
            object_map: snapshot.object_map,
            max_version: snapshot.max_version,
        };
        let json = serde_json::to_string_pretty(&persisted).map_err(|e| e.to_string())?;
        let path = state_file_path(notes_root);
        write_atomic_text(&path, &json)
    }

    /// Disconnect atomically: clear the in-memory state AND delete the
    /// persisted file, both under `persist_lock` so a concurrent
    /// `persist()` can't resurrect the file with stale data after the
    /// delete (TOCTOU between snapshot-take and atomic-rename).
    pub async fn disconnect_and_delete(&self, notes_root: &Path) -> Result<(), String> {
        let _guard = self.persist_lock.lock().await;
        // Order matters: clear in-memory first so any persist() that
        // wins the lock right after we release sees None and is a no-op.
        self.clear();
        delete_state_file(notes_root)
    }
}

// ── Disk paths and serialization helpers ─────────────────────────────────

pub fn state_file_path(notes_root: &Path) -> PathBuf {
    notes_root.join(STATE_FILENAME)
}

pub fn legacy_app_state_path(notes_root: &Path) -> PathBuf {
    notes_root.join(LEGACY_APP_STATE_FILENAME)
}

/// Load the persisted object map + max version, falling back to the legacy
/// fields in `.app-state.json` on first run after the port. Returns the
/// default empty state if neither file is present.
pub fn load_or_migrate(notes_root: &Path) -> Loaded {
    if let Some(state) = load_persisted_state(notes_root) {
        return Loaded {
            object_map: state.object_map,
            max_version: state.max_version,
            migrated_from_legacy: false,
        };
    }
    if let Some(legacy) = import_legacy_state(notes_root) {
        return Loaded {
            object_map: legacy.object_map,
            max_version: legacy.max_version,
            migrated_from_legacy: true,
        };
    }
    Loaded {
        object_map: HashMap::new(),
        max_version: 0,
        migrated_from_legacy: false,
    }
}

pub struct Loaded {
    pub object_map: HashMap<String, E2eeObjectMapEntry>,
    pub max_version: u64,
    pub migrated_from_legacy: bool,
}

fn load_persisted_state(notes_root: &Path) -> Option<PersistedState> {
    let raw = std::fs::read_to_string(state_file_path(notes_root)).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Read the legacy `.app-state.json`, extract just the `e2eeObjectMap` and
/// `e2eeMaxVersion` keys, and return them as a fresh `PersistedState`.
/// Returns `None` if the file is missing or the legacy fields are absent.
///
/// Per-entry resilience: deserialize each map entry independently and
/// drop the row if it fails to parse. Otherwise a single corrupt or
/// pre-2025-shape entry would abort the entire migration and trigger a
/// full re-upload (sync orchestrator treats an empty map as "new
/// install" — every local file gets uploaded as duplicates of what's
/// already on the server). The deleted TS test
/// "drops map entries that are missing required fields" specifically
/// covered this contract.
fn import_legacy_state(notes_root: &Path) -> Option<PersistedState> {
    let raw = std::fs::read_to_string(legacy_app_state_path(notes_root)).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let map_v = v.get("e2eeObjectMap")?;
    if map_v.is_null() {
        return None;
    }
    let raw_map: HashMap<String, serde_json::Value> =
        serde_json::from_value(map_v.clone()).ok()?;
    let mut object_map: HashMap<String, E2eeObjectMapEntry> = HashMap::with_capacity(raw_map.len());
    let mut dropped = 0usize;
    for (filename, entry_v) in raw_map {
        match serde_json::from_value::<E2eeObjectMapEntry>(entry_v) {
            Ok(entry) => {
                object_map.insert(filename, entry);
            }
            Err(_) => {
                dropped += 1;
            }
        }
    }
    if dropped > 0 {
        eprintln!(
            "[e2ee] legacy import: dropped {dropped} object_map entries with missing/invalid fields"
        );
    }
    let max_version = v
        .get("e2eeMaxVersion")
        .and_then(|x| x.as_u64())
        .unwrap_or(0);
    Some(PersistedState {
        version: STATE_FORMAT_VERSION,
        object_map,
        max_version,
    })
}

/// Delete the persisted file. Called from `e2ee_disconnect`. Missing-file
/// is not an error.
pub fn delete_state_file(notes_root: &Path) -> Result<(), String> {
    let path = state_file_path(notes_root);
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn temp_root() -> PathBuf {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let now = futo_notes_core::files::now_ms();
        let dir = std::env::temp_dir().join(format!("futo-sync-state-test-{now}-{n}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn entry(object_id: &str, version: u64, blob_key: &str) -> E2eeObjectMapEntry {
        E2eeObjectMapEntry {
            object_id: object_id.into(),
            version,
            blob_key: blob_key.into(),
            hash: Some(format!("{object_id}-hash")),
            mtime_ms: Some(1_700_000_000_000),
            size_bytes: Some(42),
        }
    }

    fn make_connected() -> ConnectedState {
        let mut map = HashMap::new();
        map.insert("note.md".to_owned(), entry("o1", 3, "bk1"));
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
    async fn persist_then_load_round_trip() {
        let root = temp_root();
        let s = SyncState::default();
        s.set_connected(make_connected());
        s.persist(&root).await.unwrap();

        let loaded = load_or_migrate(&root);
        assert!(!loaded.migrated_from_legacy);
        assert_eq!(loaded.max_version, 10);
        assert_eq!(loaded.object_map.len(), 1);
        let e = loaded.object_map.get("note.md").unwrap();
        assert_eq!(e.object_id, "o1");
        assert_eq!(e.version, 3);
        assert_eq!(e.blob_key, "bk1");
        std::fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn persist_disconnected_is_noop() {
        let root = temp_root();
        let s = SyncState::default();
        // No connect → persist returns Ok and writes nothing.
        s.persist(&root).await.unwrap();
        assert!(!state_file_path(&root).exists());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn missing_files_load_empty() {
        let root = temp_root();
        let loaded = load_or_migrate(&root);
        assert!(loaded.object_map.is_empty());
        assert_eq!(loaded.max_version, 0);
        assert!(!loaded.migrated_from_legacy);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn legacy_app_state_migrated_when_no_e2ee_file() {
        let root = temp_root();
        let legacy = r#"{
            "deviceId": "abc",
            "e2eeObjectMap": {
                "alpha.md": {
                    "objectId": "oA",
                    "version": 1,
                    "blobKey": "bkA",
                    "hash": "h",
                    "mtimeMs": 1,
                    "sizeBytes": 10
                },
                "beta.md": {
                    "objectId": "oB",
                    "version": 7,
                    "blobKey": "bkB"
                }
            },
            "e2eeMaxVersion": 99
        }"#;
        std::fs::write(legacy_app_state_path(&root), legacy).unwrap();

        let loaded = load_or_migrate(&root);
        assert!(loaded.migrated_from_legacy);
        assert_eq!(loaded.max_version, 99);
        assert_eq!(loaded.object_map.len(), 2);
        let alpha = loaded.object_map.get("alpha.md").unwrap();
        assert_eq!(alpha.version, 1);
        assert_eq!(alpha.size_bytes, Some(10));
        let beta = loaded.object_map.get("beta.md").unwrap();
        assert_eq!(beta.version, 7);
        // Optional fields gracefully missing.
        assert!(beta.hash.is_none());
        assert!(beta.mtime_ms.is_none());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn legacy_import_drops_bad_entries_keeps_valid_ones() {
        // Regression: a single corrupt entry must NOT abort the whole
        // migration. Before this fix, `serde_json::from_value::<HashMap<…>>`
        // failed wholesale on one bad row, the migration returned None,
        // and the Rust client started with an empty object_map — combined
        // with the missing-reconcile path, every local note got re-
        // uploaded as a fresh blob on the next sync.
        let root = temp_root();
        let legacy = r#"{
            "e2eeObjectMap": {
                "good.md": {
                    "objectId": "oA",
                    "version": 1,
                    "blobKey": "bkA"
                },
                "missing-blobkey.md": {
                    "objectId": "oB",
                    "version": 7
                },
                "wrong-type.md": "not-an-object",
                "another-good.md": {
                    "objectId": "oC",
                    "version": 2,
                    "blobKey": "bkC",
                    "hash": "h2"
                }
            },
            "e2eeMaxVersion": 50
        }"#;
        std::fs::write(legacy_app_state_path(&root), legacy).unwrap();
        let loaded = load_or_migrate(&root);
        assert!(loaded.migrated_from_legacy);
        assert_eq!(loaded.max_version, 50);
        // Two valid rows survive; two bad rows dropped.
        assert_eq!(loaded.object_map.len(), 2);
        assert!(loaded.object_map.contains_key("good.md"));
        assert!(loaded.object_map.contains_key("another-good.md"));
        assert!(!loaded.object_map.contains_key("missing-blobkey.md"));
        assert!(!loaded.object_map.contains_key("wrong-type.md"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn migration_skipped_when_persisted_file_exists() {
        let root = temp_root();
        // Persisted file has a different value than the legacy file.
        let persisted = r#"{"version":1,"object_map":{},"max_version":500}"#;
        std::fs::write(state_file_path(&root), persisted).unwrap();
        let legacy = r#"{"e2eeObjectMap":{"x.md":{"objectId":"x","version":1,"blobKey":"b"}},"e2eeMaxVersion":1}"#;
        std::fs::write(legacy_app_state_path(&root), legacy).unwrap();

        let loaded = load_or_migrate(&root);
        // Persisted wins; legacy is ignored.
        assert!(!loaded.migrated_from_legacy);
        assert_eq!(loaded.max_version, 500);
        assert!(loaded.object_map.is_empty());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn json_field_names_match_ts_appstate() {
        // The wire shape MUST match the TS `e2eeObjectMap` entry exactly
        // so a vault that round-trips between Rust and TS clients (during
        // the migration window) deserializes cleanly on both sides.
        let e = entry("o1", 3, "bk1");
        let j = serde_json::to_string(&e).unwrap();
        assert!(j.contains("\"objectId\""));
        assert!(j.contains("\"blobKey\""));
        assert!(j.contains("\"mtimeMs\""));
        assert!(j.contains("\"sizeBytes\""));
        assert!(!j.contains("\"object_id\""));
        assert!(!j.contains("\"blob_key\""));
    }

    #[test]
    fn entry_serde_round_trip_with_optional_absent() {
        let mut e = entry("o", 1, "bk");
        e.hash = None;
        e.mtime_ms = None;
        e.size_bytes = None;
        let j = serde_json::to_string(&e).unwrap();
        // Absent options should be skipped, not emit null.
        assert!(!j.contains("null"));
        let round: E2eeObjectMapEntry = serde_json::from_str(&j).unwrap();
        assert_eq!(round, e);
    }

    #[tokio::test]
    async fn delete_state_file_is_idempotent() {
        let root = temp_root();
        // Missing-file delete is fine.
        delete_state_file(&root).unwrap();
        // After persisting, delete actually removes it.
        let s = SyncState::default();
        s.set_connected(make_connected());
        s.persist(&root).await.unwrap();
        assert!(state_file_path(&root).exists());
        delete_state_file(&root).unwrap();
        assert!(!state_file_path(&root).exists());
        // And a second delete is still fine.
        delete_state_file(&root).unwrap();
        std::fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn with_map_mut_only_runs_when_connected() {
        let s = SyncState::default();
        let ran = s.with_map_mut(|_, _| {});
        assert!(!ran);

        s.set_connected(make_connected());
        let ran = s.with_map_mut(|map, ver| {
            map.insert("new.md".into(), entry("o2", 1, "bk2"));
            *ver += 1;
        });
        assert!(ran);

        let snap = s.snapshot().unwrap();
        assert_eq!(snap.object_map.len(), 2);
        assert_eq!(snap.max_version, 11);
    }

    #[tokio::test]
    async fn concurrent_persist_serializes_via_lock() {
        // Two persist calls in flight at once must serialize so neither
        // observes a corrupt intermediate file. write_atomic_text already
        // handles the per-write atomicity; persist_lock serializes the
        // dispatch so the on-disk state reflects the last-write-wins of
        // whichever lock acquisition went second.
        let root = temp_root();
        let s = SyncState::default();
        s.set_connected(make_connected());
        // Wrap in Arc so both tasks share the same SyncState.
        let s = Arc::new(s);
        let r1 = root.clone();
        let r2 = root.clone();
        let s1 = s.clone();
        let s2 = s.clone();
        let h1 = tokio::spawn(async move {
            for _ in 0..5 {
                s1.persist(&r1).await.unwrap();
            }
        });
        let h2 = tokio::spawn(async move {
            for _ in 0..5 {
                s2.persist(&r2).await.unwrap();
            }
        });
        h1.await.unwrap();
        h2.await.unwrap();
        // File must exist and be valid JSON parseable as PersistedState.
        let raw = std::fs::read_to_string(state_file_path(&root)).unwrap();
        let parsed: PersistedState = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed.max_version, 10);
        std::fs::remove_dir_all(&root).ok();
    }
}
