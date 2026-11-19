use super::*;

impl StoreEditorSession<'_> {
    fn lock_state(&self) -> std::sync::MutexGuard<'_, Attachment> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Lock only: usable on a deleted or paused attachment.
    pub(super) fn read<R>(&self, f: impl FnOnce(&mut Attachment) -> R) -> R {
        f(&mut self.lock_state())
    }

    /// Lock, then `SessionDeleted` once terminal. Input, selection, composition and
    /// history use only this: no store gate or vault guard, so typing never waits on
    /// another workflow. Never take the gate while holding the attachment lock
    /// (identity transitions lock the attachment while holding the gate).
    pub(super) fn live<R>(
        &self,
        f: impl FnOnce(&mut Attachment) -> Result<R, EditorStoreError>,
    ) -> Result<R, EditorStoreError> {
        let mut state = self.lock_state();
        if state.terminal {
            return Err(EditorStoreError::SessionDeleted);
        }
        f(&mut state)
    }

    /// Gate, then vault guard, then state lock (this order), then the terminal check.
    /// Only workflows that touch the vault (saving) use this.
    pub(super) fn mutate<R>(
        &self,
        f: impl FnOnce(&mut Attachment, &LocalNoteStore) -> Result<R, EditorStoreError>,
    ) -> Result<R, EditorStoreError> {
        let _gate = self.store.lock_gate().map_err(EditorStoreError::Open)?;
        let _vault =
            futo_notes_core::files::vault_mutation_guard().map_err(EditorStoreError::Open)?;
        let mut state = self.lock_state();
        if state.terminal {
            return Err(EditorStoreError::SessionDeleted);
        }
        f(&mut state, &self.store)
    }

    /// Ordered own-action changes produced by atomic store workflows. Hosts
    /// apply each once before issuing input against the new revision.
    pub fn take_coordinated_changes(&mut self) -> Result<Vec<ViewChange>, EditorStoreError> {
        self.live(|state| Ok(std::mem::take(&mut state.coordinated)))
    }

    /// Where the session stands relative to the markdown file.
    pub fn save_status(&self) -> SaveStatus {
        self.read(|state| state.save_status())
    }

    /// Time left until the next save is due (zero when overdue); `None` when
    /// every edit is saved, or the session has ended. Arrange a `save_if_due`
    /// call on this worker then.
    pub fn save_delay(&self) -> Option<Duration> {
        self.read(|state| state.save_delay())
    }

    /// Save now if the debounce window has closed.
    pub fn save_if_due(&mut self) -> Result<Option<FlushDraftResult>, EditorStoreError> {
        self.mutate(|state, store| {
            if !state.save_due() {
                return Ok(None);
            }
            let result = state.checkpoint(store);
            state.lease.bind(&self.state);
            result.map(Some)
        })
    }

    /// Save, then release the attachment. A failed save returns its error and
    /// leaves the session attached so the caller can retry or copy the draft.
    pub fn close(&mut self) -> Result<FlushDraftResult, EditorStoreError> {
        let _gate = self.store.lock_gate().map_err(EditorStoreError::Open)?;
        let _vault =
            futo_notes_core::files::vault_mutation_guard().map_err(EditorStoreError::Open)?;
        let mut state = self.lock_state();
        if state.terminal {
            return Ok(FlushDraftResult {
                disposition: crate::FlushDisposition::Converged,
                mutation: None,
            });
        }
        let result = state.checkpoint(&self.store)?;
        state.end();
        Ok(result)
    }

    /// Release the attachment without saving: its unsaved edits are dropped
    /// (leaving a note while the vault refuses every write).
    pub fn discard(&mut self) {
        self.lock_state().end();
    }

    /// Save (or, `discard`, drop) the draft, then read the note the attachment
    /// holds back from disk into a fresh draft (an outside change adopted). The
    /// lease and id stay: a save that parked the draft left the attachment on the
    /// copy, so the copy is what it reads. A failed save or read leaves the draft
    /// as it was. `None` when nothing was saved.
    pub fn reload(&mut self, discard: bool) -> Result<Option<FlushDraftResult>, EditorStoreError> {
        self.mutate(|state, store| {
            let result = (!discard).then(|| state.checkpoint(store)).transpose()?;
            state.lease.bind(&self.state);
            let base = store
                .read_existing(&state.id)
                .map_err(EditorStoreError::Open)?
                .ok_or_else(|| EditorStoreError::Open(NOTE_NOT_FOUND.to_owned()))?;
            let mut engine = EditorSession::open_with_clock(
                &base,
                Arc::new(clock::GroupingClock(state.clock.clone())),
            );
            engine.update_note_ids(&links::vault_note_ids(&store.root));
            state.save = save::SaveSchedule::clean(engine.revision());
            state.engine = engine;
            state.set_base(base);
            state.coordinated.clear();
            state.relink_offer = None;
            Ok(result)
        })
    }

    /// `moved` runs whenever a store workflow moves this attachment to another
    /// id (a rename, a move, a sync relocation). It runs under the attachment's
    /// lock, so it may only signal.
    pub fn on_moved(&mut self, moved: impl Fn() + Send + 'static) {
        self.read(|state| state.moved = Some(Box::new(moved)));
    }

    pub fn source_text(&self) -> String {
        self.read(|state| state.engine.source_text())
    }

    pub fn display_text(&self) -> String {
        self.read(|state| state.engine.display_text())
    }

    pub fn id(&self) -> String {
        self.read(|state| state.id.clone())
    }

    pub fn revision(&self) -> Revision {
        self.read(|state| state.engine.revision())
    }

    pub fn active_formats(&self) -> Vec<InlineFormat> {
        self.read(|state| state.engine.active_formats())
    }

    pub fn toolbar_state(&self) -> futo_notes_editor::ToolbarState {
        self.read(|state| state.engine.toolbar_state())
    }

    pub fn selection(&self) -> DisplayRange {
        self.read(|state| state.engine.selection())
    }

    pub fn check_revision(&self, expected: Revision) -> Result<(), EditorStoreError> {
        self.read(|state| {
            state
                .engine
                .check_revision(expected)
                .map_err(EditorStoreError::Editor)
        })
    }

    pub fn source_at(
        &self,
        expected: Revision,
        offset: futo_notes_editor::DisplayOffset,
        affinity: Affinity,
    ) -> Result<futo_notes_editor::SourceOffset, EditorStoreError> {
        self.read(|state| {
            state
                .engine
                .source_at(expected, offset, affinity)
                .map_err(EditorStoreError::Editor)
        })
    }

    pub fn display_to_utf16(
        &self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<DisplayUtf16Range, EditorStoreError> {
        self.read(|state| {
            state
                .engine
                .display_to_utf16(expected, range)
                .map_err(EditorStoreError::Editor)
        })
    }

    pub fn display_from_utf16(
        &self,
        expected: Revision,
        range: DisplayUtf16Range,
    ) -> Result<DisplayRange, EditorStoreError> {
        self.read(|state| {
            state
                .engine
                .display_from_utf16(expected, range)
                .map_err(EditorStoreError::Editor)
        })
    }

    pub fn project(
        &self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<ProjectionSlice, EditorStoreError> {
        self.read(|state| {
            state
                .engine
                .project(expected, range)
                .map_err(EditorStoreError::Editor)
        })
    }

    pub fn select_with_affinity(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        affinity: Affinity,
    ) -> Result<SelectionChange, EditorStoreError> {
        self.live(|state| {
            state
                .engine
                .select_with_affinity(expected, range, affinity)
                .map_err(EditorStoreError::Editor)
        })
    }

    pub fn select_code_block(
        &mut self,
        expected: Revision,
        at: futo_notes_editor::DisplayOffset,
    ) -> Result<SelectionChange, EditorStoreError> {
        self.live(|state| {
            state
                .engine
                .select_code_block(expected, at)
                .map_err(EditorStoreError::Editor)
        })
    }

    /// A code block's language and `name:` from its header fields, as one
    /// edit; refused (`InvalidText`, nothing changed) when they would not
    /// read back.
    pub fn set_code_block_header(
        &mut self,
        expected: Revision,
        header: &futo_notes_editor::CodeBlockHeader,
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        self.live(|state| {
            state.edit(|engine, accept| engine.set_code_block_header(expected, header, accept))
        })
    }

    /// The user placed this selection: the same range also ends a selected
    /// block and a language caret.
    pub fn place_selection(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        affinity: Affinity,
    ) -> Result<SelectionChange, EditorStoreError> {
        self.live(|state| {
            state
                .engine
                .place_selection(expected, range, affinity)
                .map_err(EditorStoreError::Editor)
        })
    }

    pub fn toggle_format(
        &mut self,
        expected: Revision,
        format: InlineFormat,
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        self.live(|state| state.toggle_format(expected, format))
    }

    /// The mobile toolbar's toggle: a caret inside a word or at its start
    /// formats the whole word.
    pub fn toggle_toolbar_format(
        &mut self,
        expected: Revision,
        format: InlineFormat,
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        self.live(|state| state.toggle_toolbar_format(expected, format))
    }

    pub fn select_utf16(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
    ) -> Result<SelectionChange, EditorStoreError> {
        self.live(|state| {
            state
                .engine
                .select_utf16(expected, range)
                .map_err(EditorStoreError::Editor)
        })
    }

    pub fn move_caret(
        &mut self,
        expected: Revision,
        direction: CaretDirection,
    ) -> Result<SelectionChange, EditorStoreError> {
        self.live(|state| {
            state
                .engine
                .move_caret(expected, direction)
                .map_err(EditorStoreError::Editor)
        })
    }

    pub fn undo(&mut self, expected: Revision) -> Result<Option<ViewChange>, EditorStoreError> {
        self.live(|state| state.undo(expected))
    }

    pub fn redo(&mut self, expected: Revision) -> Result<Option<ViewChange>, EditorStoreError> {
        self.live(|state| state.redo(expected))
    }

    pub fn block_command_utf16(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
        command: futo_notes_editor::BlockCommand,
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        self.live(|state| state.block_command_utf16(expected, range, command))
    }

    pub fn block_command_removing_utf16(
        &mut self,
        expected: Revision,
        removed: DisplayUtf16Range,
        command: futo_notes_editor::BlockCommand,
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        self.live(|state| state.block_command_removing_utf16(expected, removed, command))
    }

    pub fn paragraph_key_utf16(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
        key: futo_notes_editor::ParagraphKey,
    ) -> Result<Option<ViewChange>, EditorStoreError> {
        self.live(|state| state.paragraph_key_utf16(expected, range, key))
    }

    pub fn replace_utf16(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
        inserted: &[u16],
    ) -> Result<ViewChange, EditorStoreError> {
        self.live(|state| state.replace_utf16(expected, range, inserted))
    }

    pub fn replace_utf16_action(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
        inserted: &[u16],
        action: futo_notes_editor::InputAction,
    ) -> Result<ViewChange, EditorStoreError> {
        self.live(|state| state.replace_utf16_action(expected, range, inserted, action))
    }

    pub fn replace_many_utf16(
        &mut self,
        expected: Revision,
        replacements: &[futo_notes_editor::DisplayUtf16Replacement],
    ) -> Result<ViewChange, EditorStoreError> {
        self.live(|state| state.replace_many_utf16(expected, replacements))
    }

    pub fn replace(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        inserted: &str,
    ) -> Result<ViewChange, EditorStoreError> {
        self.live(|state| state.replace(expected, range, inserted))
    }

    pub fn replace_action(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        inserted: &str,
        action: futo_notes_editor::InputAction,
    ) -> Result<ViewChange, EditorStoreError> {
        self.live(|state| state.replace_action(expected, range, inserted, action))
    }

    pub fn replace_many(
        &mut self,
        expected: Revision,
        replacements: &[futo_notes_editor::DisplayReplacement],
    ) -> Result<ViewChange, EditorStoreError> {
        self.live(|state| state.replace_many(expected, replacements))
    }

    /// Write the markdown now.
    pub fn checkpoint(&mut self) -> Result<FlushDraftResult, EditorStoreError> {
        self.mutate(|state, store| {
            let result = state.checkpoint(store);
            state.lease.bind(&self.state);
            result
        })
    }

    /// The title's rename: the draft saved as `title` (sanitized) in the folder
    /// the note is in when it runs, so a move that landed first is never undone,
    /// in one store workflow, the native shells' `save_draft_as`: an unchanged
    /// note is written and renamed (collision-resolved, backlinks rewritten), a
    /// changed one keeps its bytes while the draft parks as a conflict copy named
    /// after the destination, and a deleted one is recreated there. The
    /// attachment follows the draft to its final id; on failure it stays where
    /// it was.
    pub fn rename_title(&mut self, title: &str) -> Result<RenameDraftResult, EditorStoreError> {
        let _gate = self.store.lock_gate().map_err(EditorStoreError::Open)?;
        let _vault =
            futo_notes_core::files::vault_mutation_guard().map_err(EditorStoreError::Open)?;
        // Not held across the workflow: its rename locks this attachment to move it.
        let (id, base, draft) = self.live(|state| {
            // An unanswered relink offer: the file already holds the draft (see checkpoint).
            let draft = match state.relink_offer {
                Some(_) => state.base.clone(),
                None => state.engine.source_text(),
            };
            Ok((state.id.clone(), state.base.clone(), draft))
        })?;
        let folder = futo_notes_model::split_id(&id).0;
        let wanted_id = crate::join_id(&folder, &futo_notes_core::files::sanitize_title(title));
        let saved = self
            .store
            .save_draft_as_locked(&id, &wanted_id, &base, &draft);
        let mut state = self.lock_state();
        let (disposition, mutation) = match saved {
            Ok(saved) => saved,
            Err(error) => {
                // The draft can land before a failed rename; it is saved then.
                if self
                    .store
                    .read_note_file(&id)
                    .is_ok_and(|disk| disk == draft)
                {
                    state.set_base(draft);
                    state.mark_saved();
                }
                return Err(EditorStoreError::Checkpoint(error));
            }
        };
        let final_id = mutation
            .final_id
            .clone()
            .expect("save_draft_as always reports a final id");
        // A rewrite of the note's own links already set its baseline.
        if !mutation.relinked.contains(&final_id) {
            state.saved_as(&self.store.root, &final_id, draft)?;
        }
        state.lease.bind(&self.state);
        Ok(RenameDraftResult {
            final_id,
            parked_id: match disposition {
                crate::FlushDisposition::ParkedConflict { parked_id } => Some(parked_id),
                _ => None,
            },
            mutation,
        })
    }
}
