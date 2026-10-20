//! Folder workflows: create, rename, move, and delete a folder.

use std::collections::HashSet;
use std::path::Path;

use futo_notes_core::files::{collides_but_differs, vault_fs, vault_mutation_guard};
use futo_notes_model::sanitize_folder_path;

use crate::relink::{move_files_with_rollback, prepare_relinks, rename_changes, same_physical};
use crate::{
    note_filename, paths, remove_empty_source_warning, vault, vault_name, FileChange,
    LocalNoteStore, MutationResult,
};

impl LocalNoteStore {
    pub fn create_folder(&self, raw: &str) -> Result<MutationResult, String> {
        let _gate = self.lock_gate()?;
        let clean = sanitize_folder_path(raw);
        if clean.is_empty() {
            return Ok(self.finish_mutation(Vec::new(), MutationResult::default()));
        }
        paths::folder_path(&self.root, &clean)?;
        vault_fs::create_dir_all(&self.root, &clean)?;
        Ok(self.finish_mutation(Vec::new(), MutationResult::default()))
    }

    pub fn rename_folder(&self, from: &str, to: &str) -> Result<MutationResult, String> {
        let _gate = self.lock_gate()?;
        paths::folder_path(&self.root, from)?;
        paths::folder_path(&self.root, to)?;
        let from = sanitize_folder_path(from);
        let to = sanitize_folder_path(to);
        self.relocate_folder(&from, &to)
    }

    pub fn move_folder(
        &self,
        from: &str,
        destination_parent: &str,
    ) -> Result<MutationResult, String> {
        let _gate = self.lock_gate()?;
        paths::folder_path(&self.root, from)?;
        let from = sanitize_folder_path(from);
        let destination_parent = if destination_parent.is_empty() {
            String::new()
        } else {
            paths::folder_path(&self.root, destination_parent)?;
            sanitize_folder_path(destination_parent)
        };
        if destination_parent == from || destination_parent.starts_with(&format!("{from}/")) {
            return Err("cannot move a folder into itself or a descendant".to_owned());
        }
        if !destination_parent.is_empty()
            && !paths::folder_path(&self.root, &destination_parent)?.is_dir()
        {
            return Err("destination folder does not exist".to_owned());
        }

        let leaf = from.rsplit('/').next().unwrap_or(&from);
        let wanted = if destination_parent.is_empty() {
            leaf.to_owned()
        } else {
            format!("{destination_parent}/{leaf}")
        };
        let to = paths::unique_folder_path(&self.root, &wanted, Some(&from))?;
        self.relocate_folder(&from, &to)
    }

    fn relocate_folder(&self, from: &str, to: &str) -> Result<MutationResult, String> {
        let _vault_mutation = vault_mutation_guard()?;
        let source = paths::folder_path(&self.root, &from)?;
        let destination = paths::folder_path(&self.root, &to)?;
        if !source.is_dir() {
            return Err("source folder does not exist".to_owned());
        }
        if source == destination {
            let mut mutation = self.finish_mutation(Vec::new(), MutationResult::default());
            mutation.final_folder = Some(from.to_owned());
            return Ok(mutation);
        }
        if destination.exists() && !same_physical(&source, &destination) {
            return Err("target folder already exists".to_owned());
        }

        for folder in vault::folders(&self.root)
            .into_iter()
            .filter(|folder| folder == from || folder.starts_with(&format!("{from}/")))
        {
            let rebased = if folder == from {
                to.to_owned()
            } else {
                format!("{to}/{}", &folder[from.len() + 1..])
            };
            paths::folder_path(&self.root, &rebased)?;
        }

        let prefix = format!("{from}/");
        let mappings = vault::note_paths(&self.root)
            .into_iter()
            .filter_map(|(id, _)| {
                id.strip_prefix(&prefix)
                    .map(|tail| (id.clone(), format!("{to}/{tail}")))
            })
            .collect::<Vec<_>>();
        let relinks = prepare_relinks(&self.root, &mappings);
        let mut changes = rename_changes(&mappings);
        changes.extend(
            relinks
                .rewritten
                .keys()
                .map(|id| FileChange::Changed(note_filename(id))),
        );
        self.before_write.before_write(&changes);

        if collides_but_differs(&from, &to) {
            vault_fs::rename_case(&self.root, from, to)?;
        } else {
            // This renames a DIRECTORY, so the file no-replace primitive
            // (move_no_replace) doesn't apply, and POSIX rename onto a non-empty dir
            // fails ENOTEMPTY (no clobber). The only residual of the
            // exists()-check above is an EMPTY destination dir created in this
            // user-initiated window being replaced — no note bytes are at risk
            // (contained notes move via the mapping loop, not this dir rename).
            // A platform-specific no-replace dir rename (renameat2) isn't worth
            // it for that (M17 #8, adjudicated).
            vault_fs::rename_local(&self.root, from, to)?;
        }
        let mut mutation = self.finish_mappings(mappings, relinks, None);
        mutation.final_folder = Some(to.to_owned());
        mutation
            .warnings
            .extend(remove_empty_source_warning(&source));
        Ok(mutation)
    }

