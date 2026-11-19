//! The numbers a move writes, under the rule editing follows (`number.rs`),
//! decided from the note as it was before the move.
//!
//! - Where a numbered item leaves, its siblings after it that were counting
//!   on from it (in sequence, with its delimiter) each count one less.
//! - Where a block arrives as a numbered item, it counts on from the
//!   numbered sibling above the slot (as that sibling ends up), or repeats
//!   its number when the item below has it too (a list numbered alike).
//!   With none above it takes the number of the item below, or 1 when that
//!   number is too long to count with. When it counts up, the item below
//!   and its siblings after it that were counting on from it each count one
//!   more, unless the item below and the next sibling are numbered alike.
//!
//! Each walk reads the note as it was: it passes over lines indented
//! further, and over the moved lines while they were part of the sequence,
//! and stops where the note stopped it, so it never reaches a list the move
//! put next to it. A line on both walks keeps its number.
use super::super::super::super::command::Edit;
use super::super::draft::diff;
use super::super::number::{ordinal, spell, step, Level, Step};
use super::{Arriving, Landing};
use crate::engine::Engine;
use crate::lines::block::width;
use crate::lines::Kind;
use std::collections::BTreeMap;
use std::ops::Range;

/// A line as a move writes it: its new body, where the text before
/// `old_cut` in the old line became the text before `new_cut`, with one `\`
/// written at `escape` (relative to the cut) when one was needed.
#[derive(Clone, Debug)]
pub(in crate::engine::commands) struct Written {
    pub body: String,
    pub old_cut: usize,
    pub new_cut: usize,
    pub escape: Option<usize>,
}

impl Written {
    fn kept(body: &str) -> Self {
        Self {
            body: body.to_owned(),
            old_cut: 0,
            new_cut: 0,
            escape: None,
        }
    }

    /// Where old line-relative offset `at` (inside the old body) lands: a
    /// position in the rewritten prefix lands where the text starts.
    pub fn map(&self, at: usize) -> usize {
        if at <= self.old_cut {
            return self.new_cut;
        }
        let into = at - self.old_cut;
        self.new_cut + into + usize::from(self.escape.is_some_and(|k| into > k))
    }
}

/// What a move writes besides moving the lines.
pub(in crate::engine::commands) struct Arrival {
    /// The moved lines (a photo's one line) as they land, in order.
    pub lines: Vec<Written>,
    /// The other lines the move renumbers: old index, and the edit.
    pub numbers: Vec<(usize, Edit)>,
}

impl Engine {
    /// The numbered siblings at `level` from line `from` on that count on
    /// in sequence from `number` with `delimiter`, in the note as it is,
    /// each with its number; lines in `moved` are counted but not listed.
    fn counting_on(
        &self,
        from: usize,
        level: Level,
        (mut number, delimiter): (i128, u8),
        moved: &Range<usize>,
    ) -> Vec<(usize, i128)> {
        let mut run = Vec::new();
        for index in from..self.line_count() {
            let entry = self.line(index);
            match step(&entry.line, level) {
                Step::Under => continue,
                Step::End => break,
                Step::Sibling => {}
            }
            match ordinal(entry.body(), &entry.line) {
                Some((n, d)) if d == delimiter && number.checked_add(1) == Some(n) => {
                    if !moved.contains(&index) {
                        run.push((index, n));
                    }
                    number = n;
                }
                _ => break,
            }
        }
        run
    }

    /// The nearest sibling at `level` beside the slot above line `slot`
    /// (`up`) or from line `slot` on, the moved lines left out, as the move
    /// leaves the note: its index and number, when it is numbered.
    fn sibling_beside(
        &self,
        slot: usize,
        level: Level,
        moved: &Range<usize>,
        up: bool,
    ) -> Option<(usize, i128, u8)> {
        let mut indices: Box<dyn Iterator<Item = usize>> = if up {
            Box::new((0..slot).rev())
        } else {
            Box::new(slot..self.line_count())
        };
        indices.find_map(|index| {
            if moved.contains(&index) {
                return None;
            }
            let entry = self.line(index);
            match step(&entry.line, level) {
                Step::Under => None,
                Step::End => Some(None),
                Step::Sibling => {
                    Some(ordinal(entry.body(), &entry.line).map(|(n, d)| (index, n, d)))
                }
            }
        })?
    }

