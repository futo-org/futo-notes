use super::*;

impl BoundedEditorSession {
    /// The first supported slice inserts one non-newline, non-fence-marker
    /// scalar into retained opaque code. Other operations require a deliberate
    /// materializing handoff; this method never falls back to full planning.
    pub fn insert_literal(
        &mut self,
        cursor: BoundedCursor,
        at: DisplayOffset,
        inserted: &str,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<BoundedChange, BoundedError> {
        if cursor != self.cursor() {
            return Err(BoundedError::StaleCursor);
        }
        let position = self
            .display
            .try_byte_to_char(at.0)
            .map_err(|_| BoundedError::Editor(EditorError::InvalidRange))?;
        if self.display.char_to_byte(position) != at.0 {
            return Err(BoundedError::Editor(EditorError::InvalidRange));
        }
        if inserted.len() > 4
            || inserted.chars().count() != 1
            || inserted.contains(['\r', '\n', '`', '~'])
        {
            return Err(BoundedError::Unsupported);
        }
        if self.progress.is_some() && Rope::from_str(inserted).len_lines() != 1 {
            return Err(BoundedError::Unsupported);
        }
        let in_body = self.code.display.start <= at.0 && at.0 <= self.code.display.end;
        let (source, pending_window, lookup_work) = if in_body {
            (
                SourceOffset(self.code.body.start + at.0 - self.code.display.start),
                self.code.whole.clone(),
                0,
            )
        } else {
            self.progress
                .as_ref()
                .and_then(|progress| {
                    progress.code_source_at(&self.engine.source, &self.display, at)
                })
                .ok_or(BoundedError::Unsupported)?
        };
        let mut work = BoundedWork {
            input_bytes: inserted.len(),
            metadata_items: lookup_work,
            ..Default::default()
        };
        if self
            .progress
            .as_ref()
            .is_some_and(|progress| progress.certificate.has_crlf)
        {
            let before = source
                .0
                .checked_sub(1)
                .and_then(|at| self.engine.source.get_byte(at));
            let after = self.engine.source.get_byte(source.0);
            work.inspected_source_bytes +=
                usize::from(before.is_some()) + usize::from(after.is_some());
            // A non-breaking scalar can still split a CRLF into two Rope
            // lines. The prepared line index must stay valid before append.
            if before == Some(b'\r') && after == Some(b'\n') {
                return Err(BoundedError::Unsupported);
            }
        }
        let generation = self
            .generation
            .checked_add(1)
            .ok_or(BoundedError::Editor(EditorError::RevisionExhausted))?;
        let edit = self
            .engine
            .prepare_source(
                cursor.revision,
                SourceRange {
                    start: source,
                    end: source,
                },
                inserted,
            )
            .map_err(BoundedError::Editor)?;
        work.copied_bytes += edit.inserted.len();
        work.metadata_items += 1; // prepared source record
        let before_selection = self.engine.selection;
        let before_affinity = self.engine.affinity;
        let before_formats = self.engine.pending_formats.clone();
        work.metadata_items += before_formats.as_ref().map_or(0, Vec::len);
        let affinity = self
            .engine
            .input_affinity(DisplayRange { start: at, end: at });
        accept(&edit).map_err(|error| BoundedError::Editor(EditorError::Persistence(error)))?;
        let char_index = self.engine.source.byte_to_char(source.0);
        self.engine.source.insert(char_index, inserted);
        self.display
            .insert(self.display.byte_to_char(at.0), inserted);
        self.engine.revision = edit.revision;
        let caret = DisplayOffset(at.0 + inserted.len());
        self.engine.selection = DisplayRange {
            start: caret,
            end: caret,
        };
        self.engine.affinity = affinity;
        self.engine.pending_formats = None;
        let after_source = SourcePoint {
            source: SourceOffset(source.0 + inserted.len()),
            within: 0,
            atom: None,
        };
        let after_source = SourceSelection::Exact(ExactSelection {
            start: after_source,
            end: after_source,
        });
        let before_links = opaque_pending(pending_window.clone());
        work.metadata_items += 4; // source point, exact range, selection and pending snapshot
        if in_body {
            self.code.body.end += inserted.len();
            self.code.display.end += inserted.len();
            self.code.whole.end += inserted.len();
        }
        work.metadata_items += 3; // retained length updates
        let joins_previous = self.engine.input_joins_history(
            Some(&HistoryInput {
                range: DisplayRange { start: at, end: at },
                inserted,
                action: crate::InputAction::Typing,
            }),
            before_selection,
        );
        self.discard_redo();
        work.metadata_items += 1;
        let source_change = BoundedSourceChange {
            range: edit.range,
            inserted_bytes: edit.inserted.len(),
        };
        let record = edit.clone();
        work.copied_bytes += record.inserted.len();
        let history = HistoryEntry {
            before_source: self.history_selection,
            after_source,
            before_selection,
            before_affinity,
            before_formats,
            before_links,
            after_selection: self.engine.selection,
            after_affinity: affinity,
            after_formats: None,
            after_links: opaque_pending(pending_window.start..pending_window.end + inserted.len()),
            range: edit.range,
            removed: edit.removed,
            inserted: edit.inserted,
        };
        self.source_records.push_back(record);
        self.deferred.push_back(AcceptedCodeInput {
            history,
            joins_previous,
            kind: AcceptedKind::Literal,
        });
        work.metadata_items += 5; // grouping state, accepted record, history and two pending/point copies
        self.history_selection = after_source;
        self.generation = generation;
        if let Some(progress) = &mut self.progress {
            progress.accepted_input();
        }
        let range = DisplayRange {
            start: at,
            end: caret,
        };
        work.copied_bytes +=
            inserted.len() * 2 + self.code.language.as_ref().map_or(0, String::len);
        work.returned_text_bytes = inserted.len() * 2;
        work.returned_records = 2;
        work.metadata_items += 6; // identity, block, projection, change and two cursor records
        Ok(BoundedChange {
            previous: cursor,
            cursor: self.cursor(),
            range: DisplayRange { start: at, end: at },
            inserted: inserted.to_owned(),
            selection: self.engine.selection,
            affinity,
            source_change,
            continuation: self.continuation(),
            projection: BoundedCodeProjection {
                range,
                text: inserted.to_owned(),
                identity: CodeIdentity {
                    source: SourceRange {
                        start: source,
                        end: SourceOffset(source.0 + inserted.len()),
                    },
                    display: range,
                },
                block: CodeFragment {
                    owner: SourceOffset(self.code.whole.start),
                    range,
                    language: self.code.language.clone(),
                },
            },
            work,
        })
    }
}
