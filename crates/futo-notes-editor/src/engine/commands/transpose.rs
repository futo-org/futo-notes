//! Transpose (Ctrl+T on Apple, AppKit's `transpose:`).
use super::super::command::{Command, Edit};
use super::super::Engine;
use crate::{CaretDirection, DisplayOffset, DisplayRange, EditorError, InputAction};

impl Engine {
    /// The graphemes on either side of a caret, or the two before it at a line's end,
    /// swapped as typing them over the pair would land, the caret after them. A
    /// selection, a line's start, a lone character on a line and a pair holding
    /// a list item's marker are no edit.
    pub(crate) fn transpose_command(
        &self,
        range: DisplayRange,
    ) -> Result<Option<Command>, EditorError> {
        let range = self.outside_crlf(range);
        if range.start != range.end {
            return Ok(None);
        }
        let line = self.display_line(range.start.0);
        let caret = if range.start.0 == line.end {
            self.grapheme_stop(line.end, CaretDirection::Backward)
        } else {
            range.start.0
        };
        let start = self.grapheme_stop(caret, CaretDirection::Backward);
        let end = self.grapheme_stop(caret, CaretDirection::Forward);
        let pair = DisplayRange {
            start: DisplayOffset(start),
            end: DisplayOffset(end),
        };
        if start < line.start
            || start == caret
            || end == caret
            || self.touches_metadata(pair)
            || self.touches_marker(pair)
        {
            return Ok(None);
        }
        let swapped = self.display_slice(caret..end) + &self.display_slice(start..caret);
        let plan = self.plan_input(pair, &swapped, InputAction::Isolated);
        let first = self.line_of(plan.range.start);
        let last = self.line_of(plan.range.end);
        Ok(Some(Command::new(
            vec![Edit::new(plan.range, plan.inserted)],
            first..last + 1,
            plan.caret..plan.caret,
        )))
    }
}
