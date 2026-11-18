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
use super::{alone, class};
use crate::engine::line::{trimmed, Entry};
use crate::engine::Engine;
use crate::lines::{Carry, FrontMatterRole, Kind, TableRole};
use crate::EditWork;
use std::ops::Range;

/// Part of the note in a move's new order.
pub(crate) enum Piece {
    /// Untouched lines, as they were.
    Run(Range<usize>),
    /// A line with new text: old line `Some(index)` rewritten, or a new one.
    Line(Option<usize>, String),
}

/// A move: the new order, and the old lines its command names.
pub(crate) struct Trial {
    pub pieces: Vec<Piece>,
    pub window: Range<usize>,
}

/// How many lines of the note are exactly `---`, counted to two, once per
/// listing: a move that puts one on line 1 opens front matter when another
/// follows it.
#[derive(Default)]
pub(crate) struct Dashes(Option<usize>);

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
                Piece::Run(run) => {
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
                        let text = self.line(index).text.clone();
                        let read =
                            self.trial_read(text, position, Some(index), &mut carry, dashes, work);
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
                    let read =
                        self.trial_read(text.clone(), position, *old, &mut carry, dashes, work);
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
    fn trial_read(
        &self,
        text: String,
        position: usize,
        old: Option<usize>,
        carry: &mut Carry,
        dashes: &mut Dashes,
        work: &mut EditWork,
    ) -> Read {
        work.parsed_source_bytes += text.len();
        let dash = trimmed(&text) == "---";
        // Line 1 opens front matter when a later line is `---`. Untouched,
        // it opens it as it did; moved there, the note's other lines decide.
        let rest_closes = carry.first
            && dash
            && match old {
                Some(0) if position == 0 => matches!(
                    self.line(0).line.kind,
                    Kind::FrontMatter(FrontMatterRole::Open)
                ),
                _ => self.dashes(dashes, work) >= 2,
            };
        let kind = Entry::read(text, carry, rest_closes).line.kind;
        Read { old, kind }
    }

    /// The note's `---` lines, counted to two.
    fn dashes(&self, dashes: &mut Dashes, work: &mut EditWork) -> usize {
        *dashes.0.get_or_insert_with(|| {
            let mut found = 0;
            for entry in self.store.iter_from(0) {
                work.link_metadata_items += 1;
                if trimmed(&entry.text) == "---" {
                    found += 1;
                    if found == 2 {
                        break;
                    }
                }
            }
            found
        })
    }

    /// Whether the new order's text differs from the note's: compared from
    /// the window's first line, up to the first line that differs.
    fn trial_changes(&self, trial: &Trial, work: &mut EditWork) -> bool {
        let count = self.line_count();
        let mut position = 0;
        for piece in &trial.pieces {
            match piece {
                Piece::Run(run) if run.start == position => position = run.end,
                Piece::Run(run) => {
                    for index in run.clone() {
                        work.link_metadata_items += 1;
                        if position >= count || self.line(index).text != self.line(position).text {
                            return true;
                        }
                        position += 1;
                    }
                }
                Piece::Line(_, text) => {
                    work.link_metadata_items += 1;
                    if position >= count || *text != self.line(position).text {
                        return true;
                    }
                    position += 1;
                }
            }
        }
        position != count
    }
}
