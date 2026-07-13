use std::collections::HashMap;
use std::path::{Path, PathBuf};

use futo_notes_core::files::write_atomic_text;
use serde::{Deserialize, Serialize};

const STATE_FILE: &str = ".e2ee-state.json";
const ANCESTRY_FILE: &str = ".e2ee-ancestry.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectState {
    pub object_id: String,
    pub version: u64,
    pub blob_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mtime_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct ConnectedState {
    pub base_url: String,
    pub token: String,
    pub user_id: String,
    pub collection_id: String,
    pub vault_key: [u8; 32],
    pub object_map: HashMap<String, ObjectState>,
    pub max_version: u64,
    pub pull_cursor: u64,
    pub oversize_skip: HashMap<String, i64>,
}

#[derive(Default, Serialize, Deserialize)]
struct DiskState {
    #[serde(default = "format_version")]
    version: u8,
    #[serde(default)]
    object_map: HashMap<String, ObjectState>,
    #[serde(default)]
    max_version: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pull_cursor: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    collection_id: Option<String>,
}

fn format_version() -> u8 {
    1
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Ancestry {
    pub object_id: String,
    pub hash: String,
}

#[derive(Serialize, Deserialize)]
struct DiskAncestry {
    version: u8,
    files: HashMap<String, Ancestry>,
}

#[derive(Default)]
pub(crate) struct Loaded {
    pub object_map: HashMap<String, ObjectState>,
    pub max_version: u64,
    pub pull_cursor: u64,
}

pub(crate) fn state_path(root: &Path) -> PathBuf {
    root.join(STATE_FILE)
}

fn ancestry_path(root: &Path) -> PathBuf {
    root.join(ANCESTRY_FILE)
}

fn read_disk_state(root: &Path) -> Option<DiskState> {
    let raw = std::fs::read_to_string(state_path(root)).ok()?;
    serde_json::from_str(&raw).ok()
}

fn read_legacy(root: &Path) -> Option<DiskState> {
    let raw = std::fs::read_to_string(root.join(".app-state.json")).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let map = value.get("e2eeObjectMap")?.as_object()?;
    let object_map = map
        .iter()
        .filter_map(|(name, entry)| {
            serde_json::from_value(entry.clone())
                .ok()
                .map(|entry| (name.clone(), entry))
        })
        .collect();
    Some(DiskState {
        version: 1,
        object_map,
        max_version: value
            .get("e2eeMaxVersion")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0),
        pull_cursor: None,
        collection_id: value
            .get("e2eeCollectionId")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
    })
}

pub(crate) fn load(root: &Path, collection_id: &str) -> Loaded {
    let Some(disk) = read_disk_state(root).or_else(|| read_legacy(root)) else {
        return Loaded::default();
    };
    let has_data = disk.max_version != 0 || !disk.object_map.is_empty();
    if has_data && disk.collection_id.as_deref() != Some(collection_id) {
        let _ = demote(root);
        return Loaded::default();
    }
    Loaded {
        object_map: disk.object_map,
        max_version: disk.max_version,
        pull_cursor: disk.pull_cursor.unwrap_or(0),
    }
}

pub(crate) fn save(root: &Path, state: &ConnectedState) -> Result<(), String> {
    let disk = DiskState {
        version: 1,
        object_map: state.object_map.clone(),
        max_version: state.max_version,
        pull_cursor: Some(state.pull_cursor),
        collection_id: Some(state.collection_id.clone()),
    };
    let json = serde_json::to_string_pretty(&disk).map_err(|e| e.to_string())?;
    write_atomic_text(&state_path(root), &json)
}

pub(crate) fn load_ancestry(root: &Path) -> HashMap<String, Ancestry> {
    std::fs::read_to_string(ancestry_path(root))
        .ok()
        .and_then(|raw| serde_json::from_str::<DiskAncestry>(&raw).ok())
        .map(|disk| disk.files)
        .unwrap_or_default()
}

