use super::*;

impl EditorSession {
    /// `accept` must protect the record against process death before returning
    /// success. A WASM-local success alone cannot provide that acknowledgement.
    /// The exclusive session borrow prevents synchronous acceptance callbacks from
    /// re-entering input; a later native echo must retain its original revision.
    ///
    /// ```compile_fail,E0499
    /// use futo_notes_editor::{DisplayRange, EditorSession, Revision};
    /// let mut session = EditorSession::open("text");
    /// session.replace(Revision(0), DisplayRange::default(), "!", &mut |_| {
    ///     session.select(Revision(0), DisplayRange::default()).unwrap();
    ///     Ok(())
    /// });
    /// ```
    pub fn replace(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        inserted: &str,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<ViewChange, EditorError> {
        self.replace_action(
            expected,
            range,
            inserted,
            crate::InputAction::Typing,
            accept,
        )
    }

    /// Paste, correction, compound actions and final composition commits are
    /// isolated; provisional marked text must never enter this source method.
    pub fn replace_action(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        inserted: &str,
        action: crate::InputAction,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<ViewChange, EditorError> {
        self.replace_action_mapped(expected, range, inserted, action, accept)
            .map(|(change, _)| change)
    }

    pub(super) fn replace_action_mapped(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        inserted: &str,
        action: crate::InputAction,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<(ViewChange, InputMapping), EditorError> {
        self.check_revision(expected)?;
        if self.composition.is_some() {
            if action == crate::InputAction::CompositionCommit {
                return Err(EditorError::CompositionActive);
            }
            return self
                .input_during_composition(expected, range, inserted, action, accept)
                .map(|change| {
                    let mapping = InputMapping::new(change.range, change.inserted.len());
                    (change, mapping)
                });
        }
        self.validate_range(range)?;
        if let Some(change) = self.fence_input(expected, range, inserted, action, accept)? {
            let mapping = InputMapping::new(range, inserted.len());
            return Ok((change, mapping));
        }
        if action == crate::InputAction::Typing {
            if let Some(change) = self.line_start_conversion(expected, range, inserted, accept)? {
                let mapping = InputMapping::new(change.range, change.inserted.len());
                return Ok((change, mapping));
            }
        }
        if let Some(change) = self.input_at_divider(expected, range, inserted, action, accept)? {
            let mapping = InputMapping::new(change.range, change.inserted.len());
            return Ok((change, mapping));
        }
        if let Some(change) =
            self.input_before_lazy_quote_neighbor(expected, range, inserted, action, accept)?
        {
            return Ok(change);
        }
        let affinity = self.input_affinity(range);
        let pending = if range == self.selection {
            self.pending_formats.as_deref()
        } else {
            None
        };
        let plan = self
            .projection
            .edit(&self.source, range, inserted, affinity, pending, None)?;
        let edit = self.prepare_source(
            expected,
            SourceRange {
                start: SourceOffset(plan.range.start),
                end: SourceOffset(plan.range.end),
            },
            &plan.inserted,
        )?;
        accept(&edit).map_err(EditorError::Persistence)?;
        let before_selection = self.selection;
        let before_affinity = self.affinity;
        let before_formats = self.pending_formats.clone();
        let before_links = self.projection.literal_links.clone();
        self.affinity = affinity;
        let mut change = self.apply(&edit);
        let caret = DisplayOffset(self.projection.display_at(plan.caret));
        self.selection = DisplayRange {
            start: caret,
            end: caret,
        };
        self.pending_formats = Some(plan.formats);
        self.projection
            .finish_link_input(range, inserted, action, caret.0);
        change.projection = self
            .projection
            .query(self.revision, change.projection.range);
        change.selection = self.selection;
        change.work.materialized_source_bytes += plan.materialized;
        change.work.parsed_source_bytes += plan.parsed;
        let entry = HistoryEntry {
            before_selection,
            before_affinity,
            before_formats,
            before_links,
            after_selection: self.selection,
            after_affinity: self.affinity,
            after_formats: self.pending_formats.clone(),
            after_links: self.projection.literal_links.clone(),
            range: edit.range,
            removed: edit.removed,
            inserted: edit.inserted,
        };
        self.record_input_history(
            entry,
            Some(HistoryInput {
                range,
                inserted,
                action,
            }),
        );
        Ok((change, InputMapping::new(range, inserted.len())))
    }

    pub(super) fn record_input_history(
        &mut self,
        entry: HistoryEntry,
        input: Option<HistoryInput<'_>>,
    ) {
        let now = self.clock.now();
        let kind = input
            .as_ref()
            .filter(|input| input.action == crate::InputAction::Typing)
            .and_then(|input| {
                crate::history::typing_kind(input.range, input.inserted, entry.before_selection)
            });
        let join = kind.is_some_and(|kind| {
            self.typing
                .as_ref()
                .is_some_and(|run| run.continues(kind, input.as_ref().unwrap().range, now))
        });
        self.typing = kind.map(|kind| TypingRun::new(kind, self.selection, now));
        if join {
            self.undo.last_mut().unwrap().entries.push(entry);
        } else {
            self.undo.push(HistoryGroup {
                entries: vec![entry],
            });
        }
        self.redo.clear();
    }
}
