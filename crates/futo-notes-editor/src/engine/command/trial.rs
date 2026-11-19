//! Trying a move without making it: what a slot listing asks of every
//! candidate. Applying the edits and putting them back costs the size of the
//! lifted block, and a `---` can send the reader back to line 1; so the
//! guard's verdict is read instead from the lines at the seams the move
//! creates.
//!
//! A move is described as the note's lines in their new order (`Piece`s:
//! runs of untouched lines, and lines whose text changes or is new) and the
//! lines its command names (`window`). The new order is read as a fresh open
//! would read it, from the line above the window, comparing each line with
//! the guard's rule: a named line, and the line above, keep their kind; a
//! line below keeps its kind read alone, until the reading settles. A run
//! whose reading has settled is read as before, so the reader jumps to its
//! last line, whose header status the next line may still change. Reading
//! settles when the carry matches the old one but for the list stack, which
//! decides list levels and never a line's kind.
mod changes;

pub(crate) use changes::Renumbered;

use super::{alone, class};
use crate::engine::commands::Shift;
use crate::engine::line::{trimmed, Entry};
use crate::engine::Engine;
use crate::lines::{Carry, FrontMatterRole, Kind, TableRole};
use crate::EditWork;
use std::ops::Range;

/// Part of the note in a move's new order.
pub(crate) enum Piece {
    /// Untouched lines, as they were.
    Run(Range<usize>),
    /// A line with new text: old line `Some(index)` rewritten, or a new one
    /// (whose kind is not held to the old line's).
    Line(Option<usize>, String),
    /// Lines under an item, with the item's whitespace swapped.
    Shifted(Range<usize>, Shift),
}

impl Piece {
    /// Line `index` of this run as it reads in the new order.
    pub(super) fn text(&self, engine: &Engine, index: usize) -> String {
        match self {
            Piece::Shifted(_, shift) => shift.text(engine.line(index)),
            _ => engine.line(index).text.clone(),
        }
    }
}

/// A move: the new order, the old lines its command names, where the
/// moved lines land in the new order, and which lines it may renumber.
pub(crate) struct Trial {
    pub pieces: Vec<Piece>,
    pub window: Range<usize>,
    pub landed: Range<usize>,
    pub renumbered: Renumbered,
}

/// The note's lines that are exactly `---`, counted only as far as a
/// listing has needed: a move that puts one on line 1 opens front matter
/// when another follows it.
#[derive(Default)]
pub(crate) struct Dashes {
    found: usize,
    /// The first line not yet counted.
    next: usize,
    /// Each run of shifted lines a candidate has asked about: every
    /// candidate shifts the same run.
    shifted: Vec<ShiftedDashes>,
}

/// The lines in a run a shift could make or unmake a `---` of, found once
/// for the listing, and for each shift asked about how many it makes and
/// unmakes: candidates that shift by the same whitespace get one answer.
struct ShiftedDashes {
    run: Range<usize>,
    lines: Vec<usize>,
    counts: Vec<(Shift, (usize, usize))>,
}

impl Dashes {
    /// How many lines of `run` shifting them by `shift` makes a `---` line,
    /// and how many it stops being one. Only lines whose text, but for
    /// spaces and tabs, is `---` can change: a shift only swaps whitespace.
    fn shifted(
        &mut self,
        engine: &Engine,
        run: &Range<usize>,
        shift: &Shift,
        work: &mut EditWork,
    ) -> (usize, usize) {
        let at = match self.shifted.iter().position(|seen| seen.run == *run) {
            Some(at) => at,
            None => {
                let mut lines = Vec::new();
                for index in run.clone() {
                    work.link_metadata_items += 1;
                    let text = trimmed(&engine.line(index).text);
                    if text
                        .chars()
                        .filter(|c| !matches!(c, ' ' | '\t'))
                        .eq("---".chars())
                    {
                        lines.push(index);
                    }
                }
                self.shifted.push(ShiftedDashes {
                    run: run.clone(),
                    lines,
                    counts: Vec::new(),
                });
                self.shifted.len() - 1
            }
        };
        let seen = &mut self.shifted[at];
        if let Some((_, counts)) = seen.counts.iter().find(|(s, _)| s == shift) {
            return *counts;
        }
        let (mut added, mut removed) = (0, 0);
        for &index in &seen.lines {
            work.link_metadata_items += 1;
            let entry = engine.line(index);
            match (is_dash(&entry.text), is_dash(&shift.text(entry))) {
                (false, true) => added += 1,
                (true, false) => removed += 1,
                _ => {}
            }
        }
        seen.counts.push((shift.clone(), (added, removed)));
        (added, removed)
    }
}

