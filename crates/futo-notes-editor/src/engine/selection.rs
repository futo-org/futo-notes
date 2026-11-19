//! Selection and caret movement: where a caret may stand, and moving it
//! one extended grapheme.
use super::line::Entry;
use super::{store, Engine};
use crate::backspace_length::backspace_length;
use crate::{
    Affinity, CaretDirection, DisplayOffset, DisplayRange, EditorError, Revision, SelectionChange,
};
use std::ops::Range;
use unicode_segmentation::GraphemeCursor;

impl Engine {
    // ---- Selection and movement ----

    /// The selection in source offsets: a collapsed caret where it maps,
    /// else from the first visible source after its start to the last
    /// before its end.
    pub(crate) fn source_selection(&self, range: DisplayRange) -> Range<usize> {
        if range.start == range.end {
            if range == self.selection {
                let at = self.caret_source();
                return at..at;
            }
            let (lo, hi) = self.source_bounds(range.start.0);
            let at = if self.affinity == Affinity::Backward {
                lo
            } else {
                hi
            };
            return at..at;
        }
        let start = self.source_bounds(range.start.0).1;
        let end = self.source_bounds(range.end.0).0.max(start);
        start..end
    }

    /// A caret between a CRLF's CR and LF acts at the end of its line, and a
    /// selection end there widens over the whole line break.
    pub(super) fn outside_crlf(&self, mut range: DisplayRange) -> DisplayRange {
        let inside = |at: usize| {
            let (index, before) = self.line_at_display(store::display, at);
            let entry = self.store.get(index);
            entry.view.ending
                && entry.ending() == "\r\n"
                && at - before.display == entry.shown_len() + 1
        };
        let collapsed = range.start == range.end;
        if inside(range.start.0) {
            range.start.0 -= 1;
        }
        if inside(range.end.0) {
            range.end.0 = if collapsed {
                range.start.0
            } else {
                range.end.0 + 1
            };
        }
        range
    }

    pub fn select(
        &mut self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<SelectionChange, EditorError> {
        let affinity = if range.start.0 == 0 {
            Affinity::Forward
        } else {
            Affinity::Backward
        };
        self.select_with_affinity(expected, range, affinity)
    }

    /// A host's selection. The same range again (a host's echo of the
    /// engine's own selection) keeps a selected block, and with the same
    /// affinity keeps the caret where it maps (a language caret included).
    pub fn select_with_affinity(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        affinity: Affinity,
    ) -> Result<SelectionChange, EditorError> {
        self.check_revision(expected)?;
        self.check_display_range(range)?;
        let range = self.outside_metadata(self.outside_crlf(range));
        if self.composition.is_none() && self.selection != range {
            self.block_selected = false;
        }
        if self.composition.is_none() && (self.selection != range || self.affinity != affinity) {
            self.typing = None;
            self.formats = None;
            self.pin = None;
            self.selection = range;
            self.affinity = affinity;
        }
        Ok(self.selection_change())
    }

    /// The user placed this selection: as `select_with_affinity`, but the
    /// same range also ends a selected block and a language caret, leaving
    /// an ordinary selection (on a block, a caret on its first code line).
    /// It is fitted out of images as input is (`outside_images`), off table
    /// delimiter rows and out of a row's pipes and padding
    /// (`placed_in_tables`).
    pub fn place_selection(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        affinity: Affinity,
    ) -> Result<SelectionChange, EditorError> {
        self.check_revision(expected)?;
        self.check_display_range(range)?;
        let range = self.placed_in_tables(self.outside_images(range));
        if self.composition.is_none() {
            self.block_selected = false;
            self.pin = None;
            self.typing = None;
            self.formats = None;
        }
        self.select_with_affinity(expected, range, affinity)
    }

    pub(crate) fn selection_change(&self) -> SelectionChange {
        SelectionChange {
            revision: self.revision,
            selection: self.selection,
            selected_block: self.selected_block(),
            writes_language: self.writes_language(),
            writes_delimiter_row: self.writes_delimiter_row(),
            affinity: self.affinity,
        }
    }

    /// Move one extended grapheme, collapsing a selection to its edge first;
    /// a step onto a table's delimiter row goes past it (`past_delimiter_row`).
    pub fn move_caret(
        &mut self,
        expected: Revision,
        direction: CaretDirection,
    ) -> Result<SelectionChange, EditorError> {
        self.check_revision(expected)?;
        let selection = self.selection;
        let from = match direction {
            CaretDirection::Backward => selection.start.0,
            CaretDirection::Forward => selection.end.0,
        };
        let to = if selection.start == selection.end {
            self.grapheme_stop(from, direction)
        } else {
            self.grapheme_edge(from, direction)
        };
        let at = DisplayOffset(self.past_delimiter_row(to, direction));
        self.select_with_affinity(
            expected,
            DisplayRange { start: at, end: at },
            match direction {
                CaretDirection::Forward => Affinity::Backward,
                CaretDirection::Backward => Affinity::Forward,
            },
        )
    }

    /// Display offset `at` if it is a grapheme boundary, else the boundary
    /// of its grapheme in `direction`: a selection collapsed to an edge
    /// that a native control left inside a cluster never leaves the caret
    /// inside it.
    pub(crate) fn grapheme_edge(&self, at: usize, direction: CaretDirection) -> usize {
        if at == 0 || at == self.display_len() {
            return at;
        }
        let start = self.grapheme_stop(at, CaretDirection::Backward);
        let end = self.grapheme_stop(start, CaretDirection::Forward);
        if end <= at {
            return at;
        }
        match direction {
            CaretDirection::Backward => start,
            CaretDirection::Forward => end,
        }
    }

    /// What Backspace or Delete at a collapsed caret at display offset `at`
    /// removes: one extended grapheme forward, and backward what
    /// `backspace_length` takes of the grapheme before it.
    pub(crate) fn caret_deletion(&self, at: usize, direction: CaretDirection) -> DisplayRange {
        let stop = self.grapheme_stop(at, direction);
        if direction == CaretDirection::Forward {
            return DisplayRange {
                start: DisplayOffset(at),
                end: DisplayOffset(stop),
            };
        }
        DisplayRange {
            start: DisplayOffset(at - backspace_length(&self.display_slice(stop..at))),
            end: DisplayOffset(at),
        }
    }

    /// The next extended grapheme boundary from display offset `at`. Graphemes
    /// never cross a line break, so the lines around `at` are enough context.
    pub(crate) fn grapheme_stop(&self, at: usize, direction: CaretDirection) -> usize {
        let total = self.display_len();
        if (direction == CaretDirection::Backward && at == 0)
            || (direction == CaretDirection::Forward && at == total)
        {
            return at;
        }
        let (index, _) = self.line_at_display(store::display, at);
        let shown = |index: usize| self.store.get(index).size.display > 0;
        let mut first = index;
        while first > 0 {
            first -= 1;
            if shown(first) {
                break;
            }
        }
        let count = self.store.len();
        let mut last = index;
        while last + 1 < count {
            last += 1;
            if shown(last) {
                break;
            }
        }
        let base = self.store.before(first).display;
        let context: String = self
            .store
            .iter_from(first)
            .take(last - first + 1)
            .map(Entry::display)
            .collect();
        let mut cursor = GraphemeCursor::new(at - base, context.len(), true);
        let stop = match direction {
            CaretDirection::Backward => cursor.prev_boundary(&context, 0),
            CaretDirection::Forward => cursor.next_boundary(&context, 0),
        };
        stop.ok().flatten().map_or(at, |stop| base + stop)
    }
}
