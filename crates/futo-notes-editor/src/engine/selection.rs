//! Selection and caret movement: where a caret may stand, and moving it
//! one extended grapheme.
use super::line::Entry;
use super::{store, Engine};
use crate::{
    Affinity, CaretDirection, DisplayOffset, DisplayRange, EditorError, Revision, SelectionChange,
};
use unicode_segmentation::GraphemeCursor;

impl Engine {
    // ---- Selection and movement ----

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

    pub fn select_with_affinity(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        affinity: Affinity,
    ) -> Result<SelectionChange, EditorError> {
        self.check_revision(expected)?;
        self.check_display_range(range)?;
        let range = self.outside_metadata(self.outside_crlf(range));
        if self.composition.is_none() && (self.selection != range || self.affinity != affinity) {
            self.typing = None;
            self.formats = None;
            self.pin = None;
            self.selection = range;
            self.affinity = affinity;
        }
        Ok(SelectionChange {
            revision: self.revision,
            selection: self.selection,
            affinity: self.affinity,
        })
    }

    /// Move one extended grapheme, collapsing a selection to its edge first.
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
            from
        };
        let at = DisplayOffset(to);
        self.select_with_affinity(
            expected,
            DisplayRange { start: at, end: at },
            match direction {
                CaretDirection::Forward => Affinity::Backward,
                CaretDirection::Backward => Affinity::Forward,
            },
        )
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
