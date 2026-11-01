use super::*;

const MAX_GROUP: usize = 32;
const MAX_FOOTPRINT: usize = 256;

impl BoundedEditorSession {
    pub fn undo_bounded(
        &mut self,
        cursor: BoundedCursor,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<BoundedProgress>, BoundedError> {
        self.bounded_history(cursor, false, accept)
    }
    pub fn redo_bounded(
        &mut self,
        cursor: BoundedCursor,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<BoundedProgress>, BoundedError> {
        self.bounded_history(cursor, true, accept)
    }

    fn bounded_history(
        &mut self,
        cursor: BoundedCursor,
        redo: bool,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<BoundedProgress>, BoundedError> {
        if cursor != self.cursor() {
            return Err(BoundedError::StaleCursor);
        }
        let mut count = 0;
        let mut start = usize::MAX;
        let mut end = 0;
        let mut bytes = 0;
        let mut kind = None;
        let mut found = redo;
        let mut include = |entry: &AcceptedCodeInput| {
            count += 1;
            bytes += entry.history.removed.len() + entry.history.inserted.len();
            start = start.min(entry.history.range.start.0);
            end = end.max(
                entry.history.range.start.0
                    + entry
                        .history
                        .removed
                        .len()
                        .max(entry.history.inserted.len()),
            );
            if count > MAX_GROUP || bytes > MAX_FOOTPRINT || end - start > MAX_FOOTPRINT {
                return false;
            }
            if kind.is_some_and(|kind| kind != entry.kind) {
                return false;
            }
            kind = Some(entry.kind);
            true
        };
        if redo {
            let Some(group) = self.redo_groups.back() else {
                return if self.engine.redo.is_empty() {
                    Ok(None)
                } else {
                    Err(BoundedError::Unsupported)
                };
            };
            for entry in group {
                if !include(entry) {
                    return Err(BoundedError::Unsupported);
                }
            }
        } else {
            for entry in self.deferred.iter().rev() {
                if !include(entry) {
                    return Err(BoundedError::Unsupported);
                }
                if !entry.joins_previous {
                    found = true;
                    break;
                }
            }
        }
        if count == 0 {
            return if self.engine.undo.is_empty() {
                Ok(None)
            } else {
                Err(BoundedError::Unsupported)
            };
        }
        if !found {
            return Err(BoundedError::Unsupported);
        }
        let kind = kind.unwrap();
        let generation = self
            .generation
            .checked_add(1)
            .ok_or(BoundedError::Editor(EditorError::RevisionExhausted))?;
        let entries: Vec<_> = if redo {
            self.redo_groups.back().unwrap().iter().collect()
        } else {
            self.deferred.iter().rev().take(count).collect()
        };
        let target = entries.last().unwrap();
        let selected = if redo {
            target.history.after_source
        } else {
            target.history.before_source
        };
        let selection = if redo {
            target.history.after_selection
        } else {
            target.history.before_selection
        };
        let affinity = if redo {
            target.history.after_affinity
        } else {
            target.history.before_affinity
        };
        let formats = if redo {
            target.history.after_formats.clone()
        } else {
            target.history.before_formats.clone()
        };
        let mut transaction = crate::history::Transaction::new(&self.engine.source);
        for accepted in &entries {
            let entry = &accepted.history;
            let (range, inserted) = if redo {
                (entry.range, entry.inserted.as_str())
            } else {
                (
                    SourceRange {
                        start: entry.range.start,
                        end: SourceOffset(entry.range.start.0 + entry.inserted.len()),
                    },
                    entry.removed.as_str(),
                )
            };
            transaction.apply(range, inserted);
        }
        let (range, inserted) = transaction.finish();
        if inserted.len() > MAX_FOOTPRINT {
            return Err(BoundedError::Unsupported);
        }
        let edit = self
            .engine
            .prepare_source(cursor.revision, range, &inserted)
            .map_err(BoundedError::Editor)?;
        let old_body = self.code.body.clone();
        let mut selection_visits = 0;
        let old_display = if kind == AcceptedKind::Prefix {
            DisplayRange {
                start: self
                    .prefix_display_point(edit.range.start)
                    .ok_or(BoundedError::Unsupported)?,
                end: self
                    .prefix_display_point(edit.range.end)
                    .ok_or(BoundedError::Unsupported)?,
            }
        } else if kind == AcceptedKind::Closer {
            let progress = self.progress.as_ref().ok_or(BoundedError::Unsupported)?;
            DisplayRange {
                start: DisplayOffset(self.code.display.end),
                end: DisplayOffset(self.display.line_to_byte(
                    progress.certificate.units[0].display_lines.start + progress.frame_lines,
                )),
            }
        } else {
            let start = self
                .current_code_display(edit.range.start, &mut selection_visits)
                .ok_or(BoundedError::Unsupported)?;
            let end = self
                .current_code_display(edit.range.end, &mut selection_visits)
                .ok_or(BoundedError::Unsupported)?;
            DisplayRange { start, end }
        };
        accept(&edit).map_err(|error| BoundedError::Editor(EditorError::Persistence(error)))?;
        let a = self.engine.source.byte_to_char(edit.range.start.0);
        let z = self.engine.source.byte_to_char(edit.range.end.0);
        self.engine.source.remove(a..z);
        self.engine.source.insert(a, &edit.inserted);
        self.engine.revision = edit.revision;
        let source_change = BoundedSourceChange {
            range: edit.range,
            inserted_bytes: edit.inserted.len(),
        };
        self.source_records.push_back(edit.clone());
        if kind == AcceptedKind::Prefix {
            self.shift_code_prefix(edit.removed.len(), edit.inserted.len());
        }
        if kind == AcceptedKind::Literal
            && old_body.start <= edit.range.start.0
            && edit.range.end.0 <= old_body.end
        {
            self.code.body.end = self.code.body.end - edit.removed.len() + edit.inserted.len();
            self.code.display.end =
                self.code.display.end - edit.removed.len() + edit.inserted.len();
            self.code.whole.end = self.code.whole.end - edit.removed.len() + edit.inserted.len();
        }
        self.engine.typing = None;
        self.engine.pending_formats = formats;
        self.engine.affinity = affinity;
        self.engine.selection = selection;
        self.history_selection = selected;
        let mut group = LinkedList::new();
        if redo {
            group = self.redo_groups.pop_back().unwrap();
            self.deferred.append(&mut group);
        } else {
            for _ in 0..count {
                group.push_front(self.deferred.pop_back().unwrap());
            }
            self.redo_groups.push_back(group);
        }
        let mut frame = if kind == AcceptedKind::Prefix {
            if let Some(progress) = &mut self.progress {
                progress.accepted_input();
            }
            self.install_prefix_frame(
                cursor,
                generation,
                old_display,
                edit.range.start.0..edit.range.start.0 + edit.inserted.len(),
                source_change,
            )
        } else if kind == AcceptedKind::Closer {
            self.code.whole.end = self.code.whole.end - edit.removed.len() + edit.inserted.len();
            let progress = self.progress.as_mut().unwrap();
            progress.restore = !redo;
            progress.active = true;
            progress.next = 0;
            progress.id += 1;
            let current_source = self.code.body.end
                ..self
                    .engine
                    .source
                    .line_to_byte(progress.certificate.units[0].source_lines.start);
            if redo {
                self.install_code_frame(
                    cursor,
                    generation,
                    old_display,
                    current_source,
                    false,
                    Some(source_change),
                    FrameKind::Fence,
                )
            } else {
                let original_source = progress.certificate.frame_source.clone();
                let original_display = progress.certificate.frame_display.clone();
                self.install_retained_frame(
                    cursor,
                    generation,
                    old_display,
                    current_source,
                    original_source,
                    original_display,
                    Some(source_change),
                    FrameKind::Fence,
                )
            }
        } else {
            if let Some(progress) = &mut self.progress {
                progress.accepted_input();
            }
            self.install_code_frame(
                cursor,
                generation,
                old_display,
                edit.range.start.0..edit.range.start.0 + edit.inserted.len(),
                false,
                Some(source_change),
                FrameKind::Region,
            )
        };
        frame.work.copied_bytes += inserted.len() + 2 * (edit.inserted.len() + edit.removed.len());
        frame.work.inspected_source_bytes += edit.removed.len();
        frame.work.metadata_items += count + selection_visits;
        Ok(Some(BoundedProgress::Change(frame)))
    }

    pub(super) fn current_code_display(
        &self,
        source: SourceOffset,
        visits: &mut usize,
    ) -> Option<DisplayOffset> {
        if self.code.whole.start <= source.0 && source.0 < self.code.body.start {
            return Some(DisplayOffset(self.code.display.start));
        }
        if self.code.body.start <= source.0 && source.0 <= self.code.body.end {
            Some(DisplayOffset(
                self.code.display.start + source.0 - self.code.body.start,
            ))
        } else {
            self.progress.as_ref()?.display_at_source(
                &self.engine.source,
                &self.display,
                source,
                visits,
            )
        }
    }
}
