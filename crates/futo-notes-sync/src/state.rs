//! E2EE sync state shared by every platform adapter.
//!
//! Owns the in-memory connection (URL, token, derived key, object map,
//! `change_seq` cursor) plus disk persistence for the bookkeeping that must
//! survive restarts: the object map and the highest `change_seq` we've seen.
//!
//! The persisted `.e2ee-state.json` lives inside the notes root the caller
//! passes to `SyncClient`. Format matches the Tauri app's `.e2ee-state.json`
//! byte-for-byte (same field names + camelCase object-map entries) so a
//! vault can round-trip between the native-iOS spike client and the Tauri
//! client.
//!
//! Legacy migration (Phase 5): on first load, if `.e2ee-state.json` is absent
//! but a pre-port `.app-state.json` carries an `e2eeObjectMap`, we import it so
//! the first sync does NOT treat every local file as new and re-upload
//! duplicates of what's already on the server. Mirrors the Tauri
//! `import_legacy_state`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use futo_notes_core::files::write_atomic_text;
use serde::{Deserialize, Serialize};

const STATE_FILENAME: &str = ".e2ee-state.json";
const LEGACY_APP_STATE_FILENAME: &str = ".app-state.json";
const ANCESTRY_FILENAME: &str = ".e2ee-ancestry.json";
const STATE_FORMAT_VERSION: u8 = 1;
const ANCESTRY_FORMAT_VERSION: u8 = 1;

// ── Object map entry ─────────────────────────────────────────────────────

/// Per-filename bookkeeping for E2EE sync. Mirrors the TS shape in
/// `src/lib/appState.ts` so the on-disk file is interchangeable with the
/// Tauri client's `.e2ee-state.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct E2eeObjectMapEntry {
    pub object_id: String,
    pub version: u64,
    /// Blob key of the last version we observed locally. Used as the common
    /// ancestor in 3-way merges; the server retains orphaned blobs for 1
    /// year specifically for this.
    pub blob_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
    /// On-disk mtime at the last successful push — fast-path filter that lets
    /// push skip read+sha256 when both mtime and size still match.
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
    /// Server collection this cursor/object-map describes. `None` on files
    /// written before this field existed (and on legacy imports). The
    /// orchestrator resets the state when the server-side collection identity
    /// changes — see `reset_if_collection_changed`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    collection_id: Option<String>,
}

fn default_format_version() -> u8 {
    STATE_FORMAT_VERSION
}

// ── In-memory connected state ────────────────────────────────────────────

/// Set once on connect / resume. The `SyncClient` holds an
/// `Arc<Mutex<Option<ConnectedState>>>`.
#[derive(Clone)]
pub struct ConnectedState {
    pub base_url: String,
    pub token: String,
    pub user_id: String,
    pub collection_id: String,
    pub vault_key: [u8; 32],
    pub object_map: HashMap<String, E2eeObjectMapEntry>,
    pub max_version: u64,
    /// In-session set of files the server rejected as too large (HTTP 413),
    /// keyed by filename → the on-disk `mtime_ms` of the rejected version. Used
    /// to skip re-uploading (and re-encrypting) an oversize note every cycle;
    /// the entry is dropped — and the upload retried — once the file's mtime
    /// changes (the user edited it again) or it syncs successfully. In-memory
    /// only (not persisted): a fresh connect/resume starts empty, so a restart
    /// re-checks once.
    pub oversize_skip: HashMap<String, i64>,
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
            .field("oversize_skip", &self.oversize_skip.len())
            .field("token", &"<redacted>")
            .field("vault_key", &"<redacted>")
            .finish()
    }
}

// ── Disk paths and serialization helpers ─────────────────────────────────

pub fn state_file_path(notes_root: &Path) -> PathBuf {
    notes_root.join(STATE_FILENAME)
}

