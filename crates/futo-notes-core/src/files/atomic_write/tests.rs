use super::*;
use crate::files::{safe_note_path, sanitize_title, MAX_TITLE_LENGTH};

#[test]
fn atomic_text_write_replaces_content_without_temp_litter() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let path = root.join(format!("{}.md", "a".repeat(MAX_TITLE_LENGTH)));
    write_atomic_text(&path, "first").unwrap();
    write_atomic_text(&path, "second\n😀").unwrap();
    assert_eq!(fs::read_to_string(path).unwrap(), "second\n😀");
    assert!(fs::read_dir(root).unwrap().flatten().all(|entry| {
        let name = entry.file_name().to_string_lossy().into_owned();
        !name.starts_with(".sf-tmp-") && !name.starts_with(".sf-bak-")
    }));
}

#[test]
fn temp_hop_changes_the_directory_entry_without_losing_bytes() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let source = root.join("note.md");
    let destination = root.join("Note.md");
    fs::write(&source, "body").unwrap();
    rename_through_temp(&source, &destination).unwrap();
    assert_eq!(fs::read_to_string(destination).unwrap(), "body");
    assert_eq!(
        fs::read_dir(root)
            .unwrap()
            .flatten()
            .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "md"))
            .count(),
        1
    );
}

#[test]
fn write_atomic_text_accepts_the_maximum_title_length() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let title = "a".repeat(MAX_TITLE_LENGTH);
    let path = safe_note_path(root, &sanitize_title(&title)).unwrap();
    write_atomic_text(&path, "content").unwrap();
    assert_eq!(fs::read_to_string(path).unwrap(), "content");
}

// ============================================================
// No-replace install (create_new_atomic + move_no_replace)
// ============================================================

#[test]
fn create_new_atomic_writes_a_fresh_note_and_leaves_no_temp() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let path = root.join("fresh.md");
    assert_eq!(create_new_atomic(&path, b"body").unwrap(), true);
    assert_eq!(fs::read(&path).unwrap(), b"body");
    assert!(fs::read_dir(root)
        .unwrap()
        .flatten()
        .all(|entry| { !entry.file_name().to_string_lossy().starts_with(".sf-tmp-") }));
}

#[test]
fn create_new_atomic_refuses_to_replace_an_existing_note() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let path = root.join("existing.md");
    fs::write(&path, "original").unwrap();
    assert_eq!(create_new_atomic(&path, b"newcomer").unwrap(), false);
    assert_eq!(fs::read_to_string(&path).unwrap(), "original");
}

#[test]
fn move_no_replace_installs_and_consumes_the_source() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let source = root.join(".sf-tmp-source");
    let destination = root.join("note.md");
    fs::write(&source, "carried bytes").unwrap();
    assert_eq!(move_no_replace(&source, &destination).unwrap(), true);
    assert_eq!(fs::read_to_string(&destination).unwrap(), "carried bytes");
    assert!(!source.exists(), "source is consumed by the move");
}

#[test]
fn move_no_replace_reports_a_taken_destination_without_touching_either() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let source = root.join(".sf-tmp-source");
    let destination = root.join("note.md");
    fs::write(&source, "incoming").unwrap();
    fs::write(&destination, "incumbent").unwrap();
    assert_eq!(move_no_replace(&source, &destination).unwrap(), false);
    assert_eq!(fs::read_to_string(&destination).unwrap(), "incumbent");
    assert_eq!(
        fs::read_to_string(&source).unwrap(),
        "incoming",
        "the source survives a no-replace collision so the caller can decide"
    );
}

// Exercises the fallback used on filesystems that reject hard links (Android
// FUSE storage). The host filesystem supports links, so `move_no_replace`
// would take the link path — call the fallback directly to lock its contract.
#[test]
#[cfg(any(target_os = "linux", target_os = "android", target_vendor = "apple"))]
fn rename_fallback_installs_when_links_are_unavailable() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let source = root.join(".sf-tmp-source");
    let destination = root.join("note.md");
    fs::write(&source, "linkless bytes").unwrap();
    assert_eq!(
        move_no_replace_via_rename(&source, &destination).unwrap(),
        true
    );
    assert_eq!(fs::read_to_string(&destination).unwrap(), "linkless bytes");
    assert!(!source.exists(), "the rename consumes the source");
}

#[test]
#[cfg(any(target_os = "linux", target_os = "android", target_vendor = "apple"))]
fn rename_fallback_refuses_to_replace_and_keeps_the_source() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let source = root.join(".sf-tmp-source");
    let destination = root.join("note.md");
    fs::write(&source, "incoming").unwrap();
    fs::write(&destination, "incumbent").unwrap();
    assert_eq!(
        move_no_replace_via_rename(&source, &destination).unwrap(),
        false
    );
    assert_eq!(fs::read_to_string(&destination).unwrap(), "incumbent");
    assert_eq!(fs::read_to_string(&source).unwrap(), "incoming");
}

