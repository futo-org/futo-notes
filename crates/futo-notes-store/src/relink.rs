//! Identity changes: moving note files with rollback and rewriting the backlinks that point at them.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use futo_notes_core::files::{collides_but_differs, file_mtime_ms, vault_fs};
use futo_notes_model::{find_wikilinks, link_targets_naming, rewrite_wikilinks, split_id};

use crate::{note_filename, paths, vault, FileChange, LocalNoteStore, MutationResult, NoteRename};

impl LocalNoteStore {
    pub(crate) fn rename_raw(
        &self,
        old_id: &str,
        wanted_id: &str,
    ) -> Result<MutationResult, String> {
        if old_id == wanted_id {
            let upserted = vault::metadata(&self.root, old_id).into_iter().collect();
            return Ok(self.finish_mutation(
                upserted,
                MutationResult {
                    final_id: Some(old_id.to_owned()),
                    ..MutationResult::default()
                },
            ));
        }
        let source = paths::note_path(&self.root, old_id)?;
        if !source.is_file() {
            return Err("source note does not exist".to_owned());
        }
        let final_id = paths::unique_note_id(&self.root, wanted_id, Some(old_id))?;
        let mappings = vec![(old_id.to_owned(), final_id.clone())];
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
        // Folder moves also arrive here; only a title change counts as an edit.
        if split_id(old_id).1 != split_id(&final_id).1 {
            self.stamp_note(&final_id, None)?;
        }
        Ok(self.finish_mappings(mappings, relinks, Some(final_id)))
    }

    pub(crate) fn finish_mappings(
        &self,
        mappings: Vec<(String, String)>,
        relinks: Relinks,
        final_id: Option<String>,
    ) -> MutationResult {
        let mut warnings = relinks
            .skipped
            .iter()
            .map(|id| format!("backlink rewrite skipped for {id}: the note is not valid UTF-8"))
            .collect::<Vec<_>>();
        let mut touched = HashSet::new();
        let mut relinked = Vec::new();
        for (id, content) in relinks.rewritten {
            match paths::note_path(&self.root, &id).and_then(|_| {
                // Best effort: a failed restore must not drop a note whose bytes
                // already changed from the mutation every shell renders from.
                let relative = note_filename(&id);
                let preserved = fs::metadata(self.root.join(&relative))
                    .ok()
                    .as_ref()
                    .map(file_mtime_ms);
                vault_fs::write_atomic_local(&self.root, &relative, content.as_bytes())?;
                if let Some(previous) = preserved {
                    let _ = vault_fs::set_mtime_ms(&self.root, &relative, previous);
                }
                Ok(())
            }) {
                Ok(()) => {
                    touched.insert(id.clone());
                    self.search.notify(&FileChange::Changed(note_filename(&id)));
                    relinked.push(id);
                }
                Err(error) => warnings.push(format!("backlink rewrite for {id}: {error}")),
            }
        }
        relinked.sort();
        for (from, to) in &mappings {
            self.search.notify(&FileChange::Renamed {
                from: note_filename(from),
                to: note_filename(to),
            });
            touched.insert(to.clone());
        }
        let upserted = touched
            .into_iter()
            .filter_map(|id| vault::metadata(&self.root, &id))
            .collect::<Vec<_>>();
        self.finish_mutation(
            upserted,
            MutationResult {
                removed: mappings.iter().map(|(from, _)| from.clone()).collect(),
                renamed: mappings
                    .into_iter()
                    .map(|(from, to)| NoteRename { from, to })
                    .collect(),
                final_id,
                relinked,
                warnings,
                ..MutationResult::default()
            },
        )
    }
}

/// The backlink rewrite a rename plans before it moves anything.
#[derive(Default)]
pub(crate) struct Relinks {
    /// Rewritten bodies to write, keyed by the note's FINAL id.
    pub(crate) rewritten: HashMap<String, String>,
    /// Final ids of notes whose links matched but whose bytes are not UTF-8.
    /// They are left byte-for-byte untouched: re-encoding one would destroy
    /// every byte it could not decode, and writing the new link into a file of
    /// unknown encoding cannot promise the rest survives either.
    skipped: Vec<String>,
}

