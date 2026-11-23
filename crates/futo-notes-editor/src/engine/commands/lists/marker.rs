//! A list item's marker shows as one unit (`line.rs` rule 7) and acts as its
//! text. Removing exactly the marker, by Backspace just after it, Delete just
//! before it or deleting it selected, takes it off as `lifted` does: the line
//! stays, with a `\` where its text would read as another block. A deletion
//! that joins an item onto the line above drops its marker
//! (`past_joined_marker`).
use super::super::super::command::{Command, Edit};
use super::super::super::line::ATOM_TEXT;
use super::super::super::{store, Engine};
use super::draft::diff;
use super::lifted;
use crate::DisplayRange;

/// Taking an item's marker off: the source edit, and the caret after it.
pub(crate) struct MarkerRemoval {
    pub edit: Edit,
    pub caret: usize,
}

impl Engine {
    /// Backspace with the caret just after an item's marker, Delete with it
    /// just before (`forward`), or either over a selection of exactly the
    /// marker: the marker comes off.
    pub(super) fn marker_key(&self, range: DisplayRange, forward: bool) -> Option<Command> {
        let index = if range.start == range.end {
            self.marker_beside(range.start.0, forward)?
        } else {
            self.selected_marker(range)?
        };
        let removal = self.marker_removal(index)?;
        let caret = removal.caret;
        Some(Command::new(
            vec![removal.edit],
            index..index + 1,
            caret..caret,
        ))
    }

    /// The item whose marker shows just before display offset `at`, or
    /// just after it when `forward`.
    fn marker_beside(&self, at: usize, forward: bool) -> Option<usize> {
        let (index, before) = self.line_at_display(store::display, at);
        let entry = self.line(index);
        let unit = entry.marker_unit()?;
        let start = before.display + entry.to_display(unit.start);
        let edge = if forward {
            start
        } else {
            start + ATOM_TEXT.len()
        };
        (at == edge).then_some(index)
    }

    /// The item whose marker shows at exactly display `range`.
    pub(crate) fn selected_marker(&self, range: DisplayRange) -> Option<usize> {
        if range.end.0 != range.start.0 + ATOM_TEXT.len() {
            return None;
        }
        let (index, before) = self.line_at_display(store::display, range.start.0);
        let entry = self.line(index);
        let unit = entry.marker_unit()?;
        (before.display + entry.to_display(unit.start) == range.start.0).then_some(index)
    }

    /// Whether display `range` holds part of the marker of the item it
    /// starts on.
    pub(crate) fn touches_marker(&self, range: DisplayRange) -> bool {
        let (index, before) = self.line_at_display(store::display, range.start.0);
        let entry = self.line(index);
        entry.marker_unit().is_some_and(|unit| {
            let at = before.display + entry.to_display(unit.start);
            range.start.0 < at + ATOM_TEXT.len() && at < range.end.0
        })
    }

    /// Where a deletion from source `from` to `to` ends: past the marker
    /// (and box) of an item it joins onto the line above, so the item's text
    /// continues that line. A deletion that leaves the marker at its line's
    /// display start joins nothing, and the item stays one.
    pub(crate) fn past_joined_marker(&self, from: usize, to: usize) -> usize {
        let index = self.line_of(to);
        let start = self.line_start(index);
        let entry = self.line(index);
        let Some(unit) = entry.marker_unit() else {
            return to;
        };
        let joined =
            from < start && self.display_of(from) > self.store.before(self.line_of(from)).display;
        if to - start != unit.start || !joined {
            return to;
        }
        start + unit.end
    }

    /// Item `index` with its marker and box taken off; the caret goes where
    /// its text now starts.
    pub(crate) fn marker_removal(&self, index: usize) -> Option<MarkerRemoval> {
        let entry = self.line(index);
        let (written, prefix, _) = lifted(entry.body(), &entry.line, &entry.carry);
        let start = self.line_start(index);
        let edit = diff(start, entry.body(), &written)?;
        Some(MarkerRemoval {
            edit,
            caret: start + prefix,
        })
    }
}
