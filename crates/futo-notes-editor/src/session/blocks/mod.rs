//! Shared block commands. Hosts supply visible ranges and never spell Markdown.
use super::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BlockCommand {
    /// Zero selects plain paragraph text; one through six select a heading.
    Heading(u8),
    Quote,
    Indent,
    Outdent,
    Divider,
}

mod commands;
mod divider;
mod keys;
mod typing;

impl EditorSession {
    fn commit_block_edit(
        &mut self,
        expected: Revision,
        range: std::ops::Range<usize>,
        inserted: &str,
        selection: Option<DisplayRange>,
        source_caret: Option<usize>,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<ViewChange, EditorError> {
        let edit = self.prepare_source(
            expected,
            SourceRange {
                start: SourceOffset(range.start),
                end: SourceOffset(range.end),
            },
            inserted,
        )?;
        accept(&edit).map_err(EditorError::Persistence)?;
        let before_selection = self.selection;
        let before_affinity = self.affinity;
        let before_formats = self.pending_formats.clone();
        let mut change = self.apply(&edit);
        if let Some(selection) = selection {
            self.selection = selection;
        }
        if let Some(source) = source_caret {
            let at = DisplayOffset(self.projection.display_at(source));
            self.selection = DisplayRange { start: at, end: at };
        }
        self.pending_formats = None;
        change.selection = self.selection;
        change.work.materialized_source_bytes += inserted.len();
        self.undo.push(HistoryGroup {
            entries: vec![HistoryEntry {
                before_selection,
                before_affinity,
                before_formats,
                after_selection: self.selection,
                after_affinity: self.affinity,
                after_formats: None,
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