/// Loaded object-map state from disk (or empty if no file).
pub struct Loaded {
    pub object_map: HashMap<String, E2eeObjectMapEntry>,
    pub max_version: u64,
    /// True when the map came from a legacy `.app-state.json` migration rather
    /// than `.e2ee-state.json` (the caller persists it forward on connect).
    pub migrated_legacy: bool,
    /// Collection the persisted state belongs to (`None`: pre-field file or
    /// legacy import — treated as "unknown, assume current").
    pub collection_id: Option<String>,
}

impl Loaded {
    /// Drop the persisted cursor + object map unless they are TAGGED with the
    /// collection just connected to. A stale cursor silently blinds every
    /// pull: `max_version` can sit beyond the new collection's head, so the
    /// delta always comes back empty and remote changes never arrive. A stale
    /// object map is just as bad on the push side: entries claiming the
    /// server already holds a note make `plan_push` skip it, so pre-existing
    /// notes silently never reach the new collection.
    ///
    /// `None` (pre-field state files, legacy imports) is treated as UNKNOWN
    /// provenance and reset too — trusting it once preserved the stale-cursor
    /// blindness forever for exactly the cohort the tag was added to heal
    /// (the file gets tagged with the new collection on the next persist,
    /// burying the corruption). The cost of the reset is one re-reconcile
    /// through the empty-map path, which hash-dedups against local files —
    /// no data loss, no conflict copies for identical content.
    pub fn reset_if_collection_changed(self, current_collection_id: &str) -> Loaded {
        if self.matches_collection(current_collection_id) {
            return self;
        }
        let prev_desc = self.collection_id.as_deref().unwrap_or("<untagged>");
        eprintln!(
            "[sync] persisted sync state is for collection {prev_desc}, connected to {current_collection_id}; resetting cursor + object map"
        );
        Loaded {
            object_map: HashMap::new(),
            max_version: 0,
            migrated_legacy: false,
            collection_id: None,
        }
    }

    /// Whether the persisted state is usable as-is for `current_collection_id`:
    /// tagged with the same collection, or nothing persisted at all. Untagged
    /// state WITH data is unknown provenance and does not match.
    pub fn matches_collection(&self, current_collection_id: &str) -> bool {
        match &self.collection_id {
            Some(prev) => prev == current_collection_id,
            None => self.max_version == 0 && self.object_map.is_empty(),
        }
    }
}

/// Load the persisted object map + max version. Prefers `.e2ee-state.json`;
/// falls back to a one-time legacy `.app-state.json` import; otherwise empty.
pub fn load(notes_root: &Path) -> Loaded {
    if let Some(state) = load_persisted_state(notes_root) {
        return Loaded {
            object_map: state.object_map,
            max_version: state.max_version,
            migrated_legacy: false,
            collection_id: state.collection_id,
        };
    }
    if let Some(state) = import_legacy_state(notes_root) {
        return Loaded {
            object_map: state.object_map,
            max_version: state.max_version,
            migrated_legacy: true,
            collection_id: state.collection_id,
        };
    }
    Loaded {
        object_map: HashMap::new(),
        max_version: 0,
        migrated_legacy: false,
        collection_id: None,
    }
}

fn load_persisted_state(notes_root: &Path) -> Option<PersistedState> {
    let raw = std::fs::read_to_string(state_file_path(notes_root)).ok()?;
    serde_json::from_str(&raw).ok()
}

fn legacy_app_state_path(notes_root: &Path) -> PathBuf {
    notes_root.join(LEGACY_APP_STATE_FILENAME)
}

