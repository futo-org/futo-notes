//! The numbers a move writes, under the rule editing follows (`number.rs`).
//! Where a numbered item left, the items after it at its level that were
//! counting on from it close up; the walk stops at the moved block, whose
//! arrival renumbers what follows it. Where a block arrives as a numbered
//! item it counts on from the numbered item above it at its new level (in a
//! list numbered alike it repeats that number), or with none above takes
//! the number of the item below; the items below that were counting on are
//! bumped. Both walks read the note in the order the move leaves it.
use super::super::super::super::command::Edit;
use super::super::draft::diff;
use super::super::number::{ordinal, Level, Numbering};
use super::{Arriving, Landing};
use crate::engine::Engine;
use crate::lines::block::{read_line, width};
use crate::lines::Line;
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

/// The note in the order a move leaves it: the old lines in their order,
/// with `moved` (old indices; empty for a photo) at positions `block`.
struct Order<'a> {
    engine: &'a Engine,
    moved: Range<usize>,
    block: Range<usize>,
    /// Where a walk stops: the moved block, while the place it left closes up.
    limit: usize,
    rewrites: BTreeMap<usize, (String, Line)>,
}

impl Order<'_> {
    /// The old line at position `at`; `None` for a photo's new line.
    fn old(&self, at: usize) -> Option<usize> {
        let (moved, block) = (&self.moved, &self.block);
        if block.contains(&at) {
            return (!moved.is_empty()).then(|| moved.start + at - block.start);
        }
        let k = if at < block.start {
            at
        } else {
            at - block.len()
        };
        Some(if k < moved.start { k } else { k + moved.len() })
    }

    /// The position of old line `old`, which does not move.
    fn position(&self, old: usize) -> usize {
        let k = if old < self.moved.start {
            old
        } else {
            old - self.moved.len()
        };
        if k < self.block.start {
            k
        } else {
            k + self.block.len()
        }
    }

    fn write(&mut self, at: usize, body: String) {
        let mut carry = self
            .old(at)
            .map(|old| self.engine.line(old).carry.clone())
            .unwrap_or_default();
        carry.first = false;
        let line = read_line(&mut carry, &body, 0);
        self.rewrites.insert(at, (body, line));
    }
}

impl Numbering for Order<'_> {
    fn count(&self) -> usize {
        self.limit
    }

    fn line(&self, index: usize) -> &Line {
        match self.rewrites.get(&index) {
            Some((_, line)) => line,
            None => {
                &self
                    .engine
                    .line(self.old(index).expect("a written line"))
                    .line
            }
        }
    }

    fn body(&self, index: usize) -> &str {
        match self.rewrites.get(&index) {
            Some((body, _)) => body,
            None => self
                .engine
                .line(self.old(index).expect("a written line"))
                .body(),
        }
    }

    fn set_prefix(&mut self, index: usize, prefix: &str, cut: usize) {
        let body = format!("{prefix}{}", &self.body(index)[cut..]);
        self.write(index, body);
    }
}

impl Engine {
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
        let len = moved.len().max(1);
        let start = if slot <= moved.start {
            slot
        } else {
            slot - len
        };
        let count = self.line_count() + len - moved.len();
        let mut order = Order {
            engine: self,
            moved: moved.clone(),
            block: start..start + len,
            limit: count,
            rewrites: BTreeMap::new(),
        };
        let mut lines = vec![Written::kept(root)];
        for index in moved.start + 1..moved.end {
            let entry = self.line(index);
            let shifted = landing.and_then(|landing| landing.shift.as_ref());
            lines.push(
                match shifted.and_then(|s| s.under(entry.body(), &entry.line)) {
                    Some((prefix, cut)) => {
                        let body = format!("{prefix}{}", &entry.body()[cut..]);
                        order.write(start + lines.len(), body.clone());
                        Written {
                            body,
                            old_cut: cut,
                            new_cut: prefix.len(),
                            escape: None,
                        }
                    }
                    None => Written::kept(entry.body()),
                },
            );
        }
        // The place it left closes up, as far as the moved block.
        let first = (!moved.is_empty()).then(|| &self.line(moved.start).line);
        if let Some((was, delimiter)) = first.and_then(|line| ordinal(root, line)) {
            if moved.end < self.line_count() {
                let from = order.position(moved.end);
                if start > from {
                    order.limit = start;
                }
                order.bump(
                    from,
                    Level::of(first.expect("lines")),
                    delimiter,
                    was,
                    was - 1,
                );
                order.limit = count;
            }
        }
        let Some(landing) = landing else {
            return finish(order, lines);
        };
        let level = Level {
            quote: 0,
            indent: width(landing.space()),
        };
        let below = order.block.end;
        let counted = landing.numbered_delimiter().and_then(|delimiter| {
            let (number, _) = ordinal(order.body(below), order.line(below))?;
            let above = order
                .number_above(start, level)
                .filter(|&(_, _, d)| d == delimiter);
            Some((number, above.map(|(_, n, _)| n), delimiter))
        });
        let number = counted.map(|(below_n, above, _)| match above {
            Some(n) if n == below_n => n,
            Some(n) => n + 1,
            None => below_n,
        });
        lines[0] = landing.first_line(root, number);
        order.write(start, lines[0].body.clone());
        if let (Some((below_n, above, delimiter)), Some(number)) = (counted, number) {
            if above != Some(below_n) {
                order.bump(below, level, delimiter, number - 1, number);
            }
        }
        finish(order, lines)
    }
}

fn finish(order: Order, lines: Vec<Written>) -> Arrival {
    let numbers = order
        .rewrites
        .iter()
        .filter(|(at, _)| !order.block.contains(at))
        .filter_map(|(&at, (body, _))| {
            let old = order.old(at).expect("an old line");
            let start = order.engine.line_start(old);
            Some((old, diff(start, order.engine.line(old).body(), body)?))
        })
        .collect();
    Arrival { lines, numbers }
}