    pub fn delete_folder(&self, folder: &str) -> Result<MutationResult, String> {
        self.delete_folder_with(folder, |path| {
            move_remaining_folder_files_up(&self.root, path)?;
            remove_empty_folder_tree(&self.root, path)
        })
    }

    /// Move every note out first, with rollback on a failed move. Only after
    /// all notes are safe does the supplied platform removal policy receive
    /// the remaining tree (desktop trash or native file-preserving move-up).
    pub fn delete_folder_with<F>(
        &self,
        folder: &str,
        remove_tree: F,
    ) -> Result<MutationResult, String>
    where
        F: FnOnce(&Path) -> Result<(), String>,
    {
        let _gate = self.lock_gate()?;
        let _vault_mutation = vault_mutation_guard()?;
        paths::folder_path(&self.root, folder)?;
        let folder = sanitize_folder_path(folder);
        let target = paths::folder_path(&self.root, &folder)?;
        if !target.exists() {
            return Ok(self.finish_mutation(Vec::new(), MutationResult::default()));
        }
        let parent = folder
            .rsplit_once('/')
            .map(|(parent, _)| parent)
            .unwrap_or("");
        let prefix = format!("{folder}/");
        let source_ids = vault::note_paths(&self.root)
            .into_iter()
            .map(|(id, _)| id)
            .filter(|id| id.starts_with(&prefix))
            .collect::<Vec<_>>();
        let mut occupied = vault::note_paths(&self.root)
            .into_iter()
            .map(|(id, _)| id)
            .filter(|id| !source_ids.contains(id))
            .collect::<HashSet<_>>();
        let mut mappings = Vec::with_capacity(source_ids.len());
        for old in source_ids {
            let tail = &old[prefix.len()..];
            let wanted = if parent.is_empty() {
                tail.to_owned()
            } else {
                format!("{parent}/{tail}")
            };
            let destination = paths::unique_against(&wanted, &occupied);
            occupied.insert(destination.clone());
            mappings.push((old, destination));
        }

        let relinks = prepare_relinks(&self.root, &mappings);
        let mut changes = rename_changes(&mappings);
        changes.extend(
            relinks
                .rewritten
                .keys()
                .map(|id| FileChange::Changed(note_filename(id))),
        );
        self.before_write.before_write(&changes);
        move_files_with_rollback(&self.root, &mappings)?;
        let cleanup_warning = remove_tree(&target)
            .err()
            .map(|error| format!("notes moved, but folder cleanup failed: {error}"));
        let mut mutation = self.finish_mappings(mappings, relinks, None);
        mutation.warnings.extend(cleanup_warning);
        Ok(mutation)
    }
}

/// Native folder deletion keeps attachments in the vault. Notes have already
/// moved through the normal collision/relink workflow; move every remaining
/// regular file to the same relative location under the parent. A collision
/// gets a numbered name and never replaces existing bytes. If an unusual
/// entry cannot move, leave the source tree in place for manual recovery.
fn move_remaining_folder_files_up(root: &Path, folder: &Path) -> Result<(), String> {
    let parent = folder.parent().ok_or("folder has no parent")?;
    let mut files = Vec::new();
    for entry in walkdir::WalkDir::new(folder) {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry.file_type().is_symlink() {
            return Err(format!(
                "folder contains a symlink: {}",
                entry.path().display()
            ));
        }
        if entry.file_type().is_file() {
            files.push(entry.path().to_owned());
        }
    }
    files.sort();
    for source in files {
        // A file no vault name can address (not UTF-8) cannot move; the error
        // leaves the folder in place for manual recovery.
        let source_relative = vault_name(root, &source)?;
        let tail = source
            .strip_prefix(folder)
            .map_err(|error| error.to_string())?;
        let wanted = parent.join(tail);
        let name = wanted
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("attachment has no filename")?;
        let (stem, extension) = match name.rsplit_once('.') {
            Some((stem, extension)) if !stem.is_empty() => (stem, format!(".{extension}")),
            _ => (name, String::new()),
        };
        for attempt in 1.. {
            let destination = if attempt == 1 {
                wanted.clone()
            } else {
                let suffix = format!("-{attempt}{extension}");
                let mut end = stem.len().min(255usize.saturating_sub(suffix.len()));
                while !stem.is_char_boundary(end) {
                    end -= 1;
                }
                wanted.with_file_name(format!("{}{suffix}", &stem[..end]))
            };
            let relative = vault_name(root, &destination)?;
            if vault_fs::exists(root, &relative)? {
                continue;
            }
            if vault_fs::move_no_replace(root, &source_relative, &relative)? {
                break;
            }
            if !vault_fs::exists(root, &source_relative)? {
                return Err(format!(
                    "attachment disappeared during folder deletion: {source_relative}"
                ));
            }
        }
    }
    Ok(())
}

fn remove_empty_folder_tree(root: &Path, folder: &Path) -> Result<(), String> {
    let mut directories = walkdir::WalkDir::new(folder)
        .into_iter()
        .map(|entry| {
            entry
                .map(|entry| entry.path().to_owned())
                .map_err(|error| error.to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    directories.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
    for directory in directories {
        vault_fs::remove_dir(root, &vault_name(root, &directory)?, false)?;
    }
    Ok(())
}
