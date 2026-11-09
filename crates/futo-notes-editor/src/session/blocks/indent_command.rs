//! The toolbar's Indent and Outdent buttons. In a list they nest an item under
//! the item above it and un-nest it one level (the generic list edit, with its
//! renumbering); in a code block they add and remove a tab on the code lines.
//! Everywhere else there is nothing sensible to do and they are disabled.
use super::*;

/// Columns one Outdent of a list item's tab removes at most.
const TAB_WIDTH: usize = 4;

impl EditorSession {
    /// Indent or Outdent of the item or code lines `range` touches, as one
    /// exact Undo action; nothing (no Undo step) where the button is disabled.
    pub(in crate::session) fn indent_command(
        &mut self,
        expected: Revision,
        mut range: DisplayRange,
        outdent: bool,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.check_revision(expected)?;
        if self.composition().is_some() {
            return self.command_during_composition(
                expected,
                range,
                accept,
                |staged, local, accept| {
                    staged.indent_command(staged.revision(), local, outdent, accept)
                },
            );
        }
        self.validate_range(range)?;
        range = self.body_range(range)?;
        let state = self.toolbar_state_at(range);
        if !(if outdent {
            state.can_outdent
        } else {
            state.can_indent
        }) {
            return Ok(None);
        }
        if self
            .selected_block_lines(range)
            .first()
            .is_some_and(|line| line.code)
        {
            return self.fence_indent(expected, range, outdent, false, accept);
        }
        let command = if outdent {
            BlockCommand::Outdent
        } else {
            BlockCommand::Indent
        };
        match self.indent_list(expected, range, command, accept) {
            // A shape the list edit cannot respell is still an item: it moves
            // by a plain tab after its quote markers.
            Err(EditorError::UnrepresentableFormat) => {
                self.item_tab(expected, range, outdent, accept)
            }
            planned => planned,
        }
    }

    /// One tab added at, or one tab stop removed from, the start of each
    /// touched list line, after the quote markers before the list.
    fn item_tab(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        outdent: bool,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        // (where the whitespace is, bytes of it to remove)
        let edits: Vec<(usize, usize)> = self
            .selected_block_lines(range)
            .iter()
            .filter(|line| !line.code)
            .filter_map(|line| {
                let list = line.list.as_ref()?;
                let end = line.source.end.min(self.source.len_bytes());
                let text = self.source.byte_slice(line.source.start..end).to_string();
                let text = text.trim_end_matches(['\r', '\n']);
                let at = super::indent_source::quote_prefix_end(text, list.quote_depth);
                let removed = if outdent {
                    tab_stop_width(&text[at..], at, text)
                } else {
                    0
                };
                (!outdent || removed > 0).then_some((line.source.start + at, removed))
            })
            .collect();
        let (Some(&(first, _)), Some(&(last, last_removed))) = (edits.first(), edits.last()) else {
            return Ok(None);
        };
        let mut output = String::new();
        let mut copied = first;
        for &(at, removed) in &edits {
            output.push_str(&self.source.byte_slice(copied..at).to_string());
            if !outdent {
                output.push('\t');
            }
            copied = at + removed;
        }
        let map = |position: usize| {
            let mut result = position;
            for &(at, removed) in &edits {
                if outdent {
                    if position >= at + removed {
                        result -= removed;
                    } else if position > at {
                        result -= position - at;
                    }
                } else if position >= at {
                    result += 1;
                }
            }
            result
        };
        // Each end rests inside a touched line, on the side of any hidden
        // syntax (a list marker) that line's text is on.
        let (low, high) = self.projection.source_bounds(range.start.0);
        let (end_low, _) = self.projection.source_bounds(range.end.0);
        let len = self.source.len_bytes();
        let inside = (last..len)
            .find(|&index| self.source.byte(index) == b'\n')
            .unwrap_or(len);
        let start = if high <= inside { high } else { low };
        let selection = if range.start == range.end {
            BlockSelection::Source(map(start))
        } else {
            BlockSelection::SourceRange(map(start)..map(end_low.max(start)))
        };
        let footprint = first..last + last_removed;
        self.commit_block_edit(expected, footprint, &output, selection, None, accept)
            .map(Some)
    }
}

/// Bytes one Outdent removes from the whitespace `lead` that starts at byte
/// `at` of `line`: up to and including the first tab inside one tab stop, else
/// up to a tab stop of spaces.
fn tab_stop_width(lead: &str, at: usize, line: &str) -> usize {
    let start = crate::inline::columns(&line[..at], 0);
    let mut width = 0;
    for byte in lead.bytes() {
        let column = crate::inline::columns(&lead[..width], start);
        match byte {
            b'\t' if column < start + TAB_WIDTH => return width + 1,
            b' ' if column < start + TAB_WIDTH => width += 1,
            _ => break,
        }
    }
    width
}
