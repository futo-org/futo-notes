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
        pending_creates: HashMap::new(),
        max_version: 10,
        pull_cursor: 8,
        oversize_skip: HashMap::new(),
    }
}

fn file_identity(path: &Path) -> (std::time::SystemTime, u64) {
    let meta = std::fs::metadata(path).unwrap();
    (meta.modified().unwrap(), meta.len())
}

// Every push and every pull ends in a save, so an idle cycle used to rewrite
// a ~1 MB file twice to land bytes already on disk. A save whose bytes match
// the file leaves it untouched; anything else — a changed state, a missing
// file, a stale or torn file — is written exactly as before.
#[test]
fn save_leaves_an_identical_checkpoint_untouched_and_rewrites_any_difference() {
    let root = TempRoot::new();
    let path = state_path(root.path());
    let current = state("collection-a");
    save(root.path(), &current).unwrap();
    let written = file_identity(&path);
    let bytes = std::fs::read(&path).unwrap();

    std::thread::sleep(std::time::Duration::from_millis(20));
    save(root.path(), &current).unwrap();
    assert_eq!(
        file_identity(&path),
        written,
        "an identical save must not rewrite the checkpoint"
    );

    let mut advanced = current.clone();
    advanced.pull_cursor += 1;
    save(root.path(), &advanced).unwrap();
    assert_ne!(
        std::fs::read(&path).unwrap(),
        bytes,
        "a changed state is written"
    );
    assert_eq!(load(root.path(), "collection-a").pull_cursor, 9);

    std::fs::write(&path, b"{ torn").unwrap();
    save(root.path(), &advanced).unwrap();
    assert_eq!(
        load(root.path(), "collection-a").pull_cursor,
        9,
        "a torn file is repaired"
    );

    std::fs::remove_file(&path).unwrap();
    save(root.path(), &advanced).unwrap();
    assert!(path.exists(), "a missing checkpoint is recreated");
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
fn pending_create_identity_round_trips_and_counts_as_collection_state() {
    let root = TempRoot::new();
    let mut connected = state("col-1");
    connected.object_map.clear();
    connected.max_version = 0;
    connected.pull_cursor = 0;
    connected.pending_creates.insert(
        "new.md".into(),
        PendingCreate {
            mutation_id: "01890000-0000-7000-8000-00000000c001".into(),
            original_name: "new.md".into(),
            hash: "original-hash".into(),
            size_bytes: 12,
        },
    );
    save(root.path(), &connected).unwrap();

    let loaded = load(root.path(), "col-1");
    assert_eq!(
        loaded.pending_creates["new.md"].mutation_id,
        "01890000-0000-7000-8000-00000000c001"
    );

    let reset = load(root.path(), "col-2");
    assert!(reset.pending_creates.is_empty());
    assert!(!state_path(root.path()).exists());
    assert!(load_ancestry(root.path()).is_empty());
}

#[test]
fn pending_create_accepts_the_previous_object_id_field_name() {
    let pending: PendingCreate = serde_json::from_str(
        r#"{
                "objectId":"01890000-0000-7000-8000-00000000c003",
                "originalName":"new.md",
                "hash":"hash",
                "sizeBytes":4
            }"#,
    )
    .unwrap();
    assert_eq!(pending.mutation_id, "01890000-0000-7000-8000-00000000c003");
}

#[test]
fn older_checkpoint_without_pending_creates_loads_an_empty_pending_map() {
    let root = TempRoot::new();
    std::fs::write(
        state_path(root.path()),
        r#"{"version":1,"object_map":{},"max_version":0,"pull_cursor":0,"collection_id":"col-1"}"#,
    )
    .unwrap();

    let loaded = load(root.path(), "col-1");
    assert!(loaded.pending_creates.is_empty());
}

#[test]
fn older_client_shape_ignores_the_additive_pending_create_field() {
    #[derive(Deserialize)]
    struct LegacyShape {
        object_map: HashMap<String, ObjectState>,
        max_version: u64,
    }

    let root = TempRoot::new();
    let mut connected = state("col-1");
    connected.pending_creates.insert(
        "new.md".into(),
        PendingCreate {
            mutation_id: "01890000-0000-7000-8000-00000000c002".into(),
            original_name: "new.md".into(),
            hash: "hash".into(),
            size_bytes: 4,
        },
    );
    save(root.path(), &connected).unwrap();
    let raw = std::fs::read_to_string(state_path(root.path())).unwrap();

    let legacy: LegacyShape = serde_json::from_str(&raw).unwrap();
    assert_eq!(legacy.max_version, 10);
    assert_eq!(legacy.object_map["note.md"].object_id, "o1");
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
