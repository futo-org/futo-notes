//! A multi-run replacement is planned entirely before one host acceptance.
use super::*;
use crate::history::Transaction;
use crate::{DisplayReplacement, InputAction};

impl EditorSession {
    /// Apply one user action whose nonoverlapping runs address the opening
    /// display. Unchanged runs retain their original source spelling. Empty,
    /// unordered, overlapping and invalid inputs reject without acceptance.
    pub fn replace_many(
        &mut self,
        expected: Revision,
        replacements: &[DisplayReplacement],
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<ViewChange, EditorError> {
        self.check_revision(expected)?;
        if replacements.is_empty() {
            return Err(EditorError::InvalidRange);
        }
        for (index, replacement) in replacements.iter().enumerate() {
            self.validate_range(replacement.range)?;
            if index > 0
                && (replacements[index - 1].range.end.0 > replacement.range.start.0
                    || replacements[index - 1].range.start == replacement.range.start)
            {
                return Err(EditorError::InvalidRange);
            }
        }
        let range = DisplayRange {
            start: replacements[0].range.start,
            end: replacements.last().unwrap().range.end,
        };
        let (window, display_start) = self.projection.edit_window(range);
        let raw = self.source.byte_slice(window.clone()).to_string();
        let mut staged = Self::open_with_clock(&raw, self.clock.clone());
        let mut transaction = Transaction::new(&staged.source);
        let mut old_end = display_start;
        let mut new_end = 0;
        let mut materialized = raw.len();
        let mut parsed = 3 * raw.len();
        for replacement in replacements {
            let local_range = DisplayRange {
                start: DisplayOffset(new_end + replacement.range.start.0 - old_end),
                end: DisplayOffset(new_end + replacement.range.end.0 - old_end),
            };
            let affinity = if replacement.range == self.selection {
                self.affinity
            } else if replacement.range.start.0 == 0 {
                Affinity::Forward
            } else {
                Affinity::Backward
            };
            staged.select_with_affinity(staged.revision(), local_range, affinity)?;
            if replacement.range == self.selection {
                staged.pending_formats = self.pending_formats.clone();
            }
            let change = staged.replace_action(
                staged.revision(),
                local_range,
                &replacement.inserted,
                InputAction::Isolated,
                &mut |edit| {
                    transaction.apply(edit.range, &edit.inserted);
                    Ok(())
                },
            )?;
            materialized += change.work.materialized_source_bytes;
            parsed += change.work.parsed_source_bytes;
            old_end = replacement.range.end.0;
            new_end = staged.selection.end.0;
        }
        let (mut range, inserted) = transaction.finish();
        range.start.0 += window.start;
        range.end.0 += window.start;
        let edit = self.prepare_source(expected, range, &inserted)?;
        // No host-visible changes, history or clock boundaries before acceptance.
        accept(&edit).map_err(EditorError::Persistence)?;
        let before_selection = self.selection;
        let before_affinity = self.affinity;
        let before_formats = self.pending_formats.clone();
        let mut change = self.apply(&edit);
        self.selection = DisplayRange {
            start: DisplayOffset(display_start + staged.selection.start.0),
            end: DisplayOffset(display_start + staged.selection.end.0),
        };
        self.affinity = staged.affinity;
        self.pending_formats = staged.pending_formats;
        change.selection = self.selection;
        change.affinity = self.affinity;
        change.work.materialized_source_bytes += materialized + edit.inserted.len();
        change.work.parsed_source_bytes += parsed;
        self.undo.push(HistoryGroup {
            entries: vec![HistoryEntry {
                before_selection,
                before_affinity,
                before_formats,
                after_selection: self.selection,
                after_affinity: self.affinity,
                after_formats: self.pending_formats.clone(),
                range: edit.range,
                removed: edit.removed,
                inserted: edit.inserted,
            }],
        });
        self.redo.clear();
        self.typing = None;
        Ok(change)
    }
}