pub fn demote(root: &Path) -> Result<(), String> {
    let path = state_path(root);
    let Some(disk) = read_disk_state(root) else {
        return Ok(());
    };
    let files = disk
        .object_map
        .into_iter()
        .filter_map(|(name, entry)| {
            entry.hash.map(|hash| {
                (
                    name,
                    Ancestry {
                        object_id: entry.object_id,
                        hash,
                    },
                )
            })
        })
        .collect();
    let ancestry = serde_json::to_string_pretty(&DiskAncestry { version: 1, files })
        .map_err(|e| e.to_string())?;
    // Ancestry is best-effort. Keeping the live map after disconnect is the
    // dangerous outcome because the next connection could turn local absence
    // into fleet-wide tombstones. Always remove live state even if ancestry
    // cannot be written.
    let _ = write_atomic_text(&ancestry_path(root), &ancestry);
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.to_string()),
    }
    Ok(())
}

pub(crate) fn clear_ancestry(root: &Path) {
    let _ = std::fs::remove_file(ancestry_path(root));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new() -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!(
                "futo-sync-store-test-{}-{n}",
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

    fn entry(object_id: &str) -> ObjectState {
        ObjectState {
            object_id: object_id.into(),
            version: 3,
            blob_key: format!("blob-{object_id}"),
            hash: Some(format!("hash-{object_id}")),
            mtime_ms: Some(1_700_000_000_000),
            size_bytes: Some(42),
        }
    }

    fn state(collection: &str) -> ConnectedState {
        ConnectedState {
            base_url: "http://127.0.0.1:1".into(),
            token: "token".into(),
            user_id: "user".into(),
            collection_id: collection.into(),
            vault_key: [7; 32],
            object_map: HashMap::from([("note.md".into(), entry("o1"))]),
            max_version: 10,
            pull_cursor: 8,
            oversize_skip: HashMap::new(),
        }
    }

    #[test]
    fn state_round_trips_both_watermarks() {
        let root = TempRoot::new();
        save(root.path(), &state("col-1")).unwrap();

        let loaded = load(root.path(), "col-1");
        assert_eq!(loaded.max_version, 10);
        assert_eq!(loaded.pull_cursor, 8);
        assert_eq!(loaded.object_map["note.md"].object_id, "o1");
    }

    #[test]
    fn collection_change_resets_and_demotes_state() {
        let root = TempRoot::new();
        save(root.path(), &state("col-old")).unwrap();

        let loaded = load(root.path(), "col-new");
        assert_eq!(loaded.max_version, 0);
        assert!(loaded.object_map.is_empty());
        assert!(!state_path(root.path()).exists());
        assert_eq!(load_ancestry(root.path())["note.md"].object_id, "o1");
    }

    #[test]
    fn untagged_state_with_data_is_not_trusted() {
        let root = TempRoot::new();
        std::fs::write(
            state_path(root.path()),
            r#"{"version":1,"object_map":{},"max_version":7}"#,
        )
        .unwrap();

        let loaded = load(root.path(), "col-any");
        assert_eq!(loaded.max_version, 0);
        assert!(loaded.object_map.is_empty());
    }

    #[test]
    fn absent_pull_cursor_forces_a_full_relist() {
        let root = TempRoot::new();
        std::fs::write(
            state_path(root.path()),
            r#"{"version":1,"object_map":{},"max_version":42,"collection_id":"col-1"}"#,
        )
        .unwrap();

        let loaded = load(root.path(), "col-1");
        assert_eq!(loaded.max_version, 42);
        assert_eq!(loaded.pull_cursor, 0);
    }

    #[test]
    fn missing_or_garbage_state_loads_empty() {
        let root = TempRoot::new();
        assert!(load(root.path(), "col-1").object_map.is_empty());
        std::fs::write(state_path(root.path()), "not json").unwrap();
        assert!(load(root.path(), "col-1").object_map.is_empty());
    }

    #[test]
    fn object_state_uses_the_cross_platform_json_shape() {
        let json = serde_json::to_string(&entry("o1")).unwrap();
        assert!(json.contains("\"objectId\""));
        assert!(json.contains("\"blobKey\""));
        assert!(json.contains("\"mtimeMs\""));
        assert!(json.contains("\"sizeBytes\""));
        assert!(!json.contains("object_id"));
    }

    #[test]
    fn absent_optional_object_fields_round_trip_without_nulls() {
        let mut value = entry("o1");
        value.hash = None;
        value.mtime_ms = None;
        value.size_bytes = None;
        let json = serde_json::to_string(&value).unwrap();
        assert!(!json.contains("null"));
        assert_eq!(serde_json::from_str::<ObjectState>(&json).unwrap(), value);
    }

    #[test]
    fn legacy_state_keeps_valid_entries_and_drops_malformed_ones() {
        let root = TempRoot::new();
        std::fs::write(
            root.path().join(".app-state.json"),
            r#"{
                "e2eeCollectionId":"col-1",
                "e2eeMaxVersion":7,
                "e2eeObjectMap":{
                    "good.md":{"objectId":"o9","version":4,"blobKey":"bk9","hash":"h"},
                    "broken.md":{"version":1}
                }
            }"#,
        )
        .unwrap();

        let loaded = load(root.path(), "col-1");
        assert_eq!(loaded.max_version, 7);
        assert_eq!(loaded.pull_cursor, 0);
        assert_eq!(loaded.object_map.len(), 1);
        assert_eq!(loaded.object_map["good.md"].object_id, "o9");
    }

    #[test]
    fn legacy_state_resets_for_a_different_or_unknown_collection() {
        for collection_field in ["\"e2eeCollectionId\":\"col-old\",", ""] {
            let root = TempRoot::new();
            let json = format!(
                r#"{{{collection_field}"e2eeMaxVersion":7,"e2eeObjectMap":{{"note.md":{{"objectId":"o9","version":4,"blobKey":"bk9","hash":"h"}}}}}}"#
            );
            std::fs::write(root.path().join(".app-state.json"), json).unwrap();
            let loaded = load(root.path(), "col-new");
            assert!(loaded.object_map.is_empty());
            assert_eq!(loaded.max_version, 0);
        }
    }

    #[test]
    fn canonical_state_wins_over_legacy_state() {
        let root = TempRoot::new();
        save(root.path(), &state("col-1")).unwrap();
        std::fs::write(
            root.path().join(".app-state.json"),
            r#"{"e2eeCollectionId":"col-1","e2eeMaxVersion":99,"e2eeObjectMap":{"legacy.md":{"objectId":"old","version":1,"blobKey":"old"}}}"#,
        )
        .unwrap();

        let loaded = load(root.path(), "col-1");
        assert_eq!(loaded.max_version, 10);
        assert!(loaded.object_map.contains_key("note.md"));
        assert!(!loaded.object_map.contains_key("legacy.md"));
    }

    #[test]
    fn demote_writes_only_verifiable_ancestry_and_removes_live_state() {
        let root = TempRoot::new();
        let mut connected = state("col-1");
        let mut hashless = entry("o2");
        hashless.hash = None;
        connected.object_map.insert("hashless.md".into(), hashless);
        save(root.path(), &connected).unwrap();

        demote(root.path()).unwrap();
        assert!(!state_path(root.path()).exists());
        let ancestry = load_ancestry(root.path());
        assert_eq!(ancestry["note.md"].object_id, "o1");
        assert!(!ancestry.contains_key("hashless.md"));
    }

    #[test]
    fn demote_removes_live_state_even_if_ancestry_write_fails() {
        let root = TempRoot::new();
        save(root.path(), &state("col-1")).unwrap();
        std::fs::create_dir(ancestry_path(root.path())).unwrap();

        demote(root.path()).unwrap();
        assert!(!state_path(root.path()).exists());
    }

    #[test]
    fn repeated_demote_keeps_existing_ancestry() {
        let root = TempRoot::new();
        save(root.path(), &state("col-1")).unwrap();
        demote(root.path()).unwrap();
        demote(root.path()).unwrap();
        assert_eq!(load_ancestry(root.path()).len(), 1);
    }

    #[test]
    fn missing_or_garbage_ancestry_is_empty() {
        let root = TempRoot::new();
        assert!(load_ancestry(root.path()).is_empty());
        std::fs::write(ancestry_path(root.path()), "not json").unwrap();
        assert!(load_ancestry(root.path()).is_empty());
    }
}
