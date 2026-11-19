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
//! lines move together. Where they may land is `slots.rs`.
use super::super::command::Command;
use super::super::edit::Change;
use super::super::{store, Engine};
use super::images::{inside_another_mark, shows_around};
use crate::lines::{FenceRole, Kind, Line, SpanKind};
use crate::{
    BlockBoundary, BlockSlots, DisplayOffset, DisplayRange, EditWork, EditorError, LiftedBlock,
    Revision, SourceEdit,
};
use std::cell::RefCell;
use std::ops::Range;

mod command;
mod held;
mod order;
mod selection;
mod slots;

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
#[derive(Clone)]
enum Lifted {
    Lines(Range<usize>),
    /// The image at line-relative source `span` of line `line`.
    Image {
        line: usize,
        span: Range<usize>,
    },
}

/// What the last press resolved, with the revision and position it was
/// asked at. A renderer asks for the slots again at each scroll step for
/// the same press, and finding a table or item's lines reads all of them;
/// any edit to the lines (`Engine::raw`) clears it.
#[derive(Default)]
pub(crate) struct Resolved(RefCell<Option<(Revision, DisplayOffset, Option<Lifted>)>>);

impl Resolved {
    pub(crate) fn clear(&self) {
        self.0.take();
    }
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

    /// The image under display offset `at` on line `index`, as a
    /// line-relative source span, when it lifts alone: the line shows content
    /// besides it (text or another image; markers, whitespace and hidden
    /// syntax do not count, `shows_around`), no other mark holds it, and the line is no quote, table, code
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
        let (before, after) = shows_around(&entry.text, &entry.spans, &line.content, &span.range);
        (!inside_another_mark(&entry.spans, &span.range) && (before || after))
            .then(|| span.range.clone())
    }

    /// What a press at display offset `at` lifts.
    fn lifted_at(
        &self,
        expected: Revision,
        at: DisplayOffset,
        work: &mut EditWork,
    ) -> Result<Option<Lifted>, EditorError> {
        let index = self.line_shown_at(expected, at)?;
        if let Some((revision, pressed, lifted)) = &*self.resolved.0.borrow() {
            if (*revision, *pressed) == (expected, at) {
                return Ok(lifted.clone());
            }
        }
        let lifted = match self.image_lifted(index, at) {
            Some(span) => Some(Lifted::Image { line: index, span }),
            None => self.block_lines(index).map(|lines| {
                // Finding the block reads every line of it.
                work.link_metadata_items += lines.len();
                Lifted::Lines(lines)
            }),
        };
        *self.resolved.0.borrow_mut() = Some((expected, at, lifted.clone()));
        Ok(lifted)
    }

    /// The move a drop of `lifted` on boundary `slot` makes: the command a
    /// real move runs and a slot's trial tries. `None` when an image cannot
    /// leave its line.
    fn move_of(&self, lifted: &Lifted, slot: usize) -> Option<Command> {
        match lifted {
            Lifted::Lines(lines) => Some(self.move_command(lines.clone(), slot)),
            Lifted::Image { line, span } => self.image_move_command(*line, span.clone(), slot),
        }
    }

    /// The source line a renderer has at display offset `at`.
    fn line_shown_at(&self, expected: Revision, at: DisplayOffset) -> Result<usize, EditorError> {
        self.check_revision(expected)?;
        self.check_display(at.0)?;
        Ok(self.line_at_display(store::display, at.0).0)
    }

    /// What a press at `at` lifts: an image that lifts alone, else the
    /// block its line lifts, from its first line's start to the start of the
    /// line after it or the note's end.
    pub(crate) fn block_at(
        &self,
        expected: Revision,
        at: DisplayOffset,
    ) -> Result<Option<LiftedBlock>, EditorError> {
        Ok(self
            .lifted_at(expected, at, &mut EditWork::default())?
            .map(|lifted| match lifted {
                Lifted::Lines(lines) => {
                    let end = self.boundary(lines.end);
                    LiftedBlock {
                        range: DisplayRange {
                            start: self.boundary(lines.start).at,
                            end: end.at,
                        },
                        to_end: end.end,
                    }
                }
                Lifted::Image { line, span } => {
                    let (entry, before) = (self.line(line), self.store.before(line).display);
                    LiftedBlock {
                        range: DisplayRange {
                            start: DisplayOffset(before + entry.to_display(span.start)),
                            end: DisplayOffset(before + entry.to_display(span.end)),
                        },
                        to_end: false,
                    }
                }
            }))
    }

    /// Where what a press at `at` lifts may land inside display range
    /// `within`, each slot tried; none when it lifts nothing. Refused while
    /// text is marked, as a move is.
    pub(crate) fn block_slots_at(
        &self,
        expected: Revision,
        at: DisplayOffset,
        within: DisplayRange,
    ) -> Result<BlockSlots, EditorError> {
        let mut work = EditWork::default();
        let lifted = self.lifted_at(expected, at, &mut work)?;
        self.check_display_range(within)?;
        if self.composition.is_some() {
            return Err(EditorError::CompositionActive);
        }
        let slots = match lifted {
            Some(lifted) => self.slots_within(&lifted, within, &mut work),
            None => Vec::new(),
        };
        Ok(BlockSlots { slots, work })
    }

    /// Move what a press at `at` lifts to its slot `to`, as one action and
    /// one Undo step. `None` (nothing changed) when it lifts nothing or `to`
    /// is not one of its slots. Refused while text is marked, as table
    /// commands are.
    pub(crate) fn move_block(
        &mut self,
        expected: Revision,
        at: DisplayOffset,
        to: BlockBoundary,
        accept: Accept,
    ) -> Result<Option<Change>, EditorError> {
        let lifted = self.lifted_at(expected, at, &mut EditWork::default())?;
        self.check_display(to.at.0)?;
        if self.composition.is_some() {
            return Err(EditorError::CompositionActive);
        }
        let Some(lifted) = lifted else {
            return Ok(None);
        };
        // A move that changes nothing but numbers is no move, as a slot's
        // trial judges it.
        let Some(command) = self.slot_named(&lifted, to).and_then(|slot| {
            let trial = self.trial_of(&lifted, slot)?;
            self.trial_changes(&trial, &mut EditWork::default())
                .then(|| self.move_of(&lifted, slot))?
        }) else {
            return Ok(None);
        };
        self.run(expected, |_| Ok(Some(command)), accept)
    }
}
