//! The editor save verbs: `save` and `flush_draft`, with its recreate and conflict-park arms.

use std::collections::HashSet;

use futo_notes_core::conflict_names::{conflict_filename, current_conflict_date};
use futo_notes_core::files::{vault_fs, vault_mutation_guard};
use futo_notes_model::{make_id, split_id};

use crate::{
    io_error, join_id, note_filename, note_title, paths, vault, FileChange, FlushDisposition,
    FlushDraftResult, LocalNoteStore, MutationResult,
};

impl LocalNoteStore {
    /// One shell call for editor save: the current body is committed at the
    /// old ID first, then any rename and every resolvable backlink rewrite are
    /// performed under the same vault lock.
    pub fn save(
        &self,
        original_id: Option<&str>,
        wanted_id: &str,
        content: &str,
        modified_ms: Option<i64>,
    ) -> Result<MutationResult, String> {
        let _gate = self.lock_gate()?;
        match original_id {
            None => {
                let _vault_mutation = vault_mutation_guard()?;
                let (folder, title) = split_id(wanted_id);
                let metadata = self.install_new(&make_id(&folder, &title), content, modified_ms)?;
                Ok(self.upsert_mutation(metadata))
            }
            Some(original) if original == wanted_id => {
                let _vault_mutation = vault_mutation_guard()?;
                let metadata = self.write_raw(original, content, modified_ms)?;
                Ok(self.upsert_mutation(metadata))
            }
            Some(original) => {
                let _vault_mutation = vault_mutation_guard()?;
                self.write_raw(original, content, modified_ms)?;
                self.rename_raw(original, wanted_id)
            }
        }
    }

