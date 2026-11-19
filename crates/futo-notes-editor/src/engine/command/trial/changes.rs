//! Whether a move changes the note: a drop that writes the lines it moves
//! past as they were is no move, and is never offered. A move renumbers
//! some items and a trial does not, so the lines it may renumber are
//! compared without their digits; every other line, the moved lines under
//! the first included, is compared as written. The moved lines are
//! compared first, where they land, then the lines from the top of the
//! window, at most `READ` of them: a drop past a longer run of lines that
//! read like the lines they replace is no move.
use super::{Piece, Trial};
use crate::engine::Engine;
use crate::lines::Kind;
use crate::EditWork;
use std::ops::Range;

/// The most lines a trial compares to tell whether a move changes anything.
const READ: usize = 64;

/// Which lines a move may renumber.
#[derive(Default)]
pub(crate) struct Renumbered {
    /// The unquoted levels it renumbers: indent and delimiter.
    pub levels: Vec<(usize, u8)>,
    /// The moved lines, which keep their numbers but for the first.
    pub moved: Range<usize>,
    /// Whether the first moved line (or a photo's new line) takes a number
    /// where it lands.
    pub first: bool,
}

/// A numbered item's text without its digits, and the rest.
fn unnumbered(text: &str) -> (&str, &str) {
    let lead = text.len() - text.trim_start_matches([' ', '\t']).len();
    let digits = text[lead..].bytes().take_while(u8::is_ascii_digit).count();
    (&text[..lead], &text[lead + digits..])
}

impl Engine {
    /// Whether old line `old` (`None`: a new line) may be renumbered.
    fn may_renumber(&self, renumbered: &Renumbered, old: Option<usize>) -> bool {
        let moved = &renumbered.moved;
        let Some(old) = old else {
            return renumbered.first;
        };
        if !moved.is_empty() && old == moved.start {
            return renumbered.first;
        }
        if moved.contains(&old) {
            return false;
        }
        let entry = self.line(old);
        let Kind::List {
            ordered: true,
            indent,
            text,
            ..
        } = &entry.line.kind
        else {
            return false;
        };
        let delimiter = entry.body().as_bytes()[text.end - 1];
        entry.line.quote == 0 && renumbered.levels.contains(&(*indent, delimiter))
    }

    /// The text at new position `at` of `trial` (whose pieces start at
    /// `starts`), and the old line it is.
    fn trial_line(&self, trial: &Trial, starts: &[usize], at: usize) -> (String, Option<usize>) {
        let piece = starts.partition_point(|&start| start <= at) - 1;
        let into = at - starts[piece];
        match &trial.pieces[piece] {
            Piece::Line(old, text) => (text.clone(), *old),
            run @ (Piece::Run(lines) | Piece::Shifted(lines, _)) => {
                let index = lines.start + into;
                (run.text(self, index), Some(index))
            }
        }
    }

    /// Whether the move `trial` describes changes the note: not when every
    /// line it writes reads as it was, digits aside where it renumbers, or
    /// when the first `READ` lines compared do.
    pub(in crate::engine) fn trial_changes(&self, trial: &Trial, work: &mut EditWork) -> bool {
        let mut starts = Vec::with_capacity(trial.pieces.len());
        let mut total = 0;
        for piece in &trial.pieces {
            starts.push(total);
            total += match piece {
                Piece::Run(lines) | Piece::Shifted(lines, _) => lines.len(),
                Piece::Line(..) => 1,
            };
        }
        if total != self.line_count() {
            return true;
        }
        let (window, landed) = (&trial.window, &trial.landed);
        let order = landed
            .clone()
            .chain(window.start..landed.start)
            .chain(landed.end..window.end);
        for at in order.take(READ) {
            work.link_metadata_items += 1;
            let (text, old) = self.trial_line(trial, &starts, at);
            let was = &self.line(at).text;
            let differs = if self.may_renumber(&trial.renumbered, old) {
                unnumbered(&text) != unnumbered(was)
            } else {
                text != *was
            };
            if differs {
                return true;
            }
        }
        false
    }
}
