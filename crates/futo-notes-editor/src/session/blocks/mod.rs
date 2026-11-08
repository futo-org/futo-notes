//! Shared block commands. Hosts supply visible ranges and never spell Markdown.
use super::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BlockCommand {
    /// Zero selects plain paragraph text; one through six select a heading.
    Heading(u8),
    /// Text-first toolbar: selecting the common current level restores Text.
    ToggleHeading(u8),
    Quote,
    Indent,
    Outdent,
    Divider,
    ToggleTask,
    BulletList,
    OrderedList,
    TaskList,
    CodeBlock,
    /// Text-first toolbar: one fence around all selected physical lines.
    WrapCodeBlock,
}

mod clipboard;
mod code_command;
mod commands;
mod content;
mod divider;
mod fence_tab;
mod fences;
mod indent_source;
mod keys;
mod line_endings;
mod list_edit;
mod list_join;
mod list_typing;
mod lists;
mod literal_typing;
mod physical_layout;
mod split;
mod tables;
pub(super) use tables::CellInput;
mod transaction;
mod typing;

/// The heading level every selected content line carries, whatever quote
/// depth or block kind it sits in; front matter, which no heading command
/// reaches, is set aside. This is the toolbar's heading state and the toggle's
/// own test for taking the level off.
pub(in crate::session) fn common_heading(
    lines: &[&crate::inline::blocks::BlockLine],
) -> Option<u8> {
    let mut body = lines.iter().filter(|line| !line.metadata);
    let first = body.next()?.heading;
    body.all(|line| line.heading == first).then_some(first)
}

/// Every selected prose line sits in a quote, whatever block it is (paragraph,
/// heading or list item inside the quote), and at least one is. This is the
/// toolbar's active Quote state and the command's own test, so choosing Quote
/// then takes a level off and keeps each block. A quote nested inside a list item is not offered: that
/// outdent is outside the generic list path.
pub(in crate::session) fn all_quoted(lines: &[&crate::inline::blocks::BlockLine]) -> bool {
    let mut prose = lines
        .iter()
        .filter(|line| !line.code && !line.divider && !line.metadata)
        .peekable();
    prose.peek().is_some()
        && prose.all(|line| {
            line.quote_depth > 0
                && line
                    .list
                    .as_ref()
                    .is_none_or(|list| list.quote_depth == line.quote_depth)
        })
}

enum BlockSelection {
    Display(DisplayRange),
    Source(usize),
    SourceWithRetiredAtoms {
        source: usize,
        atoms: Vec<crate::inline::guarded_words::ValidationAtom>,
    },
    SourceRange(std::ops::Range<usize>),
    Exact {
        selection: crate::history::ExactSelection,
        window: std::ops::Range<usize>,
    },
}

impl EditorSession {
    /// Formatting includes a next item's first text boundary; replacement
    /// queries keep their half-open scope. The projection owns this rule once.
    fn selected_block_lines(&self, range: DisplayRange) -> Vec<crate::inline::blocks::BlockLine> {
        self.projection.format_block_lines(range)
    }

    /// A blank line: only spaces or tabs after its container prefixes, outside
    /// code, front matter and raw HTML, and not an item's own first row.
    pub(in crate::session) fn is_blank_line(
        &self,
        line: &crate::inline::blocks::BlockLine,
    ) -> bool {
        !line.code
            && !line.metadata
            && !line.html
            && !line.divider
            && line.heading == 0
            && line.list.as_ref().is_none_or(|list| !list.first)
            && self
                .source
                .byte_slice(line.content.clone())
                .chars()
                .all(|ch| matches!(ch, ' ' | '\t'))
    }

    /// The selected lines a block format reads and changes. Blank lines are
    /// aside, as for inline formats, unless the selection holds nothing else:
    /// a caret on a blank line still touches it.
    pub(in crate::session) fn content_block_lines<'a>(
        &self,
        lines: &'a [crate::inline::blocks::BlockLine],
    ) -> Vec<&'a crate::inline::blocks::BlockLine> {
        if lines.iter().all(|line| self.is_blank_line(line)) {
            return lines.iter().collect();
        }
        lines
            .iter()
            .filter(|line| !self.is_blank_line(line))
            .collect()
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
        let staged = pending.as_ref().map(|pending| &pending.window);
        let before_links = self.projection.pending_for_staged_edit(&edit, staged);
        let (validation, validated_selection) =
            if let BlockSelection::SourceWithRetiredAtoms { atoms, .. } = &selection {
                let window = before_links.window.clone();
                let (mut preview, initial) =
                    self.with_exact_candidate(&edit, window.clone(), |staged| {
                        let mut preview = self.validate_exact_candidate(
                            staged,
                            window.clone(),
                            pending.as_ref(),
                            true,
                            &[],
                            super::pending::SelectionTargets {
                                selections: &[],
                                links: &[],
                                emit: &mut |_| {},
                            },
                        )?;
                        preview.work.link_metadata_items += staged
                            .projection
                            .validate_split_atoms(atoms, window.start)?;
                        Ok(preview)
                    })?;
                super::accumulate_planning_work(&mut preview.work, initial);
                (preview.work, None)
            } else if let BlockSelection::Exact { selection, window } = &selection {
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
                if pending.window.start < before_links.window.start
                    || pending.window.end > before_links.after_window(&edit).end
                {
                    return Err(EditorError::UnrepresentableFormat);
                }
                if pending.has_fields() || before_links.has_words() {
                    (
                        self.preview_pending_edit(
                            &edit,
                            before_links.window.clone(),
                            pending,
                            true,
                            &[],
                        )?
                        .work,
                        None,
                    )
                } else {
                    (EditWork::default(), None)
                }
            } else if before_links.has_words() {
                let mut retained = crate::inline::PendingLinks {
                    window: before_links.after_window(&edit),
                    ranges: Vec::new(),
                    delimiters: Vec::new(),
                    guarded_words: Vec::new(),
                    typed_inputs: Vec::new(),
                    work: 0,
                };
                retained.prepare_guards(&before_links, &edit, None)?;
                retained.prepare_typed_inputs(&before_links, &edit, None)?;
                let mut work =
                    self.validate_stage_guards(&edit, before_links.window.clone(), &retained)?;
                work.link_metadata_items += retained.work;
                (work, None)
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
            self.adopt_stage_pending(pending, &mut change);
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
            BlockSelection::Source(source)
            | BlockSelection::SourceWithRetiredAtoms { source, .. } => {
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
