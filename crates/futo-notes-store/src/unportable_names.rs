//! Launch: rename notes whose file name the note-id rules refuse.
//!
//! macOS and Linux hold names with `:` `?` `*` and friends, but note ids forbid
//! them (Windows portability; sync skips such files), so one on disk would be
//! hidden from the list and fail `invalid note id` when opened (crash #1816).
//! Each is renamed to its sanitized name, never over an existing file.

use std::fs;

use futo_notes_core::files::{ensure_safe_note_id, sanitize_title, vault_fs, MAX_FOLDER_DEPTH};

use crate::{paths, FileChange, LocalNoteStore};

impl LocalNoteStore {
    /// Returns a warning per file that could not be renamed; such a file is
    /// left exactly as it was.
    pub(crate) fn heal_unportable_note_names(&self) -> Vec<String> {
        let mut warnings = Vec::new();
        self.heal_folder("", 0, &mut warnings);
        warnings
    }

    /// `folder` is a vault folder path with a trailing-slash-free name, `""` for
    /// the root. Folders whose own name no note id can hold are not entered:
    /// renaming a folder is a different operation, and their notes stay hidden.
    fn heal_folder(&self, folder: &str, depth: usize, warnings: &mut Vec<String>) {
        let prefix = if folder.is_empty() {
            String::new()
        } else {
            format!("{folder}/")
        };
        let dir = self.root.join(folder);
        let mut subfolders = Vec::new();
        let mut unportable = Vec::new();
        for entry in fs::read_dir(&dir).into_iter().flatten().flatten() {
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if name.starts_with('.') {
                continue;
            }
            if kind.is_dir() {
                let path = format!("{prefix}{name}");
                if depth < MAX_FOLDER_DEPTH && ensure_safe_note_id(&path).is_ok() {
                    subfolders.push(path);
                }
            } else if kind.is_file() && !name.contains('\\') {
                if let Some(stem) = name.strip_suffix(".md") {
                    if ensure_safe_note_id(stem).is_err() {
                        unportable.push((name.clone(), stem.to_owned()));
                    }
                }
            }
        }
        for (name, stem) in unportable {
            let healed = format!("{prefix}{}", sanitize_title(&stem));
            if let Err(error) = self.rename_unportable(&format!("{prefix}{name}"), &healed) {
                warnings.push(format!("{prefix}{name}: {error}"));
            }
        }
        for subfolder in subfolders {
            self.heal_folder(&subfolder, depth + 1, warnings);
        }
    }

    fn rename_unportable(&self, from: &str, wanted: &str) -> Result<(), String> {
        let id = paths::unique_note_id(&self.root, wanted, None)?;
        let to = format!("{id}.md");
        let change = FileChange::Renamed {
            from: from.to_owned(),
            to: to.clone(),
        };
        self.before_write
            .before_write(std::slice::from_ref(&change));
        if !vault_fs::move_no_replace(&self.root, from, &to)? {
            return Err("rename destination appeared concurrently".to_owned());
        }
        self.search.notify(&change);
        futo_notes_core::log_to_stderr!("renamed unportable note name {from:?} to {to:?}");
        Ok(())
    }
}
