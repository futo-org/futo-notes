use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::Path;

#[cfg(test)]
use std::cell::RefCell;

use super::parked_backup::{hidden_path, install_temp};
use super::paths::NAME_MAX;

#[cfg(test)]
thread_local! {
    static MOVE_NO_REPLACE_BEFORE_RENAME: RefCell<Option<Box<dyn FnOnce()>>> = RefCell::new(None);
}

fn create_temp(parent: &Path) -> Result<(std::path::PathBuf, File), String> {
    for _ in 0..32 {
        let path = hidden_path(parent, "tmp");
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((path, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("{error} (creating temp {})", path.display())),
        }
    }
    Err("could not allocate an atomic-write temp file".to_owned())
}

pub fn write_atomic_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "invalid file path".to_owned())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "invalid file name".to_owned())?;
    if name.len() > NAME_MAX {
        return Err("file name exceeds filesystem name limit".to_owned());
    }

    let (temp, mut file) = create_temp(parent)?;
    let write_result = file
        .write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("{error} (writing temp {})", temp.display()));
    drop(file);
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }

    if let Err(error) = install_temp(&temp, path) {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    // Directory fsync makes the rename durable on platforms that support directory handles.
    let _ = File::open(parent).and_then(|directory| directory.sync_all());
    Ok(())
}

pub fn write_atomic_text(path: &Path, content: &str) -> Result<(), String> {
    write_atomic_bytes(path, content.as_bytes())
}

pub fn create_new_atomic(path: &Path, bytes: &[u8]) -> Result<bool, String> {
    let parent = path
        .parent()
        .ok_or_else(|| "invalid file path".to_owned())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "invalid file name".to_owned())?;
    if name.len() > NAME_MAX {
        return Err("file name exceeds filesystem name limit".to_owned());
    }

    let (temp, mut file) = create_temp(parent)?;
    let write_result = file
        .write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("{error} (writing temp {})", temp.display()));
    drop(file);
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }

    let result = move_no_replace(&temp, path);
    // On a created (true) result the temp was consumed by the install; on a
    // collision (false) or error it may remain, so always sweep it.
    let _ = fs::remove_file(&temp);
    result
}

/// Installs `source`'s content at `destination` without replacing an existing
/// file there, then removes `source` — an atomic no-replace move. Returns
/// `Ok(true)` when `destination` was created, `Ok(false)` when a file already
/// existed there (in which case neither path is modified). On error, best
/// effort leaves no duplicate: `destination` is never left as an extra copy of
/// a `source` that still exists.
///
/// `hard_link` is the fast atomic no-replace install on filesystems that
/// support it (the destination cannot clobber an existing name, and the shared
/// inode carries mtime across). Some filesystems — notably Android's
/// FUSE-backed external storage — reject `link` outright, so fall back to
/// an atomic no-replace rename where the platform provides one.
pub fn move_no_replace(source: &Path, destination: &Path) -> Result<bool, String> {
    #[cfg(test)]
    if MOVE_NO_REPLACE_BEFORE_RENAME.with(|hook| hook.borrow().is_some()) {
        // Host filesystems support links; the hook simulates Android FUSE rejecting one.
        return move_no_replace_via_rename(source, destination);
    }

    match fs::hard_link(source, destination) {
        Ok(()) => drop_source_after_link(source, destination),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(error) => move_no_replace_after_link_error(source, destination, error),
    }
}

fn drop_source_after_link(source: &Path, destination: &Path) -> Result<bool, String> {
    match fs::remove_file(source) {
        Ok(()) => Ok(true),
        Err(error) => {
            // The link exists but the source could not be dropped; undo the link
            // so the error path never strands a duplicate under both names.
            let _ = fs::remove_file(destination);
            Err(format!(
                "{error} (dropping {} after linking {})",
                source.display(),
                destination.display()
            ))
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "android", target_vendor = "apple"))]
fn move_no_replace_after_link_error(
    source: &Path,
    destination: &Path,
    _link_error: std::io::Error,
) -> Result<bool, String> {
    move_no_replace_via_rename(source, destination)
}

#[cfg(not(any(target_os = "linux", target_os = "android", target_vendor = "apple")))]
fn move_no_replace_after_link_error(
    source: &Path,
    destination: &Path,
    link_error: std::io::Error,
) -> Result<bool, String> {
    Err(format!(
        "{link_error} (hard-linking {} -> {}; atomic no-replace rename unavailable on this platform)",
        source.display(),
        destination.display()
    ))
}

#[cfg(any(target_os = "linux", target_os = "android", target_vendor = "apple"))]
fn move_no_replace_via_rename(source: &Path, destination: &Path) -> Result<bool, String> {
    #[cfg(test)]
    MOVE_NO_REPLACE_BEFORE_RENAME.with(|hook| {
        if let Some(before_rename) = hook.borrow_mut().take() {
            before_rename();
        }
    });

    match rustix::fs::renameat_with(
        rustix::fs::CWD,
        source,
        rustix::fs::CWD,
        destination,
        rustix::fs::RenameFlags::NOREPLACE,
    ) {
        Ok(()) => Ok(true),
        Err(rustix::io::Errno::EXIST) => Ok(false),
        Err(error) => Err(format!(
            "{error} (no-replace renaming {} -> {})",
            source.display(),
            destination.display()
        )),
    }
}

