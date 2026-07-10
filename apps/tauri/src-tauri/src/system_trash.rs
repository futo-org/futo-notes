//! Recoverable deletion through the desktop operating system's trash.

use std::path::Path;

pub(crate) fn delete(path: &Path, label: &str) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }

    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
    if let Err(error) = trash::delete(path) {
        eprintln!("[{label}] trash::delete failed: {error}; falling back to hard delete");
        hard_delete(path)?;
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    hard_delete(path)?;

    Ok(())
}

fn hard_delete(path: &Path) -> Result<(), String> {
    if path.is_dir() {
        std::fs::remove_dir_all(path).map_err(crate::background_tasks::io_error)
    } else {
        std::fs::remove_file(path).map_err(crate::background_tasks::io_error)
    }
}

#[cfg(test)]
mod tests {
    //! Tests for operating-system trash fallback behavior.
    use super::*;

    #[test]
    fn hard_delete_handles_files_and_directories() {
        let root = std::env::temp_dir().join(format!(
            "futo-tauri-trash-{}-{}",
            std::process::id(),
            futo_notes_core::files::now_ms()
        ));
        std::fs::create_dir_all(root.join("folder")).unwrap();
        std::fs::write(root.join("note.md"), "body").unwrap();
        hard_delete(&root.join("note.md")).unwrap();
        hard_delete(&root.join("folder")).unwrap();
        assert!(!root.join("note.md").exists());
        assert!(!root.join("folder").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}
