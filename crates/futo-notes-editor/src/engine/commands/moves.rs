//! Block movement: the lines that lift together, the boundaries between
//! lines where they may land, and the move (#311). A move reorders whole
//! lines and writes nothing else. The one byte that changes place is the
//! note's last line ending: the last line has none, so a block moving to or
//! from the last line trades endings with the line that becomes last.
//!
//! Every line stays its own block in the projection; this is only which
//! lines move together.
use super::super::command::{Command, Edit};
use super::super::edit::Change;
use super::super::{store, Engine};
use crate::lines::{FenceRole, FrontMatterRole, Kind, Line, TableRole};
use crate::{DisplayOffset, DisplayRange, EditorError, Revision, SourceEdit};
use std::ops::Range;

type Accept<'a> = &'a mut dyn FnMut(&SourceEdit) -> Result<(), String>;

/// A line in a run of quote lines: quoted, and not code or a frame.
fn quoted(line: &Line) -> bool {
    line.quote > 0
        && !matches!(
            line.kind,
            Kind::FrontMatter(_) | Kind::Fence { .. } | Kind::Table { .. }
        )
}

impl Engine {
    /// The lines that lift with line `index`: a list item with the lines
    /// under it, a whole run of quote lines, a whole closed code block or
    /// table, else the line alone. A blank line, front matter, and a code
    /// block nothing closes (code to the note's end), alone or under an item,
    /// lift nothing: wherever it went, the lines after it would turn to code.
    pub(crate) fn block_lines(&self, index: usize) -> Option<Range<usize>> {
        let lines = self.lifted_lines(index)?;
        let last = &self.line(lines.end - 1).line.kind;
        let unclosed = lines.end == self.line_count()
            && matches!(
                last,
                Kind::Fence {
                    role: FenceRole::Open | FenceRole::Code,
                    ..
                }
            );
        (!unclosed).then_some(lines)
    }

    fn lifted_lines(&self, index: usize) -> Option<Range<usize>> {
        let line = &self.line(index).line;
        match line.kind {
            Kind::FrontMatter(_) => None,
            _ if quoted(line) => {
                let is_quoted = |at: usize| quoted(&self.line(at).line);
                let mut start = index;
                while start > 0 && is_quoted(start - 1) {
                    start -= 1;
                }
                let mut end = index + 1;
                while end < self.line_count() && is_quoted(end) {
                    end += 1;
                }
                Some(start..end)
            }
            Kind::Blank => None,
            Kind::Fence { .. } => {
                let fence = self.fence_around(index)?;
                Some(fence.open..fence.last() + 1)
            }
            Kind::Table { .. } => {
                let table = self.table_at(index)?;
                Some(table.lines.first()?.index..table.lines.last()?.index + 1)
            }
            Kind::List { .. } => Some(index..self.list_subtree_end(index)),
            _ => Some(index..index + 1),
        }
    }

    /// Whether boundary `at` (above line `at`; the line count is the note's
    /// end) lies inside lines that stay together: front matter (or above
    /// it), a code block, a table or a run of quote lines.
    fn inside_unit(&self, at: usize) -> bool {
        if at == 0 {
            return matches!(self.line(0).line.kind, Kind::FrontMatter(_));
        }
        let above = &self.line(at - 1).line;
        if matches!(
            above.kind,
            Kind::FrontMatter(FrontMatterRole::Open | FrontMatterRole::Body)
        ) {
            return true;
        }
        if at == self.line_count() {
            // Code nothing closes runs to the note's end.
            return matches!(
                above.kind,
                Kind::Fence {
                    role: FenceRole::Open | FenceRole::Code,
                    ..
                }
            );
        }
        let below = &self.line(at).line;
        matches!(
            below.kind,
            Kind::Fence {
                role: FenceRole::Code | FenceRole::Close,
                ..
            } | Kind::Table {
                role: TableRole::Delimiter | TableRole::Row,
                ..
            }
        ) || (quoted(above) && quoted(below))
    }

    /// The display offset of boundary `at`: the start of the line below it.
    fn boundary(&self, at: usize) -> DisplayOffset {
        DisplayOffset(self.store.before(at).display)
    }

    /// The boundaries `block` may land on, in order: every boundary between
    /// lines except the block's own edges and those inside it, those inside
    /// front matter (or above it), a code block, a table or a quote run, and,
    /// unless the block is an unquoted list item or one plain line, those
    /// strictly between two lines of a list (its items and the lines under
    /// them). Of boundaries a renderer cannot tell apart (the same display
    /// offset: the empty last line after a final line ending), the first.
    pub(crate) fn block_slots(&self, block: Range<usize>) -> Vec<usize> {
        let count = self.line_count();
        let first = &self.line(block.start).line;
        let joins_lists = first.quote == 0
            && (matches!(first.kind, Kind::List { .. })
                || (block.len() == 1 && matches!(first.kind, Kind::Plain { .. })));
        let mut slots = Vec::new();
        // Lines before `list_end` belong to a list; `listed` is the line above.
        let mut list_end = 0;
        let mut listed = false;
        for at in 0..=count {
            let here = at < count && {
                let line = &self.line(at).line;
                if at >= list_end && line.quote == 0 && matches!(line.kind, Kind::List { .. }) {
                    list_end = self.list_subtree_end(at);
                }
                at < list_end
            };
            let in_list = listed && here;
            listed = here;
            if (block.start..=block.end).contains(&at)
                || self.inside_unit(at)
                || (in_list && !joins_lists)
                || slots
                    .last()
                    .is_some_and(|&last| self.boundary(last) == self.boundary(at))
            {
                continue;
            }
            slots.push(at);
        }
        slots
    }

