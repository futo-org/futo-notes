//! The selection across a move: one rule for a block's lines and a lifted
//! image.
use super::super::super::command::Command;
use super::super::super::{store, Engine};
use std::ops::Range;

impl Engine {
    /// The selection after `command` moves source `moved` (offsets before
    /// it), each offset in it landing at `travel` (after it). A selection inside the moved text, exactly it or part
    /// of it, travels with it. Any other keeps the text it covered: an end
    /// in the moved text stays where the text before it ends, a start there
    /// goes where the text after it starts, and moved text landing at either
    /// edge stays outside. Its ends are read from the display, so a hidden
    /// marker or line sharing a line start's display position (`# `, `- `,
    /// `> `, a fence) never counts as covered. A collapsed caret lands at
    /// `caret`.
    pub(super) fn moved_selection(
        &self,
        command: &Command,
        moved: Range<usize>,
        travel: impl Fn(usize) -> usize,
        caret: impl Fn(usize) -> usize,
    ) -> Range<usize> {
        let selection = self.selection;
        if selection.start == selection.end {
            let at = caret(self.source_selection(selection).start);
            return at..at;
        }
        let start = self.source_span(selection.start.0).1;
        let end = self.lowest_source(selection.end.0).max(start);
        if moved.start <= start && end <= moved.end {
            return travel(start)..travel(end);
        }
        let start = if moved.contains(&start) {
            command.map(moved.end, true)
        } else {
            command.map(start, true)
        };
        let end = if moved.start < end && end <= moved.end {
            command.map(moved.start, false)
        } else {
            command.map(end, false)
        };
        start..end.max(start)
    }

    /// The lowest source offset that shows at display offset `at`: at a
    /// line's display start, the start of the first line there, before the
    /// hidden lines (a fence) and markers that show nothing.
    fn lowest_source(&self, at: usize) -> usize {
        let (mut index, before) = self.line_at_display(store::display, at);
        if at != before.display {
            return self.source_span(at).0;
        }
        while index > 0 && self.store.before(index - 1).display == at {
            index -= 1;
        }
        self.line_start(index)
    }
}
