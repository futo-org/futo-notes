use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::Path;

use super::parked_backup::{hidden_path, install_temp};
use super::paths::NAME_MAX;

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

    let result = match fs::hard_link(&temp, path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(error) => Err(format!(
            "{error} (hard-linking {} -> {})",
            temp.display(),
            path.display()
        )),
    };
    // The destination is an independent link to the completed inode on success.
    let _ = fs::remove_file(&temp);
    result
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
}
