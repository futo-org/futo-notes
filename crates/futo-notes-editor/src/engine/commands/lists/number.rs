//! Numbered items. Reading never renumbers; editing does. When a command
//! writes a number, the numbered items below that were counting up in
//! sequence are bumped to stay in sequence, and the walk stops at the first
//! item that was not (so `1.` `1.` `1.` is left alone). This is the one
//! place a command edits lines it was not pointed at; it names each line it
//! bumps.
//!
//! Siblings are items with the same quote depth, indent and delimiter. Lines
//! indented further (items under an item, indented plain lines, a fence
//! opened under an item and its code) are passed over; anything else ends
//! the walk, a blank line included.
use super::draft::Draft;
use crate::lines::{FenceRole, Kind, Line};

/// A level of items: quote depth and indent columns.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Level {
    pub quote: usize,
    pub indent: usize,
}

impl Level {
    pub fn of(line: &Line) -> Self {
        let indent = match line.kind {
            Kind::List { indent, .. } | Kind::Plain { indent } => indent,
            _ => 0,
        };
        Self {
            quote: line.quote,
            indent,
        }
    }
}

/// Numbers from this on are not counted: their item is copied as typed.
const UNCOUNTED: i128 = 10i128.pow(36);

/// An ordered item's number and delimiter, from its marker as typed. `None`
/// for a bullet, or a number too long to count with.
pub(super) fn ordinal(body: &str, line: &Line) -> Option<(i128, u8)> {
    let Kind::List {
        ordered: true,
        text,
        ..
    } = &line.kind
    else {
        return None;
    };
    let marker = &body[text.clone()];
    let (digits, delimiter) = marker.split_at(marker.len() - 1);
    let number = digits.parse::<i128>().ok().filter(|&n| n < UNCOUNTED)?;
    Some((number, delimiter.as_bytes()[0]))
}

/// `number` spelled like `like` (the digits it replaces): a number written
/// with leading zeros keeps its width.
pub(super) fn spell(number: i128, like: &str) -> String {
    if like.len() > 1 && like.starts_with('0') {
        format!("{number:0width$}", width = like.len())
    } else {
        number.to_string()
    }
}

/// What a line is to a walk along a level.
enum Step {
    /// An item at the level.
    Sibling,
    /// Under an item of the level: passed over.
    Under,
    /// Ends the walk.
    End,
}

fn step(line: &Line, level: Level) -> Step {
    if line.quote != level.quote {
        return Step::End;
    }
    match line.kind {
        Kind::List { indent, .. } if indent == level.indent => Step::Sibling,
        Kind::List { indent, .. } | Kind::Plain { indent } if indent > level.indent => Step::Under,
        Kind::Fence {
            role: FenceRole::Open,
            indent,
            ..
        } if indent > level.indent => Step::Under,
        Kind::Fence {
            role: FenceRole::Code | FenceRole::Close,
            ..
        } => Step::Under,
        _ => Step::End,
    }
}

impl Draft<'_> {
    /// The numbered sibling above line `index` at `level`, and its number
    /// and delimiter.
    pub fn number_above(&self, index: usize, level: Level) -> Option<(usize, i128, u8)> {
        for above in (0..index).rev() {
            let line = self.line(above);
            match step(line, level) {
                Step::Sibling => {
                    let (number, delimiter) = ordinal(self.body(above), line)?;
                    return Some((above, number, delimiter));
                }
                Step::Under => {}
                Step::End => return None,
            }
        }
        None
    }

    /// Whether a new item after numbered line `index` repeats its number
    /// instead of counting up: the numbered sibling below carries the same
    /// number (a list numbered `1.` on every item), or, with none below,
    /// the one above does.
    pub fn repeats(&self, index: usize, level: Level, number: i128, delimiter: u8) -> bool {
        let below = (index + 1..self.count())
            .find_map(|below| match step(self.line(below), level) {
                Step::Under => None,
                Step::Sibling => Some(ordinal(self.body(below), self.line(below))),
                Step::End => Some(None),
            })
            .flatten();
        let neighbor = below.or_else(|| self.number_above(index, level).map(|(_, n, d)| (n, d)));
        neighbor == Some((number, delimiter))
    }

    /// Write `number` as line `index`'s number (an ordered item).
    pub fn set_number(&mut self, index: usize, number: i128) {
        let Kind::List { text, .. } = &self.line(index).kind else {
            return;
        };
        let text = text.clone();
        let body = self.body(index);
        let digits = &body[text.start..text.end - 1];
        let spelled = spell(number, digits);
        if spelled == digits {
            return;
        }
        let content = self.parts(index).content;
        let prefix = format!(
            "{}{spelled}{}",
            &body[..text.start],
            &body[text.end - 1..content]
        );
        self.set_prefix(index, &prefix, content);
    }

    /// Bump the numbered siblings from line `from` on at `level` that count
    /// on from `was` with `delimiter`, so they count on from `now` instead.
    pub fn bump(&mut self, from: usize, level: Level, delimiter: u8, mut was: i128, mut now: i128) {
        for index in from..self.count() {
            match step(self.line(index), level) {
                Step::Under => continue,
                Step::End => return,
                Step::Sibling => {}
            }
            let Some((number, written)) = ordinal(self.body(index), self.line(index)) else {
                return;
            };
            if written != delimiter || Some(number) != was.checked_add(1) {
                return;
            }
            let Some(next) = now.checked_add(1) else {
                return;
            };
            if next == number {
                return;
            }
            self.set_number(index, next);
            (was, now) = (number, next);
        }
    }
}