/// Read the legacy `.app-state.json`, extract just `e2eeObjectMap` +
/// `e2eeMaxVersion`. Per-entry resilient: a single malformed entry is dropped
/// rather than aborting the whole migration (an empty map would make the next
/// sync re-upload everything). Mirrors the Tauri `import_legacy_state`.
fn import_legacy_state(notes_root: &Path) -> Option<PersistedState> {
    let raw = std::fs::read_to_string(legacy_app_state_path(notes_root)).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let map_v = v.get("e2eeObjectMap")?;
    if map_v.is_null() {
        return None;
    }
    let raw_map: HashMap<String, serde_json::Value> = serde_json::from_value(map_v.clone()).ok()?;
    let mut object_map = HashMap::with_capacity(raw_map.len());
    let mut dropped = 0usize;
    for (filename, entry_v) in raw_map {
        match serde_json::from_value::<E2eeObjectMapEntry>(entry_v) {
            Ok(entry) => {
                object_map.insert(filename, entry);
            }
            Err(_) => dropped += 1,
        }
    }
    if dropped > 0 {
        eprintln!("[sync] legacy import: dropped {dropped} object_map entries with missing/invalid fields");
    }
    let max_version = v.get("e2eeMaxVersion").and_then(|x| x.as_u64()).unwrap_or(0);
    Some(PersistedState {
        version: STATE_FORMAT_VERSION,
        object_map,
        max_version,
        collection_id: None,
    })
}

/// Persist the given object map + max version (tagged with the collection
/// they describe) to `.e2ee-state.json` in `notes_root` via an atomic write.
pub fn persist(
    notes_root: &Path,
    object_map: &HashMap<String, E2eeObjectMapEntry>,
    max_version: u64,
    collection_id: &str,
) -> Result<(), String> {
    let persisted = PersistedState {
        version: STATE_FORMAT_VERSION,
        object_map: object_map.clone(),
        max_version,
        collection_id: Some(collection_id.to_owned()),
    };
    let json = serde_json::to_string_pretty(&persisted).map_err(|e| e.to_string())?;
    let path = state_file_path(notes_root);
    write_atomic_text(&path, &json)
}