fn is_dash(text: &str) -> bool {
    trimmed(text) == "---"
}

/// A line read but not yet compared: a delimiter row under it would still
/// make it a table header.
struct Read {
    old: Option<usize>,
    kind: Kind,
}

/// Carries that read every later line as the same kind.
fn settled(now: &Carry, was: &Carry) -> bool {
    now.first == was.first
        && now.front_matter == was.front_matter
        && now.fence == was.fence
        && now.table == was.table
        && now.header_above == was.header_above
}

impl Engine {
    /// Whether `run` would accept the move `trial` describes: its text
    /// changes and every line keeps its kind as the guard asks. Equal to
    /// applying it (`tests/moves/trial.rs` holds both to it); the work
    /// grows with the lines read at each seam, not with the note or the
    /// block.
    pub(crate) fn lands(&self, trial: &Trial, dashes: &mut Dashes, work: &mut EditWork) -> bool {
        if !self.trial_changes(trial, work) {
            return false;
        }
        let window = &trial.window;
        let below = |old: usize| old >= window.end;
        let kept = |read: &Read| match read.old {
            None => true,
            Some(old) if below(old) => alone(&self.line(old).line.kind) == alone(&read.kind),
            Some(old) => class(&self.line(old).line.kind) == class(&read.kind),
        };
        if window.start > 1 && !self.first_line_kept(trial, dashes, work) {
            return false;
        }
        // Lines above the window read as they did: start at the one above.
        let (mut carry, mut at) = match window.start {
            0 => (Carry::start(), 0),
            start => (self.line(start - 1).carry.clone(), start - 1),
        };
        let mut pending: Option<Read> = None;
        // Settle the pending line given the kind of the line now under it.
        let close = |pending: &mut Option<Read>, under: Option<&Kind>| {
            let Some(mut read) = pending.take() else {
                return true;
            };
            if let Some(Kind::Table {
                role: TableRole::Delimiter,
                columns,
            }) = under
            {
                read.kind = Kind::Table {
                    role: TableRole::Header,
                    columns: *columns,
                };
            }
            kept(&read)
        };
        let mut position = 0;
        for piece in &trial.pieces {
            match piece {
                Piece::Run(run) | Piece::Shifted(run, _) => {
                    let mut index = run.start.max(at);
                    position += index - run.start;
                    while index < run.end {
                        work.link_metadata_items += 1;
                        let was = &self.line(index);
                        if settled(&carry, &was.carry) {
                            if !close(&mut pending, Some(&was.line.kind)) {
                                return false;
                            }
                            if below(index) {
                                return true;
                            }
                            if index + 1 < run.end {
                                // Read as before up to the run's last line.
                                position += run.end - 1 - index;
                                index = run.end - 1;
                                carry = self.line(index).carry.clone();
                            }
                        }
                        let text = piece.text(self, index);
                        let read = self.trial_read(
                            trial,
                            text,
                            position,
                            Some(index),
                            &mut carry,
                            dashes,
                            work,
                        );
                        if !close(&mut pending, Some(&read.kind)) {
                            return false;
                        }
                        pending = Some(read);
                        index += 1;
                        position += 1;
                    }
                    at = 0;
                }
                Piece::Line(old, text) => {
                    if at > 0 {
                        // Still before the window's line above: no line text
                        // changes there.
                        continue;
                    }
                    work.link_metadata_items += 1;
                    let read = self.trial_read(
                        trial,
                        text.clone(),
                        position,
                        *old,
                        &mut carry,
                        dashes,
                        work,
                    );
                    if !close(&mut pending, Some(&read.kind)) {
                        return false;
                    }
                    pending = Some(read);
                    position += 1;
                }
            }
        }
        close(&mut pending, None)
    }