pub(crate) fn prepare_relinks(root: &Path, mappings: &[(String, String)]) -> Relinks {
    if mappings.is_empty() {
        return Relinks::default();
    }
    let raw = vault::bodies(root);
    // Every note counts toward link resolution, decodable or not.
    let mut ids = raw.keys().cloned().collect::<Vec<_>>();
    // An undecodable note gets a lossy view, used ONLY to learn whether the
    // rename would have rewritten it. It is never written.
    let notes = raw
        .into_iter()
        .map(|(id, bytes)| match String::from_utf8(bytes) {
            Ok(body) => (id, body, true),
            Err(error) => (
                id,
                String::from_utf8_lossy(error.as_bytes()).into_owned(),
                false,
            ),
        })
        .collect::<Vec<_>>();
    let mut bodies = notes
        .iter()
        .map(|(_, body, _)| body.clone())
        .collect::<Vec<_>>();

    // The mappings each link target could name.
    let mut naming = HashMap::<&str, Vec<usize>>::new();
    for (index, (old, _)) in mappings.iter().enumerate() {
        for target in link_targets_naming(old) {
            naming.entry(target).or_default().push(index);
        }
    }
    // Queue a note for each mapping from `first` on that one of its links could
    // name. A body is scanned once up front and again after each rewrite of it:
    // the mappings apply in order, and a later one may rewrite the new link.
    let queue = |queued: &mut [HashSet<usize>], note: usize, body: &str, first: usize| {
        for link in find_wikilinks(body) {
            for &index in naming.get(link.target.as_str()).into_iter().flatten() {
                if index >= first {
                    queued[index].insert(note);
                }
            }
        }
    };
    let mut queued = vec![HashSet::new(); mappings.len()];
    for (note, body) in bodies.iter().enumerate() {
        queue(&mut queued, note, body, 0);
    }
    // ponytail: each queued link still resolves against every id; index the ids
    // if moving most of a large vault at once gets slow.
    for (index, (old, new)) in mappings.iter().enumerate() {
        for note in std::mem::take(&mut queued[index]) {
            let (rewritten, count) = rewrite_wikilinks(&bodies[note], old, new, &ids);
            if count > 0 {
                queue(&mut queued, note, &rewritten, index + 1);
                bodies[note] = rewritten;
            }
        }
        if let Some(position) = ids.iter().position(|id| id == old) {
            ids[position] = new.clone();
        }
    }

    let final_ids = mappings.iter().cloned().collect::<HashMap<_, _>>();
    let mut relinks = Relinks::default();
    for ((old_id, original, decodable), body) in notes.into_iter().zip(bodies) {
        if body == original {
            continue;
        }
        let id = final_ids.get(&old_id).cloned().unwrap_or(old_id);
        if decodable {
            relinks.rewritten.insert(id, body);
        } else {
            relinks.skipped.push(id);
        }
    }
    relinks.skipped.sort();
    relinks
}

pub(crate) fn rename_changes(mappings: &[(String, String)]) -> Vec<FileChange> {
    mappings
        .iter()
        .map(|(from, to)| FileChange::Renamed {
            from: note_filename(from),
            to: note_filename(to),
        })
        .collect()
}

pub(crate) fn move_files_with_rollback(
    root: &Path,
    mappings: &[(String, String)],
) -> Result<(), String> {
    let mut completed: Vec<(String, String)> = Vec::new();
    for (from, to) in mappings {
        paths::note_path(root, from)?;
        let destination = paths::note_path(root, to)?;
        let result = if collides_but_differs(from, to) {
            vault_fs::rename_case(root, &note_filename(from), &note_filename(to))
        } else {
            // No-replace move. The destination id was allocated unique, so a
            // file there now is a writer outside this store's serialization —
            // never clobber it (the A1 window applied to rename). `move_no_replace`
            // is the portable atomic no-replace install (Ok(false) if taken),
            // carries mtime across, and consumes the source to complete the move;
            // on a collision the caller rolls back — the newcomer and the source
            // both survive.
            match vault_fs::move_no_replace(root, &note_filename(from), &note_filename(to)) {
                Ok(true) => Ok(()),
                Ok(false) => Err(format!(
                    "rename destination {} appeared under a concurrent writer",
                    destination.display()
                )),
                Err(error) => Err(error),
            }
        };
        if let Err(error) = result {
            for (original, moved) in completed.into_iter().rev() {
                let _ = vault_fs::move_no_replace(
                    root,
                    &note_filename(&moved),
                    &note_filename(&original),
                );
            }
            return Err(error);
        }
        completed.push((from.clone(), to.clone()));
    }
    for (source, _) in &completed {
        prune_empty_parents(root, &root.join(note_filename(source)));
    }
    Ok(())
}

pub(crate) fn prune_empty_parents(root: &Path, note_path: &Path) {
    let Some(mut directory) = note_path.parent().map(Path::to_owned) else {
        return;
    };
    while directory != root && directory.starts_with(root) {
        let empty = fs::read_dir(&directory)
            .ok()
            .and_then(|mut entries| entries.next())
            .is_none();
        let removed = empty
            && vault_fs::relative_name(root, &directory)
                .is_some_and(|relative| vault_fs::remove_dir(root, &relative, false).is_ok());
        if !removed {
            return;
        }
        let Some(parent) = directory.parent() else {
            return;
        };
        directory = parent.to_owned();
    }
}

pub(crate) fn same_physical(left: &Path, right: &Path) -> bool {
    fs::canonicalize(left)
        .ok()
        .zip(fs::canonicalize(right).ok())
        .map(|(left, right)| left == right)
        .unwrap_or(false)
}
