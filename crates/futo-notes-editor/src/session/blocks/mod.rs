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
mod keys;
mod list_commands;
mod list_join;
mod list_styles;
mod list_typing;
mod lists;
mod split;
mod transaction;
mod typing;

enum BlockSelection {
    Display(DisplayRange),
    Source(usize),
    SourceRange(std::ops::Range<usize>),
    Exact {
        selection: crate::history::ExactSelection,
        window: std::ops::Range<usize>,
    },
}

impl EditorSession {
    fn carry_block_state(
        &mut self,
        change: &mut ViewChange,
        formats: Option<Vec<InlineFormat>>,
        affinity: Affinity,
    ) {
        self.pending_formats = formats;
        self.affinity = affinity;
        change.affinity = affinity;
        let (source, work) = self.capture_history_selection();
        change.work.link_metadata_items += work;
        let after = self.undo.last_mut().unwrap().entries.last_mut().unwrap();
        after.after_formats = self.pending_formats.clone();
        after.after_affinity = affinity;
        after.after_source = source;
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
        self.commit_block_with_pending(expected, range, inserted, selection, input, None, accept)
    }

    fn commit_block_with_pending(
        &mut self,
        expected: Revision,
        range: std::ops::Range<usize>,
        inserted: &str,
        selection: BlockSelection,
        input: Option<HistoryInput<'_>>,
        pending: Option<crate::inline::PendingLinks>,
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
        self.commit_prepared_block_with_pending(edit, selection, input, pending, accept)
    }

    fn commit_prepared_block_with_pending(
        &mut self,
        edit: SourceEdit,
        selection: BlockSelection,
        input: Option<HistoryInput<'_>>,
        pending: Option<crate::inline::PendingLinks>,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<ViewChange, EditorError> {
        let before_links = self.projection.pending_for_source_edit(edit.range);
        let (validation, validated_selection) = if let BlockSelection::Exact { selection, window } =
            &selection
        {
            if pending.as_ref().is_some_and(|pending| {
                pending.window
                    != (window.start..window.end - edit.removed.len() + edit.inserted.len())
            }) {
                return Err(EditorError::UnrepresentableFormat);
            }
            let (preview, selected) = self.preview_exact_edit(
                &edit,
                window.clone(),
                pending.as_ref(),
                true,
                &[],
                Some(*selection),
            )?;
            (preview.work, selected)
        } else if let Some(pending) = &pending {
            if pending.window != (edit.range.start.0..edit.range.start.0 + edit.inserted.len()) {
                return Err(EditorError::UnrepresentableFormat);
            }
            (
                self.preview_pending_edit(&edit, before_links.window.clone(), pending, true, &[])?
                    .work,
                None,
            )
        } else {
            (EditWork::default(), None)
        };
        accept(&edit).map_err(EditorError::Persistence)?;
        let before_selection = self.selection;
        let (before_source, before_source_work) = self.capture_history_selection();
        let before_affinity = self.affinity;
        let before_formats = self.pending_formats.clone();
        let mut change = self.apply(&edit);
        let EditWork {
            materialized_source_bytes,
            inserted_bytes: _,
            parsed_source_bytes,
            link_metadata_items,
            link_copied_bytes,
        } = validation;
        change.work.materialized_source_bytes += materialized_source_bytes;
        change.work.parsed_source_bytes += parsed_source_bytes;
        change.work.link_metadata_items += link_metadata_items;
        change.work.link_copied_bytes += link_copied_bytes;
        if let Some(pending) = &pending {
            self.adopt_stage_pending(pending, &mut change, staging::PendingHistory::Prepared);
        }
        self.selection = match selection {
            BlockSelection::Display(selection) => selection,
            BlockSelection::Exact { .. } => {
                validated_selection.expect("selection was validated before acceptance")
            }
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
        change.work.materialized_source_bytes += edit.inserted.len();
        let (after_source, after_source_work) = self.capture_history_selection();
        change.work.link_metadata_items += before_source_work + after_source_work;
        let after_links = self
            .projection
            .pending_links(before_links.after_window(&edit));
        change.work.link_metadata_items += before_links.work + after_links.work;
        self.record_input_history(
            HistoryEntry {
                before_source,
                after_source,
                before_selection,
                before_affinity,
                before_formats,
                before_links,
                after_selection: self.selection,
                after_affinity: self.affinity,
                after_formats: None,
                after_links,
                range: edit.range,
                removed: edit.removed,
                inserted: edit.inserted,
            },
            input,
        );
        Ok(change)
    }
}