    /// What `arriving`, landing at boundary `slot` as `landing` says, writes:
    /// its lines, and the numbers at both ends of the move.
    pub(in crate::engine::commands) fn arrival(
        &self,
        arriving: &Arriving,
        slot: usize,
        landing: Option<&Landing>,
    ) -> Arrival {
        let (moved, root) = match arriving {
            Arriving::Lines(lines) => (lines.clone(), self.line(lines.start).body()),
            Arriving::Image(source) => (slot..slot, *source),
        };
        let shift = landing.and_then(|landing| landing.shift.as_ref());
        let mut lines = vec![Written::kept(root)];
        for index in moved.start + 1..moved.end {
            let entry = self.line(index);
            lines.push(
                match shift.and_then(|s| s.under(entry.body(), &entry.line)) {
                    Some((prefix, cut)) => Written {
                        body: format!("{prefix}{}", &entry.body()[cut..]),
                        old_cut: cut,
                        new_cut: prefix.len(),
                        escape: None,
                    },
                    None => Written::kept(entry.body()),
                },
            );
        }
        // Each renumbered line's number and what the move adds to it.
        let mut changes: BTreeMap<usize, (i128, i128)> = BTreeMap::new();
        let first = (!moved.is_empty()).then(|| &self.line(moved.start).line);
        if let Some((was, delimiter)) = first.and_then(|line| ordinal(root, line)) {
            let level = Level::of(first.expect("lines"));
            let none = moved.end..moved.end;
            for (index, n) in self.counting_on(moved.end, level, (was, delimiter), &none) {
                changes.entry(index).or_insert((n, 0)).1 -= 1;
            }
        }
        if let Some(landing) = landing {
            lines[0] = self.arrive(landing, root, slot, &moved, &mut changes);
        }
        let numbers = changes
            .into_iter()
            .filter(|&(_, (_, by))| by != 0)
            .filter_map(|(index, (n, by))| {
                let entry = self.line(index);
                let Kind::List { text, .. } = &entry.line.kind else {
                    return None;
                };
                let body = entry.body();
                let digits = &body[text.start..text.end - 1];
                let new = format!(
                    "{}{}{}",
                    &body[..text.start],
                    spell(n + by, digits),
                    &body[text.end - 1..]
                );
                Some((index, diff(self.line_start(index), body, &new)?))
            })
            .collect();
        Arrival { lines, numbers }
    }

    /// The first line written as `landing` says, counting in the numbered
    /// list it joins; the siblings it pushes on go into `changes`.
    fn arrive(
        &self,
        landing: &Landing,
        root: &str,
        slot: usize,
        moved: &Range<usize>,
        changes: &mut BTreeMap<usize, (i128, i128)>,
    ) -> Written {
        let Some(delimiter) = landing.numbered_delimiter() else {
            return landing.first_line(root, None);
        };
        let level = Level {
            quote: 0,
            indent: width(landing.space()),
        };
        let below = self.line(slot);
        let counted = ordinal(below.body(), &below.line);
        // The number the sibling above ends with: it may close up.
        let above = self
            .sibling_beside(slot, level, moved, true)
            .filter(|&(_, _, d)| d == delimiter)
            .map(|(index, n, _)| (n, n + changes.get(&index).map_or(0, |&(_, by)| by)));
        // Whether the sibling after the item below is numbered as it is.
        let alike = |b: i128| {
            self.sibling_beside(slot + 1, level, moved, false)
                .is_some_and(|(_, n, d)| (n, d) == (b, delimiter))
        };
        let (number, counts_up) = match (above, counted) {
            (Some((was, now)), Some((b, _))) if b == was => (now, false),
            (Some((was, now)), Some((b, _))) => (now + 1, b == was + 1 && !alike(b)),
            (Some((_, now)), None) => (now + 1, false),
            (None, Some((b, _))) => (b, !alike(b)),
            (None, None) => (1, false),
        };
        if counts_up {
            let before = counted.expect("a counted item below").0 - 1;
            for (index, n) in self.counting_on(slot, level, (before, delimiter), moved) {
                changes.entry(index).or_insert((n, 0)).1 += 1;
            }
        }
        landing.first_line(root, Some(number))
    }
}
