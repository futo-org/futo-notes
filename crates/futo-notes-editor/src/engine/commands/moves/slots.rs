//! Where a lifted block may land (#311, #446). A slot is a boundary between
//! lines that the landing rules allow and where the move would be accepted:
//! each allowed boundary is tried with the command a drop runs, behind the
//! same guard, and the note put back. A renderer asks for the slots inside a
//! display range, so the work grows with that range, never with the note.
//!
//! A renderer names a boundary by its display offset and whether it is the
//! note's end (`BlockBoundary`): around a last line that shows no characters
//! (an empty task) the boundary above it and the note's end share an offset.
use super::super::super::store;
use super::held::Held;
use super::{quoted, Lifted};
use crate::engine::Engine;
use crate::lines::{FenceRole, FrontMatterRole, Kind, TableRole};
use crate::{BlockBoundary, DisplayOffset, DisplayRange, EditWork};

impl Engine {
    /// Boundary `at` (above line `at`; the line count is the note's end) as
    /// a renderer names it.
    pub(super) fn boundary(&self, at: usize) -> BlockBoundary {
        BlockBoundary {
            at: DisplayOffset(self.store.before(at).display),
            end: at == self.line_count(),
        }
    }

    /// Whether boundary `at` lies inside lines that stay together: front
    /// matter (or above it), a code block, a table or a run of quote lines.
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

    /// Whether the note's end is drawn where the boundary above the last
    /// line is: that line is the blank one after a final line ending, which
    /// shows nothing. The two are then one slot, the one above it.
    fn end_twins_last_line(&self) -> bool {
        let last = self.line(self.line_count() - 1);
        last.line.quote == 0 && matches!(last.line.kind, Kind::Blank) && last.size.display == 0
    }

    /// The first boundary at or after display offset `at`.
    fn first_boundary_from(&self, at: usize) -> usize {
        let (index, before) = self.line_at_display(store::display, at);
        if before.display < at {
            return index + 1;
        }
        // Lines that show nothing share their boundary's offset.
        let mut first = index;
        while first > 0 && self.line(first - 1).size.display == 0 {
            first -= 1;
        }
        first
    }

    /// The boundaries from `from` on, up to display offset `until`, that the
    /// landing rules allow `lifted` (one per `BlockBoundary`, the first),
    /// before any move is tried: every boundary between lines except the
    /// block's own edges and those inside it, inside a unit, or strictly
    /// between two lines of a list (its items and the lines under them)
    /// unless the block is an unquoted item, one plain line or an image; and
    /// not the note's end where the empty last line hides it.
    fn allowed(
        &self,
        lifted: &Lifted,
        from: usize,
        until: usize,
        work: &mut EditWork,
    ) -> Vec<(usize, BlockBoundary)> {
        let count = self.line_count();
        let (joins_lists, own) = match lifted {
            Lifted::Lines(block) => {
                let first = &self.line(block.start).line;
                let joins = first.quote == 0
                    && (matches!(first.kind, Kind::List { .. })
                        || (block.len() == 1 && matches!(first.kind, Kind::Plain { .. })));
                let edges = [self.boundary(block.start), self.boundary(block.end)];
                (joins, Some((block.clone(), edges)))
            }
            Lifted::Image { .. } => (true, None),
        };
        let mut held = Held::default();
        let mut display = self.store.before(from).display;
        let mut out: Vec<(usize, BlockBoundary)> = Vec::new();
        for at in from..=count {
            work.link_metadata_items += 1;
            if display > until {
                break;
            }
            let name = BlockBoundary {
                at: DisplayOffset(display),
                end: at == count,
            };
            if at < count {
                display += self.line(at).size.display;
            }
            // Strictly inside a list: both lines around the boundary in one.
            let in_list = |held: &mut Held, work: &mut EditWork| {
                0 < at
                    && at < count
                    && self.holder(at, held, work).is_some()
                    && self.holder(at - 1, held, work).is_some()
            };
            let ruled_out = own.as_ref().is_some_and(|(block, edges)| {
                (block.start..=block.end).contains(&at) || edges.contains(&name)
            }) || self.inside_unit(at)
                || (at == count && self.end_twins_last_line())
                || out.last().is_some_and(|(_, last)| *last == name)
                || (!joins_lists && in_list(&mut held, work));
            if !ruled_out {
                out.push((at, name));
            }
        }
        out
    }

    /// The slots of `lifted` whose display offset is inside `within`.
    pub(super) fn slots_within(
        &mut self,
        lifted: &Lifted,
        within: DisplayRange,
        work: &mut EditWork,
    ) -> Vec<BlockBoundary> {
        let from = self.first_boundary_from(within.start.0);
        self.allowed(lifted, from, within.end.0, work)
            .into_iter()
            .filter(|&(at, _)| self.lands(lifted, at, work))
            .map(|(_, name)| name)
            .collect()
    }

    /// Whether the move of `lifted` to boundary `at` would be accepted:
    /// the command a drop runs, tried behind the guard and put back.
    fn lands(&mut self, lifted: &Lifted, at: usize, work: &mut EditWork) -> bool {
        self.move_of(lifted, at)
            .is_some_and(|command| self.would_run(&command, work))
    }

    /// The boundary `to` names, when the landing rules allow `lifted` there;
    /// the move itself still runs behind the guard.
    pub(super) fn slot_named(&self, lifted: &Lifted, to: BlockBoundary) -> Option<usize> {
        let len = self.display_len();
        let from = if to.end {
            if to.at.0 != len {
                return None;
            }
            self.line_count()
        } else {
            self.first_boundary_from(to.at.0)
        };
        self.allowed(lifted, from, to.at.0, &mut EditWork::default())
            .into_iter()
            .find(|&(_, name)| name == to)
            .map(|(at, _)| at)
    }
}