    /// THE draft-saving verb (persist-or-park, ADR-0001 / issue #37): persist
    /// `content` for the note at `id`, resolving every surprise itself, and
    /// return one [`FlushDisposition`] plus the mutation to project. `base` is
    /// the content the editor last loaded or saved — what detects that the
    /// note changed underneath the draft.
    ///
    /// The whole composition holds the store gate once, so no check-then-act
    /// window spans app-facing calls (the P1a TOCTOU that lived between the raw
    /// `write_if_unchanged`/`create_if_absent`/park FFI calls). Its existing-note
    /// check/write span also holds the process-wide vault mutation guard shared
    /// with sync. The missing-note arm reacquires that guard around its complete
    /// collision-check/install span, and every install remains no-replace.
    pub fn flush_draft(
        &self,
        id: &str,
        base: &str,
        content: &str,
    ) -> Result<FlushDraftResult, String> {
        let _gate = self.lock_gate()?;
        paths::note_path(&self.root, id)?;
        let vault_mutation = vault_mutation_guard()?;
        let current = self.read_note_file(id);
        #[cfg(test)]
        if current.is_ok() {
            if let Some(hook) = self.flush_window_hook.lock().unwrap().as_ref() {
                hook(id);
            }
        }
        match current {
            // Converged is checked BEFORE the base comparison so a draft the
            // disk already holds never rewrites identical bytes (an mtime bump
            // would re-rank the note on every device).
            Ok(current) if current == content => Ok(FlushDraftResult {
                disposition: FlushDisposition::Converged,
                mutation: None,
            }),
            Ok(current) if current == base => {
                let metadata = self.write_raw(id, content, None)?;
                Ok(FlushDraftResult {
                    disposition: FlushDisposition::Wrote,
                    mutation: Some(self.upsert_mutation(metadata)),
                })
            }
            // The note changed under the editor (a live pull adopted a peer
            // edit, or an in-flight autosave advanced disk past `base`). Never
            // drop the draft: park it as a conflict copy — the diverged note on
            // disk is left intact and the edit survives as a new note.
            Ok(_) => self.park_conflict_draft(id, content),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                drop(vault_mutation);
                self.recreate_missing_draft(id, content)
            }
            Err(error) => Err(io_error(error)),
        }
    }

    /// The flush's peer-delete arm: a dirty draft is edit-wins — recreate at
    /// the ORIGINAL id (the same home the editor's resume autosave rewrites,
    /// so the survive and jetsam paths converge with no duplicate copy). The
    /// install is atomic no-replace: a live-sync pull that recreated the id
    /// outside the store's serialization is never clobbered — if the id
    /// reappeared, park the draft unless it converged.
    fn recreate_missing_draft(&self, id: &str, content: &str) -> Result<FlushDraftResult, String> {
        let _vault_mutation = vault_mutation_guard()?;
        // Never recreate at an id that cross-platform-collides (case-insensitive
        // / NFC) with a DIFFERENT surviving note. `create_new_atomic` only fails
        // on an EXACT-path collision, so on a case-sensitive filesystem
        // recreating a peer-deleted "Note" beside a live "note" would install a
        // shadow `write_raw` refuses for ordinary writes. Park the edit instead —
        // the draft still survives, at a non-shadowing conflict-copy id.
        if self.colliding_note(id).is_some() {
            return self.park_conflict_draft(id, content);
        }
        let change = FileChange::Changed(note_filename(id));
        self.before_write
            .before_write(std::slice::from_ref(&change));
        #[cfg(test)]
        if let Some(hook) = self.install_window_hook.lock().unwrap().as_ref() {
            hook(id);
        }
        if vault_fs::create_new(&self.root, &note_filename(&id), content.as_bytes())? {
            let metadata = vault::metadata(&self.root, id)
                .ok_or_else(|| "note metadata unavailable after recreate".to_owned())?;
            self.search.notify(&change);
            return Ok(FlushDraftResult {
                disposition: FlushDisposition::Recreated,
                mutation: Some(self.upsert_mutation(metadata)),
            });
        }
        match self.read_note_file(id) {
            Ok(current) if current == content => Ok(FlushDraftResult {
                disposition: FlushDisposition::Converged,
                mutation: None,
            }),
            _ => self.park_conflict_draft(id, content),
        }
    }

    /// Park a draft that conflicts with a genuinely different on-disk version
    /// as a "<title> (conflict YYYY-MM-DD)" copy, named by the engine's one
    /// conflict-naming rule (`futo_notes_core::conflict_names` — the rule sync
    /// already uses). Idempotent: if a copy this park could have minted (the
    /// dated stem or one of its counter variants) already holds byte-identical
    /// content, the existing copy is reported and nothing new is created — a
    /// crash-window double-park mints ONE copy. Caller holds the mutation gate.
    pub(crate) fn park_conflict_draft(
        &self,
        id: &str,
        content: &str,
    ) -> Result<FlushDraftResult, String> {
        let (folder, title) = split_id(id);
        let date = current_conflict_date();
        let sibling_titles: Vec<String> = vault::note_paths(&self.root)
            .into_iter()
            .filter_map(|(sibling_id, _)| {
                let (sibling_folder, sibling_title) = split_id(&sibling_id);
                (sibling_folder == folder).then_some(sibling_title)
            })
            .collect();
        let stem = note_title(&conflict_filename(
            &note_filename(&title),
            &date,
            &HashSet::new(),
        ));
        for sibling_title in &sibling_titles {
            if !is_dated_conflict_variant(&stem, sibling_title) {
                continue;
            }
            let parked_id = join_id(&folder, sibling_title);
            if self.read(&parked_id).as_deref() == Ok(content) {
                return Ok(FlushDraftResult {
                    disposition: FlushDisposition::ParkedConflict { parked_id },
                    mutation: None,
                });
            }
        }
        // Mint the copy no-replace. The naming rule avoids every sibling seen
        // now; a writer outside this store's serialization landing on the
        // chosen name in the window fails the install (EEXIST), and the retry
        // re-runs the rule with that name occupied — never a clobber. Like
        // every brand-new create (see `install_new`, D2), the park registers
        // NO watcher suppression: the own-create echo reconciles idempotently
        // and a peer's colliding event must not be eaten.
        let mut existing: HashSet<String> = sibling_titles
            .iter()
            .map(|sibling_title| note_filename(sibling_title))
            .collect();
        for _ in 0..1000 {
            let filename = conflict_filename(&note_filename(&title), &date, &existing);
            let parked_id = join_id(&folder, &note_title(&filename));
            // Skip a candidate that cross-platform-collides (case-insensitive /
            // NFC) with a DIFFERENT live note: `create_new_atomic` can't see
            // that on a case-sensitive filesystem, so installing here would
            // shadow it. Occupy the name so the naming rule advances to the next
            // dated counter, then retry.
            if self.colliding_note(&parked_id).is_some() {
                existing.insert(filename);
                continue;
            }
            paths::note_path(&self.root, &parked_id)?;
            #[cfg(test)]
            if let Some(hook) = self.install_window_hook.lock().unwrap().as_ref() {
                hook(&parked_id);
            }
            if vault_fs::create_new(&self.root, &note_filename(&parked_id), content.as_bytes())? {
                let metadata = vault::metadata(&self.root, &parked_id)
                    .ok_or_else(|| "note metadata unavailable after park".to_owned())?;
                self.search
                    .notify(&FileChange::Changed(note_filename(&parked_id)));
                return Ok(FlushDraftResult {
                    disposition: FlushDisposition::ParkedConflict {
                        parked_id: parked_id.clone(),
                    },
                    mutation: Some(self.upsert_mutation(metadata)),
                });
            }
            existing.insert(filename);
        }
        Err("could not allocate a conflict-copy id after repeated collisions".to_owned())
    }
}

/// Whether `candidate` is a title [`LocalNoteStore::park_conflict_draft`]
/// could have minted for the dated `stem` ("<base> (conflict YYYY-MM-DD)"):
/// the stem itself or one of the naming rule's counter variants
/// ("<base> (conflict YYYY-MM-DD N)"). Deliberately NOT a prefix match, so a
/// merely similarly-named user note ("<stem> draft") never satisfies the park
/// idempotency guard (the F1 class).
fn is_dated_conflict_variant(stem: &str, candidate: &str) -> bool {
    if candidate == stem {
        return true;
    }
    let Some(open) = stem.strip_suffix(')') else {
        return false;
    };
    candidate
        .strip_prefix(open)
        .and_then(|rest| rest.strip_prefix(' '))
        .and_then(|rest| rest.strip_suffix(')'))
        .is_some_and(|counter| {
            !counter.is_empty() && counter.bytes().all(|byte| byte.is_ascii_digit())
        })
}
