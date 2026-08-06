use super::*;
use crate::checkpoint::PendingCreate;
use crate::sync::SyncSummary;

#[test]
fn rename_detection_does_not_claim_a_pending_create_file() {
    let root = TempRoot::new();
    std::fs::create_dir(root.path().join("dir-b")).unwrap();
    std::fs::write(root.path().join("dir-b/note.md"), "same bytes").unwrap();
    let files = local_files(root.path()).unwrap();
    let mut state = connected();
    state.pending_creates.insert(
        "dir-b/note.md".into(),
        PendingCreate {
            mutation_id: "01890000-0000-7000-8000-00000000e009".into(),
            original_name: "dir-b/note.md".into(),
            hash: hash_sha256("same bytes"),
            size_bytes: 10,
        },
    );
    let missing: Vec<(String, ObjectState)> = vec![(
        "dir-a/note.md".into(),
        ObjectState {
            object_id: "older-object".into(),
            version: 1,
            blob_key: "older-blob".into(),
            hash: Some(hash_sha256("same bytes")),
            mtime_ms: None,
            size_bytes: Some(10),
        },
    )];
    state
        .object_map
        .insert(missing[0].0.clone(), missing[0].1.clone());
    let mut summary = SyncSummary::default();

    let (claimed, renamed) =
        detect_local_renames(&mut state, root.path(), &files, &missing, &mut summary).unwrap();

    assert!(claimed.is_empty());
    assert!(renamed.is_empty());
    assert!(summary.renamed.is_empty());
    assert_eq!(state.object_map["dir-a/note.md"].object_id, "older-object");
    assert!(!state.object_map.contains_key("dir-b/note.md"));
}