// ============================================================
// Filesystems that reject BOTH hard links and rename flags
// (Android 9/10 sdcardfs — github#13)
// ============================================================

/// Android 9/10 mount shared storage as sdcardfs, which rejects `link` with
/// EPERM and answers a flagged `renameat2` with EINVAL. Forces both legs to
/// fail the way that filesystem does, on a host that supports both.
#[cfg(any(target_os = "linux", target_os = "android", target_vendor = "apple"))]
fn with_sdcardfs_rejections<T>(body: impl FnOnce() -> T) -> T {
    MOVE_NO_REPLACE_BEFORE_RENAME.with(|hook| *hook.borrow_mut() = Some(Box::new(|| {})));
    RENAME_FLAGS_REJECTED.with(|rejected| rejected.set(true));
    let result = body();
    RENAME_FLAGS_REJECTED.with(|rejected| rejected.set(false));
    MOVE_NO_REPLACE_BEFORE_RENAME.with(|hook| *hook.borrow_mut() = None);
    result
}

#[test]
#[cfg(any(target_os = "linux", target_os = "android", target_vendor = "apple"))]
fn create_new_atomic_installs_a_note_when_links_and_rename_flags_are_both_rejected() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let path = root.join("Untitled.md");

    let created = with_sdcardfs_rejections(|| create_new_atomic(&path, b"body"));

    let content = fs::read(&path).ok();
    let litter = fs::read_dir(root)
        .unwrap()
        .flatten()
        .any(|entry| entry.file_name().to_string_lossy().starts_with(".sf-tmp-"));

    assert_eq!(
        (created, content.as_deref(), litter),
        (Ok(true), Some(b"body".as_slice()), false),
        "a vault on a link-less, flag-less filesystem must still create notes"
    );
}

#[test]
#[cfg(any(target_os = "linux", target_os = "android", target_vendor = "apple"))]
fn flagless_install_refuses_to_replace_and_keeps_the_source() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let source = root.join(".sf-tmp-source");
    let destination = root.join("note.md");
    fs::write(&source, "incoming").unwrap();
    fs::write(&destination, "incumbent").unwrap();

    let moved = with_sdcardfs_rejections(|| move_no_replace(&source, &destination));

    let destination_content = fs::read_to_string(&destination).unwrap();
    let source_content = fs::read_to_string(&source).ok();

    assert_eq!(
        (
            moved,
            destination_content.as_str(),
            source_content.as_deref()
        ),
        (Ok(false), "incumbent", Some("incoming")),
        "losing atomicity must not cost the no-clobber guarantee"
    );
}

#[test]
#[cfg(any(target_os = "linux", target_os = "android", target_vendor = "apple"))]
fn flagless_install_carries_the_source_mtime_like_the_other_legs() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let source = root.join(".sf-tmp-source");
    let destination = root.join("recovered.md");
    fs::write(&source, "parked bytes").unwrap();
    let parked_at = 1_600_000_000_000;
    set_file_mtime_ms(&source, parked_at).unwrap();

    let moved = with_sdcardfs_rejections(|| move_no_replace(&source, &destination));

    let installed_at = fs::metadata(&destination)
        .map(|meta| file_mtime_ms(&meta))
        .unwrap();

    assert_eq!(
        (moved, installed_at),
        (Ok(true), parked_at),
        "a recovered note must keep its modification time, not jump the list"
    );
}

#[test]
#[cfg(any(target_os = "linux", target_os = "android", target_vendor = "apple"))]
fn rename_fallback_preserves_a_destination_created_in_the_install_window() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let source = root.join(".sf-tmp-source");
    let destination = root.join("note.md");
    fs::write(&source, "incoming").unwrap();

    let writer_destination = destination.clone();
    MOVE_NO_REPLACE_BEFORE_RENAME.with(|hook| {
        *hook.borrow_mut() = Some(Box::new(move || {
            write_atomic_text(&writer_destination, "concurrent writer").unwrap();
        }));
    });

    let moved = move_no_replace(&source, &destination).unwrap();
    let destination_content = fs::read_to_string(&destination).unwrap();
    let source_content = fs::read_to_string(&source).ok();

    assert_eq!(
        (
            moved,
            destination_content.as_str(),
            source_content.as_deref()
        ),
        (false, "concurrent writer", Some("incoming")),
        "the competing writer must win without consuming the source"
    );
}