pub fn rename_through_temp(source: &Path, destination: &Path) -> Result<(), String> {
    let parent = source
        .parent()
        .ok_or_else(|| "invalid source path".to_owned())?;
    if let Some(destination_parent) = destination.parent() {
        fs::create_dir_all(destination_parent).map_err(|error| error.to_string())?;
    }
    let temp = hidden_path(parent, "tmp");
    fs::rename(source, &temp).map_err(|error| {
        format!(
            "{error} (renaming {} -> temp {})",
            source.display(),
            temp.display()
        )
    })?;
    if let Err(error) = fs::rename(&temp, destination) {
        let _ = fs::rename(&temp, source);
        return Err(format!(
            "{error} (renaming temp {} -> {})",
            temp.display(),
            destination.display()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files::{safe_note_path, sanitize_title, MAX_TITLE_LENGTH};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn temp_dir() -> PathBuf {
        static SEQUENCE: AtomicU32 = AtomicU32::new(0);
        let path = std::env::temp_dir().join(format!(
            "futo-notes-atomic-write-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn atomic_text_write_replaces_content_without_temp_litter() {
        let root = temp_dir();
        let path = root.join(format!("{}.md", "a".repeat(MAX_TITLE_LENGTH)));
        write_atomic_text(&path, "first").unwrap();
        write_atomic_text(&path, "second\n😀").unwrap();
        assert_eq!(fs::read_to_string(path).unwrap(), "second\n😀");
        assert!(fs::read_dir(&root).unwrap().flatten().all(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            !name.starts_with(".sf-tmp-") && !name.starts_with(".sf-bak-")
        }));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn temp_hop_changes_the_directory_entry_without_losing_bytes() {
        let root = temp_dir();
        let source = root.join("note.md");
        let destination = root.join("Note.md");
        fs::write(&source, "body").unwrap();
        rename_through_temp(&source, &destination).unwrap();
        assert_eq!(fs::read_to_string(destination).unwrap(), "body");
        assert_eq!(
            fs::read_dir(&root)
                .unwrap()
                .flatten()
                .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "md"))
                .count(),
            1
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn write_atomic_text_accepts_the_maximum_title_length() {
        let root = temp_dir();
        let title = "a".repeat(MAX_TITLE_LENGTH);
        let path = safe_note_path(&root, &sanitize_title(&title)).unwrap();
        write_atomic_text(&path, "content").unwrap();
        assert_eq!(fs::read_to_string(path).unwrap(), "content");
        fs::remove_dir_all(root).unwrap();
    }

    // ============================================================
    // No-replace install (create_new_atomic + move_no_replace)
    // ============================================================

    #[test]
    fn create_new_atomic_writes_a_fresh_note_and_leaves_no_temp() {
        let root = temp_dir();
        let path = root.join("fresh.md");
        assert_eq!(create_new_atomic(&path, b"body").unwrap(), true);
        assert_eq!(fs::read(&path).unwrap(), b"body");
        assert!(fs::read_dir(&root)
            .unwrap()
            .flatten()
            .all(|entry| { !entry.file_name().to_string_lossy().starts_with(".sf-tmp-") }));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn create_new_atomic_refuses_to_replace_an_existing_note() {
        let root = temp_dir();
        let path = root.join("existing.md");
        fs::write(&path, "original").unwrap();
        assert_eq!(create_new_atomic(&path, b"newcomer").unwrap(), false);
        assert_eq!(fs::read_to_string(&path).unwrap(), "original");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn move_no_replace_installs_and_consumes_the_source() {
        let root = temp_dir();
        let source = root.join(".sf-tmp-source");
        let destination = root.join("note.md");
        fs::write(&source, "carried bytes").unwrap();
        assert_eq!(move_no_replace(&source, &destination).unwrap(), true);
        assert_eq!(fs::read_to_string(&destination).unwrap(), "carried bytes");
        assert!(!source.exists(), "source is consumed by the move");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn move_no_replace_reports_a_taken_destination_without_touching_either() {
        let root = temp_dir();
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
        fs::remove_dir_all(root).unwrap();
    }

    // Exercises the fallback used on filesystems that reject hard links (Android
    // FUSE storage). The host filesystem supports links, so `move_no_replace`
    // would take the link path — call the fallback directly to lock its contract.
    #[test]
    fn rename_fallback_installs_when_links_are_unavailable() {
        let root = temp_dir();
        let source = root.join(".sf-tmp-source");
        let destination = root.join("note.md");
        fs::write(&source, "linkless bytes").unwrap();
        assert_eq!(
            move_no_replace_via_rename(&source, &destination).unwrap(),
            true
        );
        assert_eq!(fs::read_to_string(&destination).unwrap(), "linkless bytes");
        assert!(!source.exists(), "the rename consumes the source");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rename_fallback_refuses_to_replace_and_keeps_the_source() {
        let root = temp_dir();
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
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rename_fallback_preserves_a_destination_created_in_the_install_window() {
        let root = temp_dir();
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
        fs::remove_dir_all(root).unwrap();

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
}
