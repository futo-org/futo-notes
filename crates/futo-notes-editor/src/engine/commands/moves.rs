//! Block movement: the lines that lift together, the boundaries between
//! lines where they may land, and the move (#311). A move reorders whole
//! lines and writes nothing else. The one byte that changes place is the
//! note's last line ending: the last line has none, so a block moving to or
//! from the last line trades endings with the line that becomes last.
//!
//! An image that shares its line with other content lifts alone: its source
//! leaves the line, nothing else there changes, and it lands as a line of
//! its own.
//!
//! Every line stays its own block in the projection; this is only which
//! lines move together.
use super::super::command::{Command, Edit};
use super::super::edit::Change;
use super::super::{store, Engine};
use super::images::inside_another_mark;
use crate::lines::{block, FenceRole, FrontMatterRole, Kind, Line, SpanKind, TableRole};
use crate::{DisplayOffset, DisplayRange, EditorError, Revision, SourceEdit};
use std::ops::Range;

mod selection;

type Accept<'a> = &'a mut dyn FnMut(&SourceEdit) -> Result<(), String>;

/// A line in a run of quote lines: quoted, and not code or a frame.
fn quoted(line: &Line) -> bool {
    line.quote > 0
        && !matches!(
            line.kind,
            Kind::FrontMatter(_) | Kind::Fence { .. } | Kind::Table { .. }
        )
}

/// What a press lifts: whole lines, or one image out of its line.
enum Lifted {
    Lines(Range<usize>),
    /// The image at line-relative source `span` of line `line`.
    Image {
        line: usize,
        span: Range<usize>,
    },
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
    /// lines except the block's own edges and those inside it, and the
    /// boundaries no block lands on (`slots`). Lists take the block when it
    /// is an unquoted list item or one plain line. None that a renderer
    /// cannot tell from the block's own edges.
    pub(crate) fn block_slots(&self, block: Range<usize>) -> Vec<usize> {
        let first = &self.line(block.start).line;
        let joins_lists = first.quote == 0
            && (matches!(first.kind, Kind::List { .. })
                || (block.len() == 1 && matches!(first.kind, Kind::Plain { .. })));
        let edges = [self.boundary(block.start), self.boundary(block.end)];
        self.slots(joins_lists, |at| {
            (block.start..=block.end).contains(&at) || edges.contains(&self.boundary(at))
        })
    }

    /// The boundaries a lifted image may land on: a plain line's, its own
    /// line's two edges included, since a drop there splits the image from
    /// that line's other content.
    fn image_slots(&self) -> Vec<usize> {
        self.slots(true, |_| false)
    }

