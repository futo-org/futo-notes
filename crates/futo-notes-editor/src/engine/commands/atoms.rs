//! Images and wikilinks as one unit: a range touching part of one takes it
//! whole, and Backspace or Delete reaching into one removes it whole. A
//! wikilink edits as text from a caret inside its brackets, where hosts draw
//! it as typed while it is written.
use super::super::command::{Command, Edit};
use super::super::{store, Engine};
use crate::lines::SpanKind;
use crate::{CaretDirection, DisplayOffset, DisplayRange, EditorError, ParagraphKey};

/// An image or a wikilink on a line, by its display range.
struct Atom {
    range: DisplayRange,
    wikilink: bool,
}

impl Atom {
    fn overlaps(&self, start: usize, end: usize) -> bool {
        self.range.start.0 < end && start < self.range.end.0
    }

    fn holds(&self, at: usize) -> bool {
        self.range.start.0 < at && at < self.range.end.0
    }
}

impl Engine {
    /// Keys around an atom: a caret's Backspace or Delete whose one-grapheme
    /// step reaches into an image or a wikilink removes it whole (not a
    /// wikilink the caret is inside); Enter on a selection that is exactly
    /// one image acts after it.
    pub(super) fn atom_key(
        &self,
        range: DisplayRange,
        key: ParagraphKey,
    ) -> Result<Option<Command>, EditorError> {
        match key {
            ParagraphKey::Enter | ParagraphKey::ShiftEnter => {
                let is_image = range.start != range.end
                    && self
                        .atoms_in(range.start.0, range.end.0)
                        .iter()
                        .any(|atom| !atom.wikilink && atom.range == range);
                if !is_image {
                    return Ok(None);
                }
                let after = DisplayRange {
                    start: range.end,
                    end: range.end,
                };
                match self.key_command(after, key)? {
                    Some(command) => Ok(Some(command)),
                    None => self.typed_key(after, key),
                }
            }
            ParagraphKey::Backspace
            | ParagraphKey::BackspaceJoiningHeading
            | ParagraphKey::PairedBackspace
            | ParagraphKey::Delete
                if range.start == range.end =>
            {
                let direction = if key == ParagraphKey::Delete {
                    CaretDirection::Forward
                } else {
                    CaretDirection::Backward
                };
                let caret = range.start.0;
                let deletion = self.caret_deletion(caret, direction);
                let (mut start, mut end) = (deletion.start.0, deletion.end.0);
                let mut found = false;
                for atom in self.atoms_in(start, end) {
                    if atom.overlaps(start, end) && !atom.holds(caret) {
                        start = start.min(atom.range.start.0);
                        end = end.max(atom.range.end.0);
                        found = true;
                    }
                }
                if !found {
                    return Ok(None);
                }
                let whole = DisplayRange {
                    start: DisplayOffset(start),
                    end: DisplayOffset(end),
                };
                let plan = self.plan(whole, "");
                let first = self.line_of(plan.range.start);
                let last = self.line_of(plan.range.end);
                Ok(Some(Command::new(
                    vec![Edit::new(plan.range, plan.inserted)],
                    first..last + 1,
                    plan.caret..plan.caret,
                )))
            }
            _ => Ok(None),
        }
    }

    /// `range` with its ends out of atoms. A caret strictly inside an image
    /// moves to the image's nearer edge (after, on a tie): its only caret
    /// stops are before and after it, so input at a caret never lands in its
    /// hidden source. A caret inside a wikilink stays: it edits the link as
    /// text. A range touching part of an image includes the whole image,
    /// and one reaching a wikilink's edge from inside it the whole wikilink.
    /// A range strictly inside a wikilink's brackets stays, as does any range
    /// within it while the caret is inside it (a Backspace or Delete step
    /// from there).
    pub(crate) fn outside_atoms(&self, range: DisplayRange) -> DisplayRange {
        if range.start != range.end {
            let caret =
                (self.selection.start == self.selection.end).then_some(self.selection.start.0);
            let mut whole = range;
            for atom in self.atoms_in(range.start.0, range.end.0) {
                let (start, end) = (atom.range.start.0, atom.range.end.0);
                let within = start <= range.start.0 && range.end.0 <= end;
                let strictly_within = start < range.start.0 && range.end.0 < end;
                let edits_text = atom.wikilink
                    && (strictly_within || (within && caret.is_some_and(|at| atom.holds(at))));
                if atom.overlaps(range.start.0, range.end.0) && !edits_text {
                    whole.start.0 = whole.start.0.min(atom.range.start.0);
                    whole.end.0 = whole.end.0.max(atom.range.end.0);
                }
            }
            return whole;
        }
        let at = range.start.0;
        let Some(image) = self
            .atoms_in(at, at)
            .into_iter()
            .find(|atom| !atom.wikilink && atom.holds(at))
        else {
            return range;
        };
        let edge = if at - image.range.start.0 < image.range.end.0 - at {
            image.range.start
        } else {
            image.range.end
        };
        DisplayRange {
            start: edge,
            end: edge,
        }
    }

    /// The images and wikilinks on the lines showing display offsets
    /// `start` and `end`.
    fn atoms_in(&self, start: usize, end: usize) -> Vec<Atom> {
        let (first, _) = self.line_at_display(store::display, start);
        let (last, _) = self.line_at_display(store::display, end);
        let mut atoms = Vec::new();
        for index in first..=last {
            let entry = self.line(index);
            let before = self.store.before(index);
            for span in &entry.spans {
                let wikilink = match span.kind {
                    SpanKind::Image { .. } => false,
                    SpanKind::Wikilink { .. } => true,
                    _ => continue,
                };
                atoms.push(Atom {
                    range: DisplayRange {
                        start: DisplayOffset(before.display + entry.to_display(span.range.start)),
                        end: DisplayOffset(before.display + entry.to_display(span.range.end)),
                    },
                    wikilink,
                });
            }
        }
        atoms
    }
}
