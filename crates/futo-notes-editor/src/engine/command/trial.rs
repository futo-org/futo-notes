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
    fn text(&self, engine: &Engine, index: usize) -> String {
        match self {
            Piece::Shifted(_, shift) => shift.text(engine.line(index)),
            _ => engine.line(index).text.clone(),
        }
    }
}

/// A numbered item's text without its digits, and the rest: a move
/// renumbers items and a trial does not, so a numbered item is compared
/// without them.
fn unnumbered(text: &str) -> (&str, &str) {
    let lead = text.len() - text.trim_start_matches([' ', '\t']).len();
    let digits = text[lead..].bytes().take_while(u8::is_ascii_digit).count();
    (&text[..lead], &text[lead + digits..])
}

/// A move: the new order, and the old lines its command names.
pub(crate) struct Trial {
    pub pieces: Vec<Piece>,
    pub window: Range<usize>,
}

/// The note's lines that are exactly `---`, counted only as far as a
/// listing has needed: a move that puts one on line 1 opens front matter
/// when another follows it.
#[derive(Default)]
pub(crate) struct Dashes {
    found: usize,
    /// The first line not yet counted.
    next: usize,
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
        // Line 1, a `---` above the line the reading starts at, opens front
        // matter only while another `---` follows: the lines the move
        // writes may add or take away that one.
        if window.start > 1 && is_dash(&self.line(0).text) {
            let opened = matches!(
                self.line(0).line.kind,
                Kind::FrontMatter(FrontMatterRole::Open)
            );
            if self.dash_lines_written(trial, work) != (0, 0)
                && self.two_dashes(trial, dashes, work) != opened
            {
                return false;
            }
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
                Some(0) if position == 0 && self.dash_lines_written(trial, work) == (0, 0) => {
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

    /// The lines the move writes that become a `---` line, and that stop
    /// being one (a line under an item shifted into or out of `---`).
    fn dash_lines_written(&self, trial: &Trial, work: &mut EditWork) -> (usize, usize) {
        let (mut added, mut removed) = (0, 0);
        let mut count = |was: bool, now: bool| match (was, now) {
            (false, true) => added += 1,
            (true, false) => removed += 1,
            _ => {}
        };
        for piece in &trial.pieces {
            match piece {
                Piece::Run(_) => {}
                Piece::Line(old, text) => count(
                    old.is_some_and(|i| is_dash(&self.line(i).text)),
                    is_dash(text),
                ),
                Piece::Shifted(run, _) => {
                    for index in run.clone() {
                        work.link_metadata_items += 1;
                        let text = piece.text(self, index);
                        count(is_dash(&self.line(index).text), is_dash(&text));
                    }
                }
            }
        }
        (added, removed)
    }

    /// Whether the new order has two `---` lines or more: the note's, as
    /// far as they are needed, with the ones the move writes.
    fn two_dashes(&self, trial: &Trial, dashes: &mut Dashes, work: &mut EditWork) -> bool {
        let (added, removed) = self.dash_lines_written(trial, work);
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

    /// Whether the new order's text differs from the note's but for the
    /// digits of numbered items (unquoted, where a move renumbers): compared
    /// up to the first line that differs. A move that would change only
    /// those numbers is no move.
    pub(in crate::engine) fn trial_changes(&self, trial: &Trial, work: &mut EditWork) -> bool {
        let count = self.line_count();
        let mut position = 0;
        let mut differs = |text: &str, position: usize| {
            work.link_metadata_items += 1;
            if position >= count {
                return true;
            }
            let old = self.line(position);
            let numbered =
                old.line.quote == 0 && matches!(old.line.kind, Kind::List { ordered: true, .. });
            if numbered {
                unnumbered(text) != unnumbered(&old.text)
            } else {
                *text != old.text
            }
        };
        for piece in &trial.pieces {
            match piece {
                Piece::Run(run) if run.start == position => position = run.end,
                Piece::Run(run) | Piece::Shifted(run, _) => {
                    for index in run.clone() {
                        if differs(&piece.text(self, index), position) {
                            return true;
                        }
                        position += 1;
                    }
                }
                Piece::Line(_, text) => {
                    if differs(text, position) {
                        return true;
                    }
                    position += 1;
                }
            }
        }
        position != count
    }
}