    /// Every boundary between lines, in order, except those `own` rules
    /// out and those inside front matter (or above it), a code block, a
    /// table or a quote run, and, unless `joins_lists`, those strictly
    /// between two lines of a list (its items and the lines under them). Of
    /// boundaries a renderer cannot tell apart (the same display offset: the
    /// empty last line after a final line ending), the first.
    fn slots(&self, joins_lists: bool, own: impl Fn(usize) -> bool) -> Vec<usize> {
        let count = self.line_count();
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
            if own(at)
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

    /// The image under display offset `at` on line `index`, as a
    /// line-relative source span, when it lifts alone: the line has content
    /// besides it (text or another image; markers and whitespace do not
    /// count), no other mark holds it, and the line is no quote, table, code
    /// or front matter line.
    fn image_lifted(&self, index: usize, at: DisplayOffset) -> Option<Range<usize>> {
        let entry = self.line(index);
        let line = &entry.line;
        if line.quote > 0
            || !matches!(
                line.kind,
                Kind::Plain { .. } | Kind::Heading { .. } | Kind::List { .. }
            )
        {
            return None;
        }
        let before = self.store.before(index).display;
        let span = entry.spans.iter().find(|span| {
            matches!(span.kind, SpanKind::Image { .. })
                && (before + entry.to_display(span.range.start)
                    ..before + entry.to_display(span.range.end))
                    .contains(&at.0)
        })?;
        let content = &entry.text[line.content.clone()];
        let (start, end) = (
            span.range.start - line.content.start,
            span.range.end - line.content.start,
        );
        let alone = content[..start].trim().is_empty() && content[end..].trim().is_empty();
        (!inside_another_mark(&entry.spans, &span.range) && !alone).then(|| span.range.clone())
    }

    /// What a press at display offset `at` lifts.
    fn lifted_at(
        &self,
        expected: Revision,
        at: DisplayOffset,
    ) -> Result<Option<Lifted>, EditorError> {
        let index = self.line_shown_at(expected, at)?;
        Ok(match self.image_lifted(index, at) {
            Some(span) => Some(Lifted::Image { line: index, span }),
            None => self.block_lines(index).map(Lifted::Lines),
        })
    }

    /// The boundaries what is lifted may land on.
    fn slots_for(&self, lifted: &Lifted) -> Vec<usize> {
        match lifted {
            Lifted::Lines(lines) => self.block_slots(lines.clone()),
            Lifted::Image { .. } => self.image_slots(),
        }
    }

    /// The move of the image at line-relative source `span` of line `index`
    /// to boundary `slot`: its source leaves the line, nothing else there
    /// changes, and it lands at the slot as a line of its own, with a line
    /// ending of the note's after it (before it at the note's end). The
    /// selection follows `moved_selection`; a caret stays with its text.
    /// `None` when the line would read differently
    /// without the image (`---` a divider, ` text` an indented line); the
    /// lines it passes must read as the same kind of block afterwards.
    fn image_move_command(&self, index: usize, span: Range<usize>, slot: usize) -> Option<Command> {
        let count = self.line_count();
        let entry = self.line(index);
        let mut left = entry.text.clone();
        left.replace_range(span.clone(), "");
        let read = block::read_line(&mut entry.carry.clone(), &left, 0);
        if (&read.kind, read.quote) != (&entry.line.kind, entry.line.quote) {
            return None;
        }
        let base = self.line_start(index);
        let span = base + span.start..base + span.end;
        let image = self.source_slice(span.clone());
        let ending = self.line_ending_near(index);
        let (at, text, lands) = if slot == count {
            let len = self.source_len();
            (len, format!("{ending}{image}"), len + ending.len())
        } else {
            let at = self.line_start(slot);
            (at, format!("{image}{ending}"), at)
        };
        // Where the image starts in the new text: its removal is after the
        // insertion or before it.
        let lands = if at <= span.start {
            lands
        } else {
            lands - image.len()
        };
        let edits = vec![Edit::insert(at, text), Edit::new(span.clone(), "")];
        let lines = index.min(slot)..(index + 1).max(slot);
        let shift = usize::from(slot <= index);
        let same_kind = lines.clone().map(|line| (line, line + shift)).collect();
        let mut command = Command::new(edits, lines, 0..0);
        let after = slot < count;
        command.selection = self.moved_selection(&command, span, lands, image.len(), |at| {
            command.map(at, after)
        });
        command.same_kind = same_kind;
        Some(command)
    }

    /// The move of `block` to boundary `slot` (one of its slots): the block's
    /// text inserted at the slot and removed where it was, the selection
    /// following `moved_selection`. Every line it passes, and the block's own, must
    /// read as the same kind of block afterwards.
    fn move_command(&self, block: Range<usize>, slot: usize) -> Command {
        let count = self.line_count();
        let (s, e) = (block.start, block.end);
        let (from, to) = (self.line_start(s), self.line_start(e));
        let text = self.source_slice(from..to);
        let len = self.source_len();
        let (edits, block_start, shown) = if e == count {
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
            (edits, at, text.len())
        } else if slot == count {
            // To the end: the line that was last takes the block's ending.
            let ending = self.line(e - 1).ending();
            let body = &text[..text.len() - ending.len()];
            let edits = vec![
                Edit::insert(len, format!("{ending}{body}")),
                Edit::new(from..to, ""),
            ];
            (edits, len - text.len() + ending.len(), body.len())
        } else {
            let at = self.line_start(slot);
            let start = if slot < s { at } else { at - text.len() };
            (
                vec![Edit::insert(at, text.clone()), Edit::new(from..to, "")],
                start,
                text.len(),
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
        // A caret in the block moves with its text; one at the slot's line
        // start stays on that line, below the block, and one at the note's
        // end stays on the line the block now follows. `shown` is what is
        // left of the block's text where it lands: moved to the end, it
        // leaves its ending behind.
        let after = slot < count;
        command.selection = self.moved_selection(&command, from..to, block_start, shown, |at| {
            if at >= from && (at < to || (at == to && e == count)) {
                block_start + (at - from).min(shown)
            } else {
                command.map(at, after)
            }
        });
        command.same_kind = same_kind;
        command
    }

    /// The source line a renderer has at display offset `at`.
    fn line_shown_at(&self, expected: Revision, at: DisplayOffset) -> Result<usize, EditorError> {
        self.check_revision(expected)?;
        self.check_display(at.0)?;
        Ok(self.line_at_display(store::display, at.0).0)
    }

    /// The display extent of what a press at `at` lifts: an image that
    /// lifts alone, else the block its line lifts, from its first line's
    /// start to the start of the line after it.
    pub(crate) fn block_at(
        &self,
        expected: Revision,
        at: DisplayOffset,
    ) -> Result<Option<DisplayRange>, EditorError> {
        Ok(self.lifted_at(expected, at)?.map(|lifted| match lifted {
            Lifted::Lines(lines) => DisplayRange {
                start: self.boundary(lines.start),
                end: self.boundary(lines.end),
            },
            Lifted::Image { line, span } => {
                let (entry, before) = (self.line(line), self.store.before(line).display);
                DisplayRange {
                    start: DisplayOffset(before + entry.to_display(span.start)),
                    end: DisplayOffset(before + entry.to_display(span.end)),
                }
            }
        }))
    }

    /// Where what a press at `at` lifts may land, each slot as the display
    /// offset of the line start below it (the display's end for the note's
    /// end). Empty when it lifts nothing.
    pub(crate) fn block_slots_at(
        &self,
        expected: Revision,
        at: DisplayOffset,
    ) -> Result<Vec<DisplayOffset>, EditorError> {
        let slots = self
            .lifted_at(expected, at)?
            .map_or_else(Vec::new, |lifted| self.slots_for(&lifted));
        Ok(slots.into_iter().map(|slot| self.boundary(slot)).collect())
    }

    /// Move what a press at `at` lifts to its slot at display offset `to`,
    /// as one action and one Undo step. `None` (nothing changed) when it
    /// lifts nothing, `to` is not one of its slots, or the guard cancels the
    /// move. Refused while text is marked, as table commands are.
    pub(crate) fn move_block(
        &mut self,
        expected: Revision,
        at: DisplayOffset,
        to: DisplayOffset,
        accept: Accept,
    ) -> Result<Option<Change>, EditorError> {
        let lifted = self.lifted_at(expected, at)?;
        self.check_display(to.0)?;
        if self.composition.is_some() {
            return Err(EditorError::CompositionActive);
        }
        let Some(lifted) = lifted else {
            return Ok(None);
        };
        let Some(slot) = self
            .slots_for(&lifted)
            .into_iter()
            .find(|&slot| self.boundary(slot) == to)
        else {
            return Ok(None);
        };
        let command = match lifted {
            Lifted::Lines(lines) => self.move_command(lines, slot),
            Lifted::Image { line, span } => match self.image_move_command(line, span, slot) {
                Some(command) => command,
                None => return Ok(None),
            },
        };
        self.run(expected, |_| Ok(Some(command)), accept)
    }
}
