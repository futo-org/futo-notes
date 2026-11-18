//! The note's lines in the order a move leaves it, for the slot trial
//! (`command/trial.rs`): the same bytes `move_command` and
//! `image_move_command` write, without copying the block. The first line
//! is written as it arrives (`Landing`), with the digits of the item below
//! for a number: the trial compares the lines a move may renumber without
//! their digits (`Renumbered`), and a number never changes how a line
//! reads. Lines under an item that changes
//! indent are read shifted, one at a time, as the trial reaches them. The
//! renumbered lines elsewhere are not in the trial: only their digits
//! change. The trial property (`tests/moves/trial.rs`) holds the two
//! descriptions together.
use super::super::super::command::trial::{Piece, Renumbered, Trial};
use super::super::lists::Landing;
use super::Lifted;
use crate::engine::Engine;
use crate::lines::block::{self, width};
use crate::lines::Kind;
use std::ops::Range;

impl Engine {
    /// The move of `lifted` to boundary `slot` as a trial; `None` when the
    /// move has no command (an image that cannot leave its line).
    pub(super) fn trial_of(&self, lifted: &Lifted, slot: usize) -> Option<Trial> {
        let landing = self.landing_at(lifted, slot);
        let renumbered = self.renumbered(lifted, landing.as_ref());
        let mut trial = match lifted {
            Lifted::Lines(block) => self.lines_trial(block.clone(), slot, landing),
            Lifted::Image { line, span } => self.image_trial(*line, span.clone(), slot, landing)?,
        };
        trial.renumbered = renumbered;
        Some(trial)
    }

    /// Which lines the move of `lifted`, landing as `landing` says, may
    /// renumber: the first moved line where it counts in a numbered list,
    /// and the numbered items at its own level and at the level it lands
    /// on.
    fn renumbered(&self, lifted: &Lifted, landing: Option<&Landing>) -> Renumbered {
        let moved = match lifted {
            Lifted::Lines(block) => block.clone(),
            Lifted::Image { .. } => 0..0,
        };
        let mut levels = Vec::new();
        if !moved.is_empty() {
            let entry = self.line(moved.start);
            if let Kind::List {
                ordered: true,
                indent,
                text,
                ..
            } = &entry.line.kind
            {
                if entry.line.quote == 0 {
                    levels.push((*indent, entry.body().as_bytes()[text.end - 1]));
                }
            }
        }
        let lands = landing.and_then(|landing| {
            let delimiter = landing.numbered_delimiter()?;
            Some((width(landing.space()), delimiter))
        });
        levels.extend(lands);
        Renumbered {
            levels,
            moved,
            first: lands.is_some(),
        }
    }

    /// The lines of `block` as they land, the last one ending with `last`
    /// instead of its own ending when given.
    fn landed(
        &self,
        block: Range<usize>,
        landing: Option<&Landing>,
        last: Option<&str>,
    ) -> Vec<Piece> {
        use Piece::{Line, Run, Shifted};
        let (s, e) = (block.start, block.end);
        let body = |index: usize| match (index, landing) {
            (index, Some(landing)) if index == s => {
                landing.first_line(self.line(s).body(), None).body
            }
            (
                index,
                Some(Landing {
                    shift: Some(shift), ..
                }),
            ) if index > s => {
                let text = shift.text(self.line(index));
                text[..text.len() - self.line(index).ending().len()].to_owned()
            }
            (index, _) => self.line(index).body().to_owned(),
        };
        let text = |index: usize| match (index == e - 1).then_some(last).flatten() {
            Some(ending) => body(index) + ending,
            None => body(index) + self.line(index).ending(),
        };
        let kept = if last.is_some() { e - 1 } else { e };
        let mut pieces = Vec::new();
        match landing {
            None => pieces.push(Run(s..kept)),
            Some(landing) => {
                let old = (!landing.becomes_item).then_some(s);
                pieces.push(Line(old, text(s)));
                if s + 1 < kept {
                    pieces.push(match landing.shift.clone() {
                        Some(shift) => Shifted(s + 1..kept, shift),
                        None => Run(s + 1..kept),
                    });
                }
            }
        }
        if last.is_some() && (landing.is_none() || e - 1 > s) {
            pieces.push(Line(Some(e - 1), text(e - 1)));
        }
        pieces.retain(|piece| !matches!(piece, Run(run) if run.is_empty()));
        pieces
    }

