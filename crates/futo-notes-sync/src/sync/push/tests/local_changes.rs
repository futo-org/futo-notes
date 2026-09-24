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

/// A name no portable filesystem can hold is never uploaded, and the skip is
/// journaled rather than reported (github#15 follow-up): the file stays on disk
/// untouched and simply takes no part in sync.
#[test]
fn an_unportable_name_is_never_uploaded_and_is_journaled_not_failed() {
    let root = TempRoot::new();
    std::fs::write(root.path().join("Recipe: braised short ribs.md"), "body").unwrap();
    std::fs::write(root.path().join("Plain note.md"), "body").unwrap();
    let files = local_files(root.path()).unwrap();
    assert_eq!(files.len(), 2, "the local scan still sees both files");
    let mut summary = SyncSummary::default();

    let uploadable = uploadable_files(files, &[], &mut summary);

    assert_eq!(
        uploadable
            .iter()
            .map(|f| f.name.as_str())
            .collect::<Vec<_>>(),
        vec!["Plain note.md"],
    );
    assert!(
        summary.failures.is_empty(),
        "an unportable name is not a failure — the user is never told",
    );
    let journaled = summary
        .decisions()
        .iter()
        .filter(|d| d.decision == decision::IGNORED)
        .map(|d| d.filename.as_str())
        .collect::<Vec<_>>();
    assert_eq!(journaled, vec!["Recipe: braised short ribs.md"]);
}

/// The tombstone guard. `missing_local_files` reads "in the object map, absent
/// from the local scan" as a local delete, so an unportable name MUST stay in
/// the scan — filtering it there instead of at the upload step would delete the
/// note from the server and every peer.
#[test]
fn an_unportable_name_is_not_mistaken_for_a_local_delete() {
    let root = TempRoot::new();
    std::fs::write(root.path().join("Trip: Lisbon.md"), "body").unwrap();
    let files = local_files(root.path()).unwrap();
    let mut state = connected();
    // It is already on the server: push has never validated names, so any vault
    // that synced before this change has one of these in its object map.
    state.object_map.insert(
        "Trip: Lisbon.md".into(),
        ObjectState {
            object_id: "already-uploaded".into(),
            version: 3,
            blob_key: "blob".into(),
            hash: Some(hash_sha256("body")),
            mtime_ms: None,
            size_bytes: Some(4),
        },
    );

    let missing = missing_local_files(&state, &files);

    assert!(
        missing.is_empty(),
        "the note is present on disk — treating it as deleted would tombstone \
         it on the server and every peer: {missing:?}",
    );
}

/// Linux and macOS allow `\` inside a filename. The scan once read it as a
/// folder separator, so `a\b.md` answered to `a/b.md`: a file that does not
/// exist, whose read failed the whole push, every cycle. It is scanned under
/// its own name now, and never uploaded, because Windows reads `\` as a folder.
#[cfg(unix)]
#[test]
fn a_backslash_filename_is_scanned_as_itself_and_never_uploaded() {
    let root = TempRoot::new();
    std::fs::write(root.path().join("a\\b.md"), "literal backslash").unwrap();
    std::fs::write(root.path().join("plain.md"), "body").unwrap();
    let files = local_files(root.path()).unwrap();
    let names: Vec<&str> = files.iter().map(|file| file.name.as_str()).collect();
    assert_eq!(names, ["a\\b.md", "plain.md"]);
    let mut state = connected();
    let mut summary = SyncSummary::default();

    let renames = detect_local_renames(&mut state, root.path(), &files, &[], &mut summary);
    let uploadable = uploadable_files(files, &[], &mut summary);

    assert!(renames.is_ok(), "{renames:?}");
    let uploaded: Vec<&str> = uploadable.iter().map(|file| file.name.as_str()).collect();
    assert_eq!(uploaded, ["plain.md"]);
    assert!(summary.failures.is_empty(), "{:?}", summary.failures);
}

/// A backslash filename never tombstones anything: neither the real `a/b.md`
/// beside it, nor a note a peer once synced under the name `a\b.md` itself,
/// which this device holds as that literal file.
#[cfg(unix)]
#[test]
fn a_backslash_filename_is_never_mistaken_for_a_local_delete() {
    let root = TempRoot::new();
    std::fs::create_dir(root.path().join("a")).unwrap();
    std::fs::write(root.path().join("a/b.md"), "real").unwrap();
    std::fs::write(root.path().join("a\\b.md"), "literal backslash").unwrap();
    let mut state = connected();
    for (name, body) in [("a/b.md", "real"), ("a\\b.md", "literal backslash")] {
        state.object_map.insert(
            name.into(),
            ObjectState {
                object_id: format!("object for {name}"),
                version: 1,
                blob_key: "blob".into(),
                hash: Some(hash_sha256(body)),
                mtime_ms: None,
                size_bytes: Some(body.len() as u64),
            },
        );
    }

    let missing = missing_local_files(&state, &local_files(root.path()).unwrap());

    assert!(missing.is_empty(), "both files are on disk: {missing:?}");
}

/// Linux filenames are bytes. A name that is not UTF-8 has no vault name at
/// all: the lossy one (`caf\u{FFFD}.md`) addresses no file, so reading it
/// failed the whole push, every cycle. It is left out of the scan, which can
/// never read as a delete: a synced name is a string, so it is always UTF-8.
#[cfg(target_os = "linux")]
#[test]
fn a_non_utf8_filename_is_not_scanned_and_does_not_fail_the_push() {
    use std::os::unix::ffi::OsStrExt;
    let root = TempRoot::new();
    let latin1 = std::ffi::OsStr::from_bytes(b"caf\xe9.md");
    std::fs::write(root.path().join(latin1), "latin-1").unwrap();
    std::fs::write(root.path().join("plain.md"), "body").unwrap();
    let files = local_files(root.path()).unwrap();
    let names: Vec<&str> = files.iter().map(|file| file.name.as_str()).collect();
    let mut state = connected();
    let mut summary = SyncSummary::default();

    let renames = detect_local_renames(&mut state, root.path(), &files, &[], &mut summary);

    assert!(renames.is_ok(), "{renames:?}");
    assert_eq!(names, ["plain.md"]);
    let unnamed = crate::sync::vault::local_scan(root.path()).unwrap().unnamed;
    assert_eq!(unnamed, ["caf\u{FFFD}.md"]);

    uploadable_files(files, &unnamed, &mut summary);

    let journaled = summary
        .decisions()
        .iter()
        .filter(|d| d.decision == decision::IGNORED && d.reason == reason::NAME_NOT_UTF8)
        .map(|d| d.filename.as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        journaled,
        ["caf\u{FFFD}.md"],
        "push journals what the scan skips"
    );
}