/// Delete the persisted file. Missing-file is not an error.
pub fn delete_state_file(notes_root: &Path) -> Result<(), String> {
    let path = state_file_path(notes_root);
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// ── Ancestry (survives disconnect) ───────────────────────────────────────

/// Last-synced identity of one file, preserved across disconnect / state
/// reset: enough to prove "this local file is exactly what this device last
/// synced for this object" (or "the remote hasn't moved since this device
/// last synced it") WITHOUT keeping the live cursor/object map — a live map
/// carried across a disconnect would let a reconnect propagate every file
/// deleted while disconnected as a fleet-wide tombstone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AncestryEntry {
    pub object_id: String,
    /// Content hash (sha-256 of the plaintext) at the last successful sync.
    pub hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedAncestry {
    #[serde(default = "default_ancestry_version")]
    version: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    collection_id: Option<String>,
    #[serde(default)]
    files: HashMap<String, AncestryEntry>,
}

fn default_ancestry_version() -> u8 {
    ANCESTRY_FORMAT_VERSION
}

pub fn ancestry_file_path(notes_root: &Path) -> PathBuf {
    notes_root.join(ANCESTRY_FILENAME)
}

/// Demote the persisted sync state to `.e2ee-ancestry.json` and delete the
/// live `.e2ee-state.json`. Called on disconnect (instead of a bare delete)
/// and when the persisted state is dropped because the collection identity
/// changed. The ancestry file keeps filename → {objectId, lastSyncedHash} so
/// the next empty-map reconcile can tell "stale here but never edited on this
/// device" (fast-forward to remote) and "edited here against an unchanged
/// remote" (push as update) apart from true divergence — instead of parking a
/// `name (conflict <oid8>).md` copy for every note that drifted while the
/// device was disconnected (the July 2026 conflict-spam incident).
///
/// When there is no persisted state (double disconnect, fresh install) any
/// existing ancestry file is left untouched.
///
/// Deleting the live state is the load-bearing step and must NOT be gated on
/// the ancestry write succeeding: the object map surviving a disconnect is the
/// mass-tombstone hazard (a reconnect would read files deleted-while-
/// disconnected as deletions and propagate them fleet-wide). All three
/// disconnect callers swallow this function's error, so an early-return before
/// the delete would silently leave the live map on disk. The ancestry write is
/// therefore best-effort — a failure only costs the next reconcile its
/// fast-forward precision (it falls back to the conservative park), never
/// correctness — while the delete's error is propagated.
pub fn demote_state_to_ancestry(notes_root: &Path) -> Result<(), String> {
    if let Some(state) = load_persisted_state(notes_root) {
        let files: HashMap<String, AncestryEntry> = state
            .object_map
            .into_iter()
            .filter_map(|(name, e)| {
                e.hash.map(|hash| (name, AncestryEntry { object_id: e.object_id, hash }))
            })
            .collect();
        if !files.is_empty() {
            let persisted = PersistedAncestry {
                version: ANCESTRY_FORMAT_VERSION,
                collection_id: state.collection_id,
                files,
            };
            match serde_json::to_string_pretty(&persisted) {
                Ok(json) => {
                    if let Err(e) = write_atomic_text(&ancestry_file_path(notes_root), &json) {
                        eprintln!("[sync] failed to write ancestry on disconnect: {e}");
                    }
                }
                Err(e) => eprintln!("[sync] failed to serialize ancestry on disconnect: {e}"),
            }
        }
    }
    delete_state_file(notes_root)
}

/// Load the ancestry map left behind by the last demote. Empty when absent
/// or unreadable (ancestry is advisory — worst case the reconcile stays as
/// conservative as it was before ancestry existed).
pub fn load_ancestry(notes_root: &Path) -> HashMap<String, AncestryEntry> {
    let raw = match std::fs::read_to_string(ancestry_file_path(notes_root)) {
        Ok(raw) => raw,
        Err(_) => return HashMap::new(),
    };
    match serde_json::from_str::<PersistedAncestry>(&raw) {
        Ok(persisted) => persisted.files,
        Err(_) => HashMap::new(),
    }
}

/// Delete the ancestry file. Missing-file is not an error.
pub fn delete_ancestry_file(notes_root: &Path) -> Result<(), String> {
    match std::fs::remove_file(ancestry_file_path(notes_root)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Load the persisted state for a connect/resume to `current_collection_id`,
/// demoting it to ancestry first when it would be reset (different or unknown
/// collection tag) — see `reset_if_collection_changed`.
pub fn load_for_collection(notes_root: &Path, current_collection_id: &str) -> Loaded {
    let loaded = load(notes_root);
    if !loaded.matches_collection(current_collection_id) {
        // Preserve merge ancestry before dropping the stale map (best effort —
        // a failed demote only costs reconcile precision, never correctness).
        if let Err(e) = demote_state_to_ancestry(notes_root) {
            eprintln!("[sync] failed to demote stale sync state to ancestry: {e}");
        }
    }
    loaded.reset_if_collection_changed(current_collection_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn temp_root() -> PathBuf {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let now = futo_notes_core::files::now_ms();
        let dir = std::env::temp_dir().join(format!("futo-sync-spike-state-test-{now}-{n}"));
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

    #[test]
    fn persist_then_load_round_trip() {
        let root = temp_root();
        let mut map = HashMap::new();
        map.insert("note.md".to_owned(), entry("o1", 3, "bk1"));
        persist(&root, &map, 10, "col-1").unwrap();

        let loaded = load(&root);
        assert_eq!(loaded.max_version, 10);
        assert_eq!(loaded.object_map.len(), 1);
        let e = loaded.object_map.get("note.md").unwrap();
        assert_eq!(e.object_id, "o1");
        assert_eq!(e.version, 3);
        assert_eq!(e.blob_key, "bk1");
        assert_eq!(loaded.collection_id.as_deref(), Some("col-1"));
        std::fs::remove_dir_all(&root).ok();
    }

    // Regression: after a server-side vault reset (DB wipe / account
    // recreation) the new collection's head can sit BELOW the persisted
    // cursor; reusing the old state makes every pull come back empty, so
    // remote changes silently never arrive (observed 2026-06-04 across all
    // three clients). Connecting to a different collection must reset.
    #[test]
    fn reset_when_collection_changes_keep_when_same() {
        let root = temp_root();
        let mut map = HashMap::new();
        map.insert("note.md".to_owned(), entry("o1", 3, "bk1"));
        persist(&root, &map, 29, "col-old").unwrap();

        // Same collection: state survives.
        let same = load(&root).reset_if_collection_changed("col-old");
        assert_eq!(same.max_version, 29);
        assert_eq!(same.object_map.len(), 1);

        // Different collection: cursor + map dropped.
        let reset = load(&root).reset_if_collection_changed("col-new");
        assert_eq!(reset.max_version, 0);
        assert!(reset.object_map.is_empty());
        assert_eq!(reset.collection_id, None);
        std::fs::remove_dir_all(&root).ok();
    }

    // Pre-field state files (no collectionId key) are UNKNOWN provenance and
    // must reset like a changed collection. Trusting them once (the previous
    // behavior) permanently preserved the stale-cursor blindness for exactly
    // the cohort whose collection changed before the tag existed: the connect
    // immediately re-persisted the bad cursor TAGGED with the new collection,
    // burying the corruption.
    #[test]
    fn untagged_state_with_data_resets() {
        let root = temp_root();
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            state_file_path(&root),
            r#"{"version":1,"object_map":{},"max_version":7}"#,
        )
        .unwrap();
        let loaded = load(&root).reset_if_collection_changed("col-anything");
        assert_eq!(loaded.max_version, 0);
        assert!(loaded.object_map.is_empty());
        assert_eq!(loaded.collection_id, None);
        std::fs::remove_dir_all(&root).ok();
    }

    // A fresh client (no state at all) passes through untouched — the reset
    // would be a no-op, but it must not log the scary corruption line.
    #[test]
    fn empty_untagged_state_passes_through() {
        let root = temp_root();
        let loaded = load(&root).reset_if_collection_changed("col-anything");
        assert_eq!(loaded.max_version, 0);
        assert!(loaded.object_map.is_empty());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn missing_file_loads_empty() {
        let root = temp_root();
        let loaded = load(&root);
        assert!(loaded.object_map.is_empty());
        assert_eq!(loaded.max_version, 0);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn json_field_names_match_ts_appstate() {
        // The wire shape MUST match the TS `e2eeObjectMap` entry exactly so a
        // vault that round-trips between Rust and TS clients deserializes
        // cleanly on both sides.
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
        assert!(!j.contains("null"));
        let round: E2eeObjectMapEntry = serde_json::from_str(&j).unwrap();
        assert_eq!(round, e);
    }

    #[test]
    fn migrates_legacy_app_state_when_no_e2ee_state() {
        let root = temp_root();
        // A pre-port .app-state.json with an e2eeObjectMap (+ one malformed
        // entry that must be dropped, not abort the whole migration).
        let legacy = r#"{
            "someOtherField": 1,
            "e2eeMaxVersion": 7,
            "e2eeObjectMap": {
                "good.md": {"objectId":"o9","version":4,"blobKey":"bk9","hash":"h","mtimeMs":1700000000000,"sizeBytes":12},
                "broken.md": {"version":1}
            }
        }"#;
        std::fs::write(root.join(".app-state.json"), legacy).unwrap();

        let loaded = load(&root);
        assert!(loaded.migrated_legacy);
        assert_eq!(loaded.max_version, 7);
        assert_eq!(loaded.object_map.len(), 1); // broken.md dropped
        assert_eq!(loaded.object_map.get("good.md").unwrap().object_id, "o9");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn prefers_e2ee_state_over_legacy() {
        let root = temp_root();
        let mut map = HashMap::new();
        map.insert("canonical.md".to_owned(), entry("oc", 1, "bkc"));
        persist(&root, &map, 3, "col-1").unwrap();
        std::fs::write(
            root.join(".app-state.json"),
            r#"{"e2eeMaxVersion":99,"e2eeObjectMap":{"legacy.md":{"objectId":"ol","version":1,"blobKey":"bl"}}}"#,
        )
        .unwrap();

        let loaded = load(&root);
        assert!(!loaded.migrated_legacy);
        assert_eq!(loaded.max_version, 3);
        assert!(loaded.object_map.contains_key("canonical.md"));
        assert!(!loaded.object_map.contains_key("legacy.md"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn demote_writes_ancestry_and_deletes_state() {
        let root = temp_root();
        let mut map = HashMap::new();
        map.insert("note.md".to_owned(), entry("o1", 3, "bk1"));
        let mut hashless = entry("o2", 1, "bk2");
        hashless.hash = None;
        map.insert("hashless.md".to_owned(), hashless);
        persist(&root, &map, 10, "col-1").unwrap();

        demote_state_to_ancestry(&root).unwrap();

        assert!(!state_file_path(&root).exists(), "live state must be gone");
        let anc = load_ancestry(&root);
        assert_eq!(
            anc.get("note.md"),
            Some(&AncestryEntry { object_id: "o1".into(), hash: "o1-hash".into() })
        );
        // Entries with no recorded hash can't prove anything — dropped.
        assert!(!anc.contains_key("hashless.md"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn demote_deletes_state_even_when_ancestry_write_fails() {
        // The live map surviving a disconnect is the mass-tombstone hazard, so
        // the state delete must not be gated on the ancestry write. Force the
        // ancestry write to fail by pre-creating `.e2ee-ancestry.json` as a
        // DIRECTORY (write_atomic_text's rename onto it fails).
        let root = temp_root();
        let mut map = HashMap::new();
        map.insert("note.md".to_owned(), entry("o1", 3, "bk1"));
        persist(&root, &map, 10, "col-1").unwrap();
        std::fs::create_dir(ancestry_file_path(&root)).unwrap();

        // Best-effort ancestry write: the demote still succeeds and the live
        // state is gone.
        demote_state_to_ancestry(&root).unwrap();
        assert!(!state_file_path(&root).exists(), "live state must be deleted even if ancestry write fails");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn demote_without_state_keeps_existing_ancestry() {
        // Double disconnect / disconnect after a fresh install: the second
        // demote finds no live state and must NOT clobber the ancestry the
        // first one wrote.
        let root = temp_root();
        let mut map = HashMap::new();
        map.insert("note.md".to_owned(), entry("o1", 3, "bk1"));
        persist(&root, &map, 10, "col-1").unwrap();
        demote_state_to_ancestry(&root).unwrap();

        demote_state_to_ancestry(&root).unwrap();
        assert_eq!(load_ancestry(&root).len(), 1);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn load_ancestry_missing_or_garbage_is_empty() {
        let root = temp_root();
        assert!(load_ancestry(&root).is_empty());
        std::fs::write(ancestry_file_path(&root), "not json").unwrap();
        assert!(load_ancestry(&root).is_empty());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn load_for_collection_demotes_on_mismatch_keeps_on_match() {
        let root = temp_root();
        let mut map = HashMap::new();
        map.insert("note.md".to_owned(), entry("o1", 3, "bk1"));
        persist(&root, &map, 29, "col-old").unwrap();

        // Same collection: state survives, no ancestry written.
        let same = load_for_collection(&root, "col-old");
        assert_eq!(same.max_version, 29);
        assert!(load_ancestry(&root).is_empty());

        // Different collection: state reset AND demoted to ancestry.
        let reset = load_for_collection(&root, "col-new");
        assert_eq!(reset.max_version, 0);
        assert!(reset.object_map.is_empty());
        assert!(!state_file_path(&root).exists());
        assert_eq!(load_ancestry(&root).get("note.md").map(|a| a.object_id.as_str()), Some("o1"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn delete_state_file_is_idempotent() {
        let root = temp_root();
        delete_state_file(&root).unwrap();
        let map = HashMap::new();
        persist(&root, &map, 0, "col-1").unwrap();
        assert!(state_file_path(&root).exists());
        delete_state_file(&root).unwrap();
        assert!(!state_file_path(&root).exists());
        delete_state_file(&root).unwrap();
        std::fs::remove_dir_all(&root).ok();
    }
}
