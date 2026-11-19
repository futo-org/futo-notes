//! The move a drop makes: the lifted text inserted at the slot as it
//! arrives (`lists/arrival.rs`), taken out where it was, and the numbers
//! renumbered at both ends, as one command behind the guard.
use super::super::super::command::{Command, Edit};
use super::super::lists::{Arriving, Landing};
use super::Lifted;
use crate::engine::Engine;
use crate::lines::block;
use std::ops::Range;

impl Engine {
    /// What `lifted` is as it arrives.
    pub(super) fn arriving(&self, lifted: &Lifted) -> Arriving<'_> {
        match lifted {
            Lifted::Lines(lines) => Arriving::Lines(lines.clone()),
            Lifted::Image { line, span } => Arriving::Image(&self.line(*line).text[span.clone()]),
        }
    }

    /// How `lifted` lands at boundary `slot`; `None` when as written.
    pub(super) fn landing_at(&self, lifted: &Lifted, slot: usize) -> Option<Landing> {
        self.landing(&self.arriving(lifted), slot, self.inside_list(slot))
    }

    /// The move of the image at line-relative source `span` of line `index`
    /// to boundary `slot`: its source leaves the line, nothing else there
    /// changes, and it lands at the slot as a line of its own (an item when
    /// it arrives in a list), with a line ending of the note's after it
    /// (before it at the note's end). The selection follows
    /// `moved_selection`; a caret stays with its text. `None` when the line
    /// would read differently without the image (`---` a divider, ` text`
    /// an indented line); the lines it passes must read as the same kind of
    /// block afterwards.
    pub(super) fn image_move_command(
        &self,
        index: usize,
        span: Range<usize>,
        slot: usize,
    ) -> Option<Command> {
        let count = self.line_count();
        let entry = self.line(index);
        let mut left = entry.text.clone();
        left.replace_range(span.clone(), "");
        let read = block::read_line(&mut entry.carry.clone(), &left, 0);
        if (&read.kind, read.quote) != (&entry.line.kind, entry.line.quote) {
            return None;
        }
        let lifted = Lifted::Image {
            line: index,
            span: span.clone(),
        };
        let landing = self.landing_at(&lifted, slot);
        let mut arrival = self.arrival(&self.arriving(&lifted), slot, landing.as_ref());
        let written = arrival.lines.remove(0);
        let base = self.line_start(index);
        let span = base + span.start..base + span.end;
        let ending = self.line_ending_near(index);
        let (at, text, lead) = if slot == count {
            let len = self.source_len();
            (len, format!("{ending}{}", written.body), ending.len())
        } else {
            let at = self.line_start(slot);
            (at, format!("{}{ending}", written.body), 0)
        };
        let mut edits = vec![Edit::insert(at, text), Edit::new(span.clone(), "")];
        let window = index.min(slot)..(index + 1).max(slot);
        let shift = usize::from(slot <= index);
        let same_kind = window.clone().map(|line| (line, line + shift)).collect();
        let mut command = Command::new(Vec::new(), window, 0..0);
        for (line, edit) in arrival.numbers {
            edits.push(edit);
            command.lines.push(line..line + 1);
        }
        command.edits = edits;
        let lands = command.map(at, false) + lead;
        let after = slot < count;
        let shown = written.body.len();
        command.selection = self.moved_selection(
            &command,
            span.clone(),
            |at| lands + written.map(at - span.start).min(shown),
            |at| command.map(at, after),
        );
        command.same_kind = same_kind;
        Some(command)
    }

    /// The move of `block` to boundary `slot` (one of its slots): the
    /// block's text, as it arrives, inserted at the slot and removed where
    /// it was, and the numbers it changes; the selection following
    /// `moved_selection`. Every line it passes, and the block's own, must
    /// read as the same kind of block afterwards, but a plain first line
    /// that becomes an item.
    pub(super) fn move_command(&self, block: Range<usize>, slot: usize) -> Command {
        let count = self.line_count();
        let (s, e) = (block.start, block.end);
        let lifted = Lifted::Lines(block.clone());
        let landing = self.landing_at(&lifted, slot);
        let arrival = self.arrival(&self.arriving(&lifted), slot, landing.as_ref());
        let (from, to) = (self.line_start(s), self.line_start(e));
        // Where each moved line starts in the text that lands.
        let mut starts = Vec::with_capacity(e - s);
        let mut text = String::new();
        for (index, written) in (s..e).zip(&arrival.lines) {
            starts.push(text.len());
            text.push_str(&written.body);
            text.push_str(self.line(index).ending());
        }
        let len = self.source_len();
        let (mut edits, at, lead, shown) = if e == count {
            // The last line moves up: it takes the ending of the line above
            // it, which becomes the last line.
            let above = self.line(s - 1);
            let at = self.line_start(slot);
            let removed = self.line_start(s - 1) + above.body_len()..len;
            let insert = Edit::insert(at, format!("{text}{}", above.ending()));
            (vec![insert, Edit::new(removed, "")], at, 0, text.len())
        } else if slot == count {
            // To the end: the line that was last takes the block's ending.
            let ending = self.line(e - 1).ending();
            let body = &text[..text.len() - ending.len()];
            let insert = Edit::insert(len, format!("{ending}{body}"));
            (
                vec![insert, Edit::new(from..to, "")],
                len,
                ending.len(),
                body.len(),
            )
        } else {
            let at = self.line_start(slot);
            let insert = Edit::insert(at, text.clone());
            (vec![insert, Edit::new(from..to, "")], at, 0, text.len())
        };
        let window = s.min(slot)..e.max(slot);
        let moved = e - s;
        let place = |index: usize| match index {
            index if block.contains(&index) && slot < s => slot + (index - s),
            index if block.contains(&index) => slot - moved + (index - s),
            index if slot < s => index + moved,
            index => index - moved,
        };
        let becomes_item = landing.as_ref().is_some_and(|landing| landing.becomes_item);
        let same_kind = window
            .clone()
            .filter(|&index| !(becomes_item && index == s))
            .map(|index| (index, place(index)))
            .collect();
        let mut command = Command::new(Vec::new(), window, 0..0);
        for (line, edit) in arrival.numbers {
            edits.push(edit);
            command.lines.push(line..line + 1);
        }
        command.edits = edits;
        let block_start = command.map(at, false) + lead;
        // A position in the block keeps its place in its line's text; one
        // in a rewritten indent, marker or box lands where the text starts.
        // `shown` is what is left of the block's text where it lands: moved
        // to the end, it leaves its ending behind.
        let travel = |at: usize| {
            let inside = if at >= to {
                text.len()
            } else {
                let index = self.line_of(at);
                let (written, local) = (&arrival.lines[index - s], at - self.line_start(index));
                let old_len = self.line(index).body_len();
                starts[index - s]
                    + match local.checked_sub(old_len) {
                        Some(past) if past > 0 => written.body.len() + past,
                        _ => written.map(local),
                    }
            };
            block_start + inside.min(shown)
        };
        // A caret in the block moves with its text; one at the slot's line
        // start stays on that line, below the block, and one at the note's
        // end stays on the line the block now follows.
        let after = slot < count;
        command.selection = self.moved_selection(&command, from..to, travel, |at| {
            if at >= from && (at < to || (at == to && e == count)) {
                travel(at)
            } else {
                command.map(at, after)
            }
        });
        command.same_kind = same_kind;
        command
    }
}