    /// Lines `s..e` moved to `slot`. The last line has no ending: a block
    /// leaving it gives the line above's ending to its own last line, and a
    /// block moving to the end gives its last line's ending to the line that
    /// was last.
    fn lines_trial(&self, block: Range<usize>, slot: usize, landing: Option<Landing>) -> Trial {
        use Piece::{Line, Run};
        let count = self.line_count();
        let (s, e) = (block.start, block.end);
        let landing = landing.as_ref();
        let text = |index: usize| self.line(index).text.clone();
        let body = |index: usize| self.line(index).body().to_owned();
        let mut pieces = Vec::new();
        if e == count {
            let ending = self.line(s - 1).ending();
            pieces.push(Run(0..slot));
            pieces.extend(self.landed(block, landing, Some(ending)));
            pieces.extend([Run(slot..s - 1), Line(Some(s - 1), body(s - 1))]);
        } else if slot == count {
            let ending = self.line(e - 1).ending();
            pieces.extend([
                Run(0..s),
                Run(e..count - 1),
                Line(Some(count - 1), text(count - 1) + ending),
            ]);
            pieces.extend(self.landed(block, landing, Some("")));
        } else if slot < s {
            pieces.push(Run(0..slot));
            pieces.extend(self.landed(block, landing, None));
            pieces.extend([Run(slot..s), Run(e..count)]);
        } else {
            pieces.extend([Run(0..s), Run(e..slot)]);
            pieces.extend(self.landed(block, landing, None));
            pieces.push(Run(slot..count));
        }
        let start = if slot < s { slot } else { slot - (e - s) };
        Trial {
            pieces,
            window: s.min(slot)..e.max(slot),
            landed: start..start + (e - s),
            renumbered: Renumbered::default(),
        }
    }

    /// The image at line-relative `span` of line `index` moved to `slot`:
    /// its line without it, and a line of its own at the slot.
    fn image_trial(
        &self,
        index: usize,
        span: Range<usize>,
        slot: usize,
        landing: Option<Landing>,
    ) -> Option<Trial> {
        use Piece::{Line, Run};
        let count = self.line_count();
        let entry = self.line(index);
        let mut left = entry.text.clone();
        left.replace_range(span.clone(), "");
        let read = block::read_line(&mut entry.carry.clone(), &left, 0);
        if (&read.kind, read.quote) != (&entry.line.kind, entry.line.quote) {
            return None;
        }
        let source = &entry.text[span];
        let image = match &landing {
            Some(landing) => landing.first_line(source, None).body,
            None => source.to_owned(),
        };
        let ending = self.line_ending_near(index);
        let pieces = if slot == count {
            let mut pieces = vec![Run(0..index)];
            if index + 1 == count {
                pieces.push(Line(Some(index), left + &ending));
            } else {
                pieces.push(Line(Some(index), left));
                pieces.push(Run(index + 1..count - 1));
                let last = self.line(count - 1).text.clone();
                pieces.push(Line(Some(count - 1), last + &ending));
            }
            pieces.push(Line(None, image));
            pieces
        } else if slot <= index {
            vec![
                Run(0..slot),
                Line(None, image + &ending),
                Run(slot..index),
                Line(Some(index), left),
                Run(index + 1..count),
            ]
        } else {
            vec![
                Run(0..index),
                Line(Some(index), left),
                Run(index + 1..slot),
                Line(None, image + &ending),
                Run(slot..count),
            ]
        };
        Some(Trial {
            pieces,
            window: index.min(slot)..(index + 1).max(slot),
            landed: slot..slot + 1,
            renumbered: Renumbered::default(),
        })
    }
}