    /// Read `text` at new position `position` as a fresh open would.
    #[allow(clippy::too_many_arguments)]
    fn trial_read(
        &self,
        trial: &Trial,
        text: String,
        position: usize,
        old: Option<usize>,
        carry: &mut Carry,
        dashes: &mut Dashes,
        work: &mut EditWork,
    ) -> Read {
        work.parsed_source_bytes += text.len();
        let dash = is_dash(&text);
        // Line 1 opens front matter when a later line is `---`. Untouched,
        // it opens it as it did; moved there, the note's other lines decide.
        let rest_closes = carry.first
            && dash
            && match old {
                Some(0)
                    if position == 0 && self.dash_lines_written(trial, dashes, work) == (0, 0) =>
                {
                    matches!(
                        self.line(0).line.kind,
                        Kind::FrontMatter(FrontMatterRole::Open)
                    )
                }
                _ => self.two_dashes(trial, dashes, work),
            };
        let kind = Entry::read(text, carry, rest_closes).line.kind;
        Read { old, kind }
    }

    /// Whether line 1, untouched above the lines the reading starts at,
    /// reads as before: a `---` there opens front matter only while
    /// another `---` follows, which the lines the move writes may add or
    /// take away.
    fn first_line_kept(&self, trial: &Trial, dashes: &mut Dashes, work: &mut EditWork) -> bool {
        let first = self.line(0);
        if !is_dash(&first.text) || self.dash_lines_written(trial, dashes, work) == (0, 0) {
            return true;
        }
        let opened = matches!(first.line.kind, Kind::FrontMatter(FrontMatterRole::Open));
        self.two_dashes(trial, dashes, work) == opened
    }

    /// The lines the move writes that become a `---` line, and that stop
    /// being one (a line under an item shifted into or out of `---`).
    fn dash_lines_written(
        &self,
        trial: &Trial,
        dashes: &mut Dashes,
        work: &mut EditWork,
    ) -> (usize, usize) {
        let (mut added, mut removed) = (0, 0);
        for piece in &trial.pieces {
            match piece {
                Piece::Run(_) => {}
                Piece::Line(old, text) => {
                    match (
                        old.is_some_and(|i| is_dash(&self.line(i).text)),
                        is_dash(text),
                    ) {
                        (false, true) => added += 1,
                        (true, false) => removed += 1,
                        _ => {}
                    }
                }
                Piece::Shifted(run, shift) => {
                    let (more, fewer) = dashes.shifted(self, run, shift, work);
                    added += more;
                    removed += fewer;
                }
            }
        }
        (added, removed)
    }

    /// Whether the new order has two `---` lines or more: the note's, as
    /// far as they are needed, with the ones the move writes.
    fn two_dashes(&self, trial: &Trial, dashes: &mut Dashes, work: &mut EditWork) -> bool {
        let (added, removed) = self.dash_lines_written(trial, dashes, work);
        let need = (2 + removed).saturating_sub(added);
        if dashes.found < need {
            for entry in self.store.iter_from(dashes.next) {
                work.link_metadata_items += 1;
                dashes.next += 1;
                if is_dash(&entry.text) {
                    dashes.found += 1;
                    if dashes.found == need {
                        break;
                    }
                }
            }
        }
        dashes.found >= need
    }
}