    /// The move of `block` to boundary `slot` (one of its slots): the block's
    /// text inserted at the slot and removed where it was, the selection
    /// following its text. Every line it passes, and the block's own, must
    /// read as the same kind of block afterwards.
    fn move_command(&self, block: Range<usize>, slot: usize) -> Command {
        let count = self.line_count();
        let (s, e) = (block.start, block.end);
        let (from, to) = (self.line_start(s), self.line_start(e));
        let text = self.source_slice(from..to);
        let len = self.source_len();
        let (edits, block_start) = if e == count {
            // The last line moves up: it takes the ending of the line above
            // it, which becomes the last line.
            let above = self.line(s - 1);
            let ending = above.ending();
            let at = self.line_start(slot);
            let removed = self.line_start(s - 1) + above.body_len()..len;
            let edits = vec![
                Edit::insert(at, format!("{text}{ending}")),
                Edit::new(removed, ""),
            ];
            (edits, at)
        } else if slot == count {
            // To the end: the line that was last takes the block's ending.
            let ending = self.line(e - 1).ending();
            let body = &text[..text.len() - ending.len()];
            let edits = vec![
                Edit::insert(len, format!("{ending}{body}")),
                Edit::new(from..to, ""),
            ];
            (edits, len - text.len() + ending.len())
        } else {
            let at = self.line_start(slot);
            let start = if slot < s { at } else { at - text.len() };
            (
                vec![Edit::insert(at, text.clone()), Edit::new(from..to, "")],
                start,
            )
        };
        let lines = s.min(slot)..e.max(slot);
        let moved = e - s;
        let place = |index: usize| match index {
            index if block.contains(&index) && slot < s => slot + (index - s),
            index if block.contains(&index) => slot - moved + (index - s),
            index if slot < s => index + moved,
            index => index - moved,
        };
        let same_kind = lines.clone().map(|index| (index, place(index))).collect();
        let mut command = Command::new(edits, lines, 0..0);
        // A caret at the slot's line start stays on that line, below the
        // block; at the note's end it stays on the line the block now follows.
        let after = slot < count;
        let carried = |at: usize| {
            if at >= from && (at < to || (e == count && at == to)) {
                block_start + (at - from)
            } else {
                command.map(at, after)
            }
        };
        let selected = self.source_selection(self.selection);
        let (start, end) = (carried(selected.start), carried(selected.end));
        command.selection = if start <= end {
            start..end
        } else {
            start..start
        };
        command.same_kind = same_kind;
        command
    }

    /// The source line a renderer has at display offset `at`.
    fn line_shown_at(&self, expected: Revision, at: DisplayOffset) -> Result<usize, EditorError> {
        self.check_revision(expected)?;
        self.check_display(at.0)?;
        Ok(self.line_at_display(store::display, at.0).0)
    }

    /// The display extent of the block the line at `at` lifts: from its first
    /// line's start to the start of the line after it.
    pub(crate) fn block_at(
        &self,
        expected: Revision,
        at: DisplayOffset,
    ) -> Result<Option<DisplayRange>, EditorError> {
        let index = self.line_shown_at(expected, at)?;
        Ok(self.block_lines(index).map(|lines| DisplayRange {
            start: self.boundary(lines.start),
            end: self.boundary(lines.end),
        }))
    }

    /// Where the block the line at `at` lifts may land, each slot as the
    /// display offset of the line start below it (the display's end for the
    /// note's end). Empty when the line lifts nothing.
    pub(crate) fn block_slots_at(
        &self,
        expected: Revision,
        at: DisplayOffset,
    ) -> Result<Vec<DisplayOffset>, EditorError> {
        let index = self.line_shown_at(expected, at)?;
        Ok(self.block_lines(index).map_or_else(Vec::new, |lines| {
            self.block_slots(lines)
                .into_iter()
                .map(|slot| self.boundary(slot))
                .collect()
        }))
    }

    /// Move the block the line at `at` lifts to its slot at display offset
    /// `to`, as one action and one Undo step. `None` (nothing changed) when
    /// the line lifts nothing, `to` is not one of its slots, or the guard
    /// cancels the move. Refused while text is marked, as table commands are.
    pub(crate) fn move_block(
        &mut self,
        expected: Revision,
        at: DisplayOffset,
        to: DisplayOffset,
        accept: Accept,
    ) -> Result<Option<Change>, EditorError> {
        let index = self.line_shown_at(expected, at)?;
        self.check_display(to.0)?;
        if self.composition.is_some() {
            return Err(EditorError::CompositionActive);
        }
        let Some(block) = self.block_lines(index) else {
            return Ok(None);
        };
        let Some(slot) = self
            .block_slots(block.clone())
            .into_iter()
            .find(|&slot| self.boundary(slot) == to)
        else {
            return Ok(None);
        };
        let command = self.move_command(block, slot);
        self.run(expected, |_| Ok(Some(command)), accept)
    }
}
