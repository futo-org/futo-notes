use super::*;

impl BoundedEditorSession {
    /// One positive-alphabet plain prefix key, independent of the giant fence
    /// neighbor. No generic paragraph staging or Markdown reconstruction.
    pub fn insert_prefix_literal(
        &mut self,
        cursor: BoundedCursor,
        at: DisplayOffset,
        inserted: &str,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<BoundedProgressChange, BoundedError> {
        if cursor != self.cursor() {
            return Err(BoundedError::StaleCursor);
        }
        if inserted.len() > 4
            || inserted.chars().count() != 1
            || !inserted.chars().all(char::is_alphanumeric)
            || Rope::from_str(inserted).len_lines() != 1
            || self
                .engine
                .pending_formats
                .as_ref()
                .is_some_and(|formats| !formats.is_empty())
        {
            return Err(BoundedError::Unsupported);
        }
        let prefix = self.prefix.as_ref().ok_or(BoundedError::Unsupported)?;
        let source_start = self.engine.source.line_to_byte(prefix.source_line);
        let source_end = self.engine.source.line_to_byte(prefix.source_line + 1) - 1;
        let display_start = self.display.line_to_byte(prefix.display_line);
        let display_end = self.display.line_to_byte(prefix.display_line + 1) - 1;
        if at.0 < display_start || at.0 > display_end {
            return Err(BoundedError::Unsupported);
        }
        let source = SourceOffset(source_start + at.0 - display_start);
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
        let before_selection = self.engine.selection;
        let before_source = self.history_selection;
        let before_affinity = self.engine.affinity;
        let before_formats = self.engine.pending_formats.clone();
        let affinity = self
            .engine
            .input_affinity(DisplayRange { start: at, end: at });
        accept(&edit).map_err(|error| BoundedError::Editor(EditorError::Persistence(error)))?;
        self.engine
            .source
            .insert(self.engine.source.byte_to_char(source.0), inserted);
        self.engine.revision = edit.revision;
        self.shift_code_prefix(0, inserted.len());
        self.engine.selection = DisplayRange {
            start: DisplayOffset(at.0 + inserted.len()),
            end: DisplayOffset(at.0 + inserted.len()),
        };
        self.engine.affinity = affinity;
        self.engine.pending_formats = None;
        let point = SourcePoint {
            source: SourceOffset(source.0 + inserted.len()),
            within: 0,
            atom: None,
        };
        let after_source = SourceSelection::Exact(ExactSelection {
            start: point,
            end: point,
        });
        let joins_previous = self.engine.input_joins_history(
            Some(&HistoryInput {
                range: DisplayRange { start: at, end: at },
                inserted,
                action: crate::InputAction::Typing,
            }),
            before_selection,
        );
        self.discard_redo();
        self.source_records.push_back(edit.clone());
        self.deferred.push_back(AcceptedCodeInput {
            history: HistoryEntry {
                before_source,
                after_source,
                before_selection,
                before_affinity,
                before_formats,
                before_links: opaque_pending(source_start..source_end),
                after_selection: self.engine.selection,
                after_affinity: affinity,
                after_formats: None,
                after_links: opaque_pending(source_start..source_end + inserted.len()),
                range: edit.range,
                removed: edit.removed,
                inserted: edit.inserted,
            },
            joins_previous,
            kind: AcceptedKind::Prefix,
        });
        self.history_selection = after_source;
        if let Some(progress) = &mut self.progress {
            progress.accepted_input();
        }
        let source_change = BoundedSourceChange {
            range: SourceRange {
                start: source,
                end: source,
            },
            inserted_bytes: inserted.len(),
        };
        let mut frame = self.install_prefix_frame(
            cursor,
            generation,
            DisplayRange { start: at, end: at },
            source.0..source.0 + inserted.len(),
            source_change,
        );
        frame.work.copied_bytes += inserted.len() * 2;
        frame.work.input_bytes = inserted.len();
        Ok(frame)
    }

    pub(super) fn prefix_display_point(&self, source: SourceOffset) -> Option<DisplayOffset> {
        let prefix = self.prefix.as_ref()?;
        let start = self.engine.source.line_to_byte(prefix.source_line);
        let end = self.engine.source.line_to_byte(prefix.source_line + 1) - 1;
        if source.0 < start || source.0 > end {
            return None;
        }
        Some(DisplayOffset(
            self.display.line_to_byte(prefix.display_line) + source.0 - start,
        ))
    }

    pub(super) fn shift_code_prefix(&mut self, removed: usize, inserted: usize) {
        for range in [
            &mut self.code.body,
            &mut self.code.whole,
            &mut self.code.display,
        ] {
            range.start = range.start - removed + inserted;
            range.end = range.end - removed + inserted;
        }
    }

    pub(super) fn install_prefix_frame(
        &mut self,
        previous: BoundedCursor,
        generation: u64,
        range: DisplayRange,
        source: std::ops::Range<usize>,
        source_change: BoundedSourceChange,
    ) -> BoundedProgressChange {
        let raw = self.engine.source.byte_slice(source.clone()).to_string();
        let old = self
            .display
            .byte_slice(range.start.0..range.end.0)
            .to_string();
        let a = self.display.byte_to_char(range.start.0);
        let z = self.display.byte_to_char(range.end.0);
        self.display.remove(a..z);
        self.display.insert(a, &raw);
        let selection_visits = self.reproject_code_selection();
        self.generation = generation;
        let shown = DisplayRange {
            start: range.start,
            end: DisplayOffset(range.start.0 + raw.len()),
        };
        let footprint = SourceRange {
            start: SourceOffset(source.start),
            end: SourceOffset(source.end),
        };
        let copied_bytes = raw.len() * 2 + old.len();
        let returned_text_bytes = raw.len() * 2;
        BoundedProgressChange {
            previous,
            cursor: self.cursor(),
            range,
            inserted: raw.clone(),
            selection: self.engine.selection,
            affinity: self.engine.affinity,
            source_change: Some(source_change),
            source_footprint: footprint,
            projection: BoundedMeaning {
                range: shown,
                text: raw,
                mapping: vec![BoundedMap {
                    source: footprint,
                    display: shown,
                    kind: BoundedMapKind::Literal,
                }],
                runs: vec![crate::SemanticRun {
                    range: shown,
                    formats: Vec::new(),
                }],
                blocks: vec![BoundedBlock {
                    description: crate::BlockDescription {
                        range: shown,
                        heading: 0,
                        quote_depth: 0,
                        divider: false,
                        list: None,
                        code: false,
                        language: None,
                    },
                    source_owner: None,
                    continues_before: true,
                    continues_after: true,
                }],
                links: Vec::new(),
            },
            continuation: self.continuation(),
            work: BoundedWork {
                inspected_source_bytes: source.len(),
                copied_bytes,
                returned_text_bytes,
                returned_records: 3,
                metadata_items: 18 + selection_visits,
                ..Default::default()
            },
        }
    }
}
