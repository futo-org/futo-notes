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
    ToggleTask,
    BulletList,
    OrderedList,
    TaskList,
    CodeBlock,
}

mod code_command;
mod commands;
mod content;
mod divider;
mod fence_tab;
mod fences;
mod indent_source;
mod keys;
mod list_commands;
mod list_indent;
mod list_join;
mod list_lift;
mod list_lift_crossquote;
mod list_lift_plan;
mod list_styles;
mod list_targets;
mod list_typing;
mod lists;
mod transaction;
mod typing;

enum BlockSelection {
    Display(DisplayRange),
    Source(usize),
    SourceRange(std::ops::Range<usize>),
}

impl EditorSession {
    /// Formatting includes a next item's first text boundary; replacement
    /// queries keep their half-open scope. The projection owns this rule once.
    fn selected_block_lines(&self, range: DisplayRange) -> Vec<crate::inline::blocks::BlockLine> {
        self.projection.format_block_lines(range)
    }

    fn selected_list_lines(
        &self,
        range: DisplayRange,
    ) -> Vec<crate::inline::blocks::ListCommandLine> {
        self.projection.list_command_lines(range)
    }

    fn carry_block_state(
        &mut self,
        change: &mut ViewChange,
        formats: Option<Vec<InlineFormat>>,
        affinity: Affinity,
    ) {
        self.pending_formats = formats;
        self.affinity = affinity;
        change.affinity = affinity;
        let after = self.undo.last_mut().unwrap().entries.last_mut().unwrap();
        after.after_formats = self.pending_formats.clone();
        after.after_affinity = affinity;
    }

    fn commit_block_edit(
        &mut self,
        expected: Revision,
        range: std::ops::Range<usize>,
        inserted: &str,
        selection: BlockSelection,
        input: Option<HistoryInput<'_>>,
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
        self.selection = match selection {
            BlockSelection::Display(selection) => selection,
            BlockSelection::SourceRange(range) => DisplayRange {
                start: DisplayOffset(self.projection.display_at(range.start)),
                end: DisplayOffset(self.projection.display_at(range.end)),
            },
            BlockSelection::Source(source) => {
                let at = DisplayOffset(self.projection.display_at(source));
                DisplayRange { start: at, end: at }
            }
        };
        self.pending_formats = None;
        change.selection = self.selection;
        change.work.materialized_source_bytes += inserted.len();
        self.record_input_history(
            HistoryEntry {
                before_selection,
                before_affinity,
                before_formats,
                after_selection: self.selection,
                after_affinity: self.affinity,
                after_formats: None,
                range: edit.range,
                removed: edit.removed,
                inserted: edit.inserted,
            },
            input,
        );
        Ok(change)
    }
}
