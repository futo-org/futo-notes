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
        self.replace_intent_mapped(
            expected,
            range,
            inserted,
            crate::inline::EditIntent::Input(action),
            accept,
        )
    }

    pub(in crate::session) fn replace_markdown_action(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        inserted: &str,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<ViewChange, EditorError> {
        self.replace_intent_mapped(
            expected,
            range,
            inserted,
            crate::inline::EditIntent::Paste,
            accept,
        )
        .map(|(change, _)| change)
    }

    pub(in crate::session) fn replace_intent_mapped(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        inserted: &str,
        intent: crate::inline::EditIntent,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<(ViewChange, InputMapping), EditorError> {
        let action = intent.action().ok_or(EditorError::UnrepresentableFormat)?;
        let mut query_work = crate::inline::references::ReferenceWork::default();
        let planned = self.replace_action_planned(
            expected,
            range,
            inserted,
            action,
            intent,
            accept,
            &mut query_work,
        );
        // A typed character is never refused: when no spelling of it reads as
        // typed, its delimiters land escaped, and failing that the text lands
        // as literal source.
        let typing = action == crate::InputAction::Typing
            && !inserted.is_empty()
            && self.composition.is_none();
        let (mut change, mapping) = match planned {
            Err(EditorError::UnrepresentableFormat) if typing => {
                let escaped = {
                    let _escape = crate::inline::EscapeTypedDelimiters::set();
                    self.replace_action_planned(
                        expected,
                        range,
                        inserted,
                        action,
                        intent,
                        accept,
                        &mut query_work,
                    )
                };
                match escaped {
                    Err(EditorError::UnrepresentableFormat) => {
                        let change =
                            self.literal_typing(expected, range, inserted, action, accept)?;
                        let mapping = InputMapping::new(change.range, change.inserted.len());
                        (change, mapping)
                    }
                    other => other?,
                }
            }
            other => other?,
        };
        change.work.parsed_source_bytes += query_work.parsed;
        change.work.link_metadata_items += query_work.items;
        change.work.link_copied_bytes += query_work.copied;
        Ok((change, mapping))
    }

    fn replace_action_planned(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        inserted: &str,
        action: crate::InputAction,
        intent: crate::inline::EditIntent,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
        query_work: &mut crate::inline::references::ReferenceWork,
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
        // Text inserted at a caret never splits a CRLF; a foreign replacement
        // range may still address the CR and LF code points separately.
        let range = if range.start == range.end {
            self.outside_crlf(range)
        } else {
            range
        };
        let cell = self.input_cell(range, inserted, query_work);
        let flat = cell.as_ref().map(|_| blocks::CellInput::flatten(inserted));
        let inserted = flat.as_deref().unwrap_or(inserted);
        if let Some(change) = self.fence_input(expected, range, inserted, action, accept)? {
            let mapping = InputMapping::new(range, inserted.len());
            return Ok((change, mapping));
        }
        if action == crate::InputAction::Typing {
            // A typed character is never refused: a shortcut whose block
            // cannot be written leaves its marker as literal text instead.
            let converted =
                self.marker_committed_into_empty_item(expected, range, inserted, accept)
                    .and_then(|change| match change {
                        Some(change) => Ok(Some(change)),
                        None => self
                            .line_start_conversion(expected, range, inserted, accept, query_work),
                    });
            match converted {
                Ok(Some(change)) => {
                    let mapping = InputMapping::new(change.range, change.inserted.len());
                    return Ok((change, mapping));
                }
                Ok(None) | Err(EditorError::UnrepresentableFormat) => {}
                Err(error) => return Err(error),
            }
        }
        if let Some(change) =
            self.input_at_divider(expected, range, inserted, action, intent, accept)?
        {
            let mapping = InputMapping::new(change.range, change.inserted.len());
            return Ok((change, mapping));
        }
        if let Some(change) = self
            .input_before_lazy_quote_neighbor(expected, range, inserted, action, intent, accept)?
        {
            return Ok(change);
        }
        let affinity = self.input_affinity(range);
        // A deletion that ends at the caret (Backspace) keeps the caret's
        // carried formats: removing the space typed after italic text, as a
        // keyboard's double-space period does, must not end the italic.
        let backspace = inserted.is_empty()
            && self.selection.start == self.selection.end
            && range.end == self.selection.start;
        let pending = if range == self.selection || backspace {
            self.pending_formats.as_deref()
        } else {
            None
        };
        let mut plan = self.projection.edit_cell(
            &self.source,
            range,
            inserted,
            affinity,
            pending,
            intent,
            cell.is_some(),
        )?;
        let edit = self.prepare_source(
            expected,
            SourceRange {
                start: SourceOffset(plan.range.start),
                end: SourceOffset(plan.range.end),
            },
            &plan.inserted,
        )?;
        if let Some(cell) = &cell {
            cell.check(&edit)?;
        }
        let before_links = self.projection.pending_for_source_edit(edit.range);
        let prepared = self.prepare_plan_pending(&edit, &plan, &before_links, Some(range))?;
        accept(&edit).map_err(EditorError::Persistence)?;
        let before_selection = self.selection;
        let (before_source, before_source_work) = self.capture_history_selection();
        let before_affinity = self.affinity;
        let before_formats = self.pending_formats.clone();
        self.affinity = affinity;
        let mut change = self.apply(&edit);
        self.install_plan_pending(&mut plan, prepared, &mut change, false);
        let (caret, caret_work) = self.projection.display_at_with_work(plan.caret);
        let caret = DisplayOffset(caret);
        let (input_start, input_work) = self.projection.display_at_with_work(plan.input_start);
        change.work.link_metadata_items += caret_work + input_work;
        let mapping = InputMapping::from_source(
            range,
            inserted.len(),
            &edit,
            plan.retained,
            plan.requires_source_identity,
            DisplayRange {
                start: DisplayOffset(input_start),
                end: caret,
            },
            plan.split_retirement,
        );
        self.selection = DisplayRange {
            start: caret,
            end: caret,
        };
        self.pending_formats = Some(plan.formats);
        change.work.link_metadata_items += self.projection.finish_link_input(
            DisplayRange {
                start: DisplayOffset(input_start),
                end: caret,
            },
            inserted,
            action,
            caret.0,
        );
        let (projection, link_work) = self
            .projection
            .query_with_work(self.revision, change.projection.range);
        change.projection = projection;
        change.work.link_metadata_items += link_work.items;
        change.work.link_copied_bytes += link_work.copied;
        change.selection = self.selection;
        change.work.materialized_source_bytes += plan.materialized;
        change.work.parsed_source_bytes += plan.parsed;
        change.work.link_metadata_items += plan.link_metadata_items;
        change.work.link_copied_bytes += plan.link_copied_bytes;
        let (after_source, after_source_work) = self.capture_history_selection();
        change.work.link_metadata_items += before_source_work + after_source_work;
        let after_links = self
            .projection
            .pending_links(before_links.after_window(&edit));
        change.work.link_metadata_items += before_links.work + after_links.work;
        let entry = HistoryEntry {
            before_source,
            after_source,
            before_selection,
            before_affinity,
            before_formats,
            before_links,
            after_selection: self.selection,
            after_affinity: self.affinity,
            after_formats: self.pending_formats.clone(),
            after_links,
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
        Ok((change, mapping))
    }

    pub(super) fn record_input_history(
        &mut self,
        entry: HistoryEntry,
        input: Option<HistoryInput<'_>>,
    ) {
        let join = self.input_joins_history(input.as_ref(), entry.before_selection);
        if join {
            self.undo.last_mut().unwrap().entries.push(entry);
        } else {
            self.undo.push(HistoryGroup {
                entries: vec![entry],
            });
        }
        self.redo.clear();
    }

    /// Whether this input joins the open typing group.
    pub(super) fn input_joins_history(
        &mut self,
        input: Option<&HistoryInput<'_>>,
        before_selection: DisplayRange,
    ) -> bool {
        let now = self.clock.now();
        let kind = input
            .filter(|input| input.action == crate::InputAction::Typing)
            .and_then(|input| {
                crate::history::typing_kind(input.range, input.inserted, before_selection)
            });
        let join = kind.is_some_and(|kind| {
            self.typing
                .as_ref()
                .is_some_and(|run| run.continues(kind, input.as_ref().unwrap().range, now))
        });
        self.typing = kind.map(|kind| TypingRun::new(kind, self.selection, now));
        join
    }
}
