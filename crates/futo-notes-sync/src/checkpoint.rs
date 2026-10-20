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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PendingCreate {
    #[serde(alias = "objectId")]
    pub mutation_id: String,
    pub original_name: String,
    pub hash: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone)]
pub struct ConnectedState {
    pub base_url: String,
    pub token: String,
    pub user_id: String,
    pub collection_id: String,
    pub vault_key: [u8; 32],
    pub object_map: HashMap<String, ObjectState>,
    pub(crate) pending_creates: HashMap<String, PendingCreate>,
    pub max_version: u64,
    pub pull_cursor: u64,
    pub oversize_skip: HashMap<String, i64>,
}

impl ConnectedState {
    pub fn new(
        base_url: String,
        token: String,
        user_id: String,
        collection_id: String,
        vault_key: [u8; 32],
    ) -> Self {
        Self {
            base_url,
            token,
            user_id,
            collection_id,
            vault_key,
            object_map: HashMap::new(),
            pending_creates: HashMap::new(),
            max_version: 0,
            pull_cursor: 0,
            oversize_skip: HashMap::new(),
        }
    }
}

#[derive(Default, Serialize, Deserialize)]
struct DiskState {
    #[serde(default = "format_version")]
    version: u8,
    #[serde(default)]
    object_map: HashMap<String, ObjectState>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pending_creates: HashMap<String, PendingCreate>,
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
    pub pending_creates: HashMap<String, PendingCreate>,
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
        pending_creates: HashMap::new(),
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
    let has_data =
        disk.max_version != 0 || !disk.object_map.is_empty() || !disk.pending_creates.is_empty();
    if has_data && disk.collection_id.as_deref() != Some(collection_id) {
        let _ = demote(root);
        return Loaded::default();
    }
    Loaded {
        object_map: disk.object_map,
        pending_creates: disk.pending_creates,
        max_version: disk.max_version,
        pull_cursor: disk.pull_cursor.unwrap_or(0),
    }
}

pub(crate) fn save(root: &Path, state: &ConnectedState) -> Result<(), String> {
    let disk = DiskState {
        version: 1,
        object_map: state.object_map.clone(),
        pending_creates: state.pending_creates.clone(),
        max_version: state.max_version,
        pull_cursor: Some(state.pull_cursor),
        collection_id: Some(state.collection_id.clone()),
    };
    let json = serde_json::to_string_pretty(&disk).map_err(|e| e.to_string())?;
    let path = state_path(root);
    // Every cycle ends with a save, and a push and a pull each save once, so a
    // no-op cycle (the ~95% case: safety poll, echo of a remote change already
    // applied) rewrote this ~1 MB file twice — serialize, temp file, fsync,
    // rename, directory fsync — to land bytes identical to the ones already
    // there. Comparing against the file on disk (not against the previous
    // in-memory state) keeps every durability property: a missing, stale, or
    // torn file never matches and is rewritten as before.
    if std::fs::read(&path).is_ok_and(|current| current == json.as_bytes()) {
        return Ok(());
    }
    write_atomic_text(&path, &json)
}

pub(crate) fn load_ancestry(root: &Path) -> HashMap<String, Ancestry> {
    std::fs::read_to_string(ancestry_path(root))
        .ok()
        .and_then(|raw| serde_json::from_str::<DiskAncestry>(&raw).ok())
        .map(|disk| disk.files)
        .unwrap_or_default()
}

fn ancestry_from_object_map(object_map: HashMap<String, ObjectState>) -> HashMap<String, Ancestry> {
    object_map
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
        .collect()
}

pub fn demote(root: &Path) -> Result<(), String> {
    let path = state_path(root);
    let Some(disk) = read_disk_state(root) else {
        return Ok(());
    };
    let files = ancestry_from_object_map(disk.object_map);
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
mod tests;
