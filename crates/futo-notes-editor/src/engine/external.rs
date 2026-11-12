//! Taking in a change made outside the editor (sync, another program).
//!
//! The store prepares an adoption of the merged source before it writes the
//! disk, and applies it after. Preparing maps the selection through the
//! outside change and rebases every retained undo and redo group onto it:
//! each historical text is merged with the outside contribution, each record
//! must land on bytes both texts copy unchanged, and must turn one rebased
//! text into the next exactly; anything else refuses before anything
//! changes. Applying replaces the note's changed window as one ordinary
//! edit, read again incrementally, and restores the rebased stacks.
use super::edit::{Batch, Change};
use super::history::{Group, History, Point, Record};
use super::line::trimmed;
use super::Engine;
use crate::{
    Affinity, DisplayOffset, DisplayRange, EditorError, InlineFormat, Revision, SourceEdit,
    SourceOffset, SourceRange, ViewChange,
};
use futo_notes_merge::{three_way_merge, MergeResult};
use similar::{ChangeTag, TextDiff};
use std::ops::Range;

/// Rebasing reads every retained historical text: the current or merged
/// bytes plus every retained record's bytes must fit in this, and that
/// estimate times the record count in `HISTORY_WORK`.
const HISTORY_BYTES: usize = 1024 * 1024;
const HISTORY_WORK: usize = 16 * 1024 * 1024;
/// Without history the note may be any size; a changed window larger than
/// this maps the selection through the window instead of a character diff.
const DIFF_BYTES: usize = 1024 * 1024;

type Accept<'a> = &'a mut dyn FnMut(&SourceEdit) -> Result<(), String>;

/// An adoption prepared against one revision and selection.
pub(crate) struct Adoption {
    revision: Revision,
    opening: Point,
    /// The changed window; `None` when the merged text is the current text.
    edit: Option<SourceEdit>,
    selection: Mark,
    /// The rebased undo and redo stacks; `None` drops both.
    stacks: Option<(Vec<Group>, Vec<Group>)>,
}

impl Adoption {
    pub(crate) fn revision(&self) -> Revision {
        self.revision
    }

    pub(crate) fn edit(&self) -> Option<&SourceEdit> {
        self.edit.as_ref()
    }
}

impl Engine {
    /// Prepare taking in `merged`. With `keep_history` every retained undo
    /// and redo group is rebased onto the outside contribution, or the
    /// adoption is refused (`UnrepresentableFormat`): on ambiguity, over the
    /// size bounds, or when the change touches front matter. Without it both
    /// stacks are dropped and outside bytes may rewrite front matter.
    pub(crate) fn prepare_external(
        &self,
        expected: Revision,
        merged: &str,
        keep_history: bool,
    ) -> Result<Adoption, EditorError> {
        self.check_revision(expected)?;
        if self.composition.is_some() {
            return Err(EditorError::CompositionActive);
        }
        let opening = self.point();
        let original = self.source_text();
        let (prefix, suffix) = window(&original, merged);
        if prefix == original.len() && prefix == merged.len() {
            return Ok(Adoption {
                revision: expected,
                selection: self.mark(&opening),
                opening,
                edit: None,
                stacks: None,
            });
        }
        let revision = self
            .revision
            .0
            .checked_add(1)
            .map(Revision)
            .ok_or(EditorError::RevisionExhausted)?;
        if keep_history {
            self.check_bounds(merged.len())?;
            let (old, new) = (front_matter_end(&original), front_matter_end(merged));
            if (old.is_some() || new.is_some())
                && (old != new || old.is_some_and(|end| prefix < end))
            {
                return Err(EditorError::UnrepresentableFormat);
            }
        }
        let limit = if keep_history { usize::MAX } else { DIFF_BYTES };
        let map = Map::new(&original, merged, limit);
        let selection = self.mark(&opening).through(&map);
        let stacks = if keep_history {
            Some((
                rebase(&self.history.undo, false, &original, merged)?,
                rebase(&self.history.redo, true, &original, merged)?,
            ))
        } else {
            None
        };
        let edit = SourceEdit {
            previous_revision: self.revision,
            revision,
            range: SourceRange {
                start: SourceOffset(prefix),
                end: SourceOffset(original.len() - suffix),
            },
            removed: original[prefix..original.len() - suffix].to_owned(),
            inserted: merged[prefix..merged.len() - suffix].to_owned(),
        };
        Ok(Adoption {
            revision: expected,
            opening,
            edit: Some(edit),
            selection,
            stacks,
        })
    }

    /// Apply a prepared adoption: the changed window as one edit through
    /// `accept`, the mapped selection and the rebased (or dropped) stacks.
    /// Nothing changes, and `StaleClaim` returns, when the selection moved
    /// since it was prepared; `None` when the text was already the same.
    pub(crate) fn adopt(
        &mut self,
        plan: Adoption,
        accept: Accept,
    ) -> Result<Option<Change>, EditorError> {
        self.check_revision(plan.revision)?;
        if self.composition.is_some() {
            return Err(EditorError::CompositionActive);
        }
        if self.point() != plan.opening {
            return Err(EditorError::StaleClaim);
        }
        let Some(edit) = plan.edit else {
            return Ok(None);
        };
        let mut batch = Batch::default();
        self.raw(
            &mut batch,
            edit.range.start.0..edit.range.end.0,
            &edit.inserted,
        );
        let Some((applied, shown, _)) = self.accept(batch, accept)? else {
            return Ok(None);
        };
        debug_assert_eq!(applied, edit);
        let point = self.shown(&plan.selection);
        self.restore(&point);
        self.history = match plan.stacks {
            Some((undo, redo)) => History { undo, redo },
            None => History::default(),
        };
        self.typing = None;
        Ok(Some(self.change(applied, shown)))
    }

    pub(crate) fn adopt_view(
        &mut self,
        plan: Adoption,
        accept: Accept,
    ) -> Result<ViewChange, EditorError> {
        Ok(match self.adopt(plan, accept)? {
            Some(change) => self.view(change),
            None => self.unchanged(),
        })
    }

    /// Refuse a history too large to rebase: the bound is on the work, not
    /// on the note or the history themselves.
    fn check_bounds(&self, merged: usize) -> Result<(), EditorError> {
        let records = self
            .history
            .undo
            .iter()
            .chain(&self.history.redo)
            .flat_map(|group| &group.records);
        let (mut count, mut bytes) = (0usize, self.source_len().max(merged));
        for record in records {
            count = count.saturating_add(1);
            bytes = bytes
                .saturating_add(record.removed.len())
                .saturating_add(record.inserted.len());
        }
        if bytes > HISTORY_BYTES || bytes.saturating_mul(count.max(1)) > HISTORY_WORK {
            return Err(EditorError::UnrepresentableFormat);
        }
        Ok(())
    }

    /// A point as the source offsets it stands at.
    fn mark(&self, point: &Point) -> Mark {
        let selection = point.selection;
        let (start, end) = if selection.start == selection.end {
            let at = point.pin.unwrap_or_else(|| {
                let (lo, hi) = self.source_bounds(selection.start.0);
                match point.affinity {
                    Affinity::Backward => lo,
                    Affinity::Forward => hi,
                }
            });
            (at, at)
        } else {
            (
                self.source_bounds(selection.start.0).0,
                self.source_bounds(selection.end.0).1,
            )
        };
        Mark {
            start,
            end,
            pin: point.pin,
            affinity: point.affinity,
            formats: point.formats.clone(),
        }
    }

    /// A marked point shown in this text. A caret keeps a pin only where its
    /// affinity alone would not stand it at the same source offset.
    fn shown(&self, mark: &Mark) -> Point {
        let (selection, mut pin) = if mark.start == mark.end {
            let display = self.display_of(mark.start);
            let (lo, hi) = self.source_bounds(display);
            let side = match mark.affinity {
                Affinity::Backward => lo,
                Affinity::Forward => hi,
            };
            let pin = if mark.pin.is_some() {
                (lo != hi).then_some(mark.start)
            } else {
                Some(mark.start.clamp(lo, hi)).filter(|&at| at != side)
            };
            (caret(display), pin)
        } else {
            let range = DisplayRange {
                start: DisplayOffset(self.display_of(mark.start)),
                end: DisplayOffset(self.display_of(mark.end)),
            };
            (range, mark.pin)
        };
        let outside = self.outside_metadata(self.outside_crlf(selection));
        if outside != selection {
            pin = None;
        }
        Point {
            selection: outside,
            affinity: mark.affinity,
            formats: mark.formats.clone(),
            pin,
        }
    }
}

fn caret(at: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(at),
        end: DisplayOffset(at),
    }
}

/// A selection as source offsets, with what it carries.
#[derive(Clone, Debug)]
struct Mark {
    start: usize,
    end: usize,
    pin: Option<usize>,
    affinity: Affinity,
    formats: Option<Vec<InlineFormat>>,
}

impl Mark {
    fn through(self, map: &Map) -> Self {
        Self {
            start: map.point(self.start),
            end: map.point(self.end),
            pin: self.pin.map(|pin| map.point(pin)),
            ..self
        }
    }
}

/// Where front matter ends (after its closing line's ending), as the line
/// reader decides it: line 1 is `---` and a later line is `---`.
fn front_matter_end(text: &str) -> Option<usize> {
    let mut lines = text.split_inclusive('\n');
    let first = lines.next()?;
    if trimmed(first) != "---" {
        return None;
    }
    let mut end = first.len();
    for line in lines {
        end += line.len();
        if trimmed(line) == "---" {
            return Some(end);
        }
    }
    None
}

/// The bytes two texts share at their start and at their end, on character
/// boundaries and not overlapping.
fn window(old: &str, new: &str) -> (usize, usize) {
    let mut prefix = old
        .bytes()
        .zip(new.bytes())
        .take_while(|(a, b)| a == b)
        .count();
    while !old.is_char_boundary(prefix) || !new.is_char_boundary(prefix) {
        prefix -= 1;
    }
    let most = old.len().min(new.len()) - prefix;
    let mut suffix = old
        .bytes()
        .rev()
        .zip(new.bytes().rev())
        .take(most)
        .take_while(|(a, b)| a == b)
        .count();
    while !old.is_char_boundary(old.len() - suffix) || !new.is_char_boundary(new.len() - suffix) {
        suffix -= 1;
    }
    (prefix, suffix)
}

/// Which bytes of one text another copies unchanged: the shared start and
/// end, and inside the changed window the equal runs of a character diff
/// (left out when the window is larger than `limit`).
struct Map {
    /// Copied runs: the range in the old text and where it starts in the new.
    equal: Vec<(Range<usize>, usize)>,
    new_len: usize,
}

impl Map {
    fn new(old: &str, new: &str, limit: usize) -> Self {
        let (prefix, suffix) = window(old, new);
        let mut map = Self {
            equal: Vec::new(),
            new_len: new.len(),
        };
        map.push(0..prefix, 0);
        let (a, b) = (
            &old[prefix..old.len() - suffix],
            &new[prefix..new.len() - suffix],
        );
        if !a.is_empty() && !b.is_empty() && a.len().max(b.len()) <= limit {
            let (mut x, mut y) = (prefix, prefix);
            for change in TextDiff::from_chars(a, b).iter_all_changes() {
                let len = change.value().len();
                match change.tag() {
                    ChangeTag::Equal => {
                        map.push(x..x + len, y);
                        x += len;
                        y += len;
                    }
                    ChangeTag::Delete => x += len,
                    ChangeTag::Insert => y += len,
                }
            }
        }
        map.push(old.len() - suffix..old.len(), new.len() - suffix);
        map
    }

    fn push(&mut self, old: Range<usize>, new: usize) {
        if old.is_empty() {
            return;
        }
        if let Some((last, start)) = self.equal.last_mut() {
            if last.end == old.start && *start + last.len() == new {
                last.end = old.end;
                return;
            }
        }
        self.equal.push((old, new));
    }

    /// Where old offset `at` lands: in a copied run, on the same byte;
    /// elsewhere after whatever replaced it.
    fn point(&self, at: usize) -> usize {
        let index = self.equal.partition_point(|(old, _)| old.end <= at);
        match self.equal.get(index) {
            Some((old, new)) if old.start <= at => new + at - old.start,
            Some((_, new)) => *new,
            None => self.new_len,
        }
    }

    /// Where old `range` starts in the new text, when one copied run holds it.
    fn copied(&self, range: Range<usize>) -> Option<usize> {
        if range.is_empty() {
            return Some(self.point(range.start));
        }
        let index = self
            .equal
            .partition_point(|(old, _)| old.end <= range.start);
        let (old, new) = self.equal.get(index)?;
        (old.start <= range.start && range.end <= old.end).then(|| new + range.start - old.start)
    }
}

/// Rebase one stack onto the outside contribution. Undo walks back from the
/// current text, redo forward from it, each step merging that historical
/// text with the outside change. Two scratch cores follow the walk, one on
/// the local texts and one on the rebased texts, so each group's points are
/// shown in the text they belong to.
fn rebase(
    stack: &[Group],
    redo: bool,
    original: &str,
    merged: &str,
) -> Result<Vec<Group>, EditorError> {
    if stack.is_empty() {
        return Ok(Vec::new());
    }
    let mut walk = Walk {
        old: Engine::open(original),
        new: Engine::open(merged),
        old_text: original.to_owned(),
        new_text: merged.to_owned(),
        map: Map::new(original, merged, usize::MAX),
        original,
        merged,
    };
    let mut groups = Vec::with_capacity(stack.len());
    for group in stack.iter().rev() {
        let (first, last) = if redo {
            (&group.before, &group.after)
        } else {
            (&group.after, &group.before)
        };
        let first = walk.point(first);
        let mut records = Vec::with_capacity(group.records.len());
        if redo {
            for record in &group.records {
                records.push(walk.step(record, true)?);
            }
        } else {
            for record in group.records.iter().rev() {
                records.push(walk.step(record, false)?);
            }
            records.reverse();
        }
        let last = walk.point(last);
        let (before, after) = if redo { (first, last) } else { (last, first) };
        groups.push(Group {
            records,
            before,
            after,
        });
    }
    groups.reverse();
    Ok(groups)
}

struct Walk<'a> {
    /// The local historical text, and the same text with the outside change.
    old: Engine,
    new: Engine,
    old_text: String,
    new_text: String,
    map: Map,
    original: &'a str,
    merged: &'a str,
}

impl Walk<'_> {
    fn point(&self, point: &Point) -> Point {
        self.new.shown(&self.old.mark(point).through(&self.map))
    }

    /// Step over `record` (forward for redo, backward for undo) and return
    /// it rebased.
    fn step(&mut self, record: &Record, redo: bool) -> Result<Record, EditorError> {
        let refuse = || EditorError::UnrepresentableFormat;
        let (from, to) = if redo {
            (&record.removed, &record.inserted)
        } else {
            (&record.inserted, &record.removed)
        };
        let mut next_old = self.old_text.clone();
        let range = record.start..record.start + from.len();
        if next_old.get(range.clone()) != Some(from.as_str()) {
            return Err(refuse());
        }
        next_old.replace_range(range.clone(), to);
        let MergeResult::Clean(next_new) = three_way_merge(self.original, self.merged, &next_old)
        else {
            return Err(refuse());
        };
        let next_map = Map::new(&next_old, &next_new, usize::MAX);
        // The record was made against the text before it: it must stand on
        // bytes that text's rebased copy keeps, and turn that copy into the
        // rebased text after it, exactly.
        let (map, before, after) = if redo {
            (&self.map, &self.new_text, &next_new)
        } else {
            (&next_map, &next_new, &self.new_text)
        };
        let start = map
            .copied(record.start..record.start + record.removed.len())
            .ok_or_else(refuse)?;
        if !applies(before, start, &record.removed, &record.inserted, after) {
            return Err(refuse());
        }
        let mut scratch = Batch::default();
        self.old.raw(&mut scratch, range, to);
        let mut scratch = Batch::default();
        self.new.raw(&mut scratch, start..start + from.len(), to);
        self.old_text = next_old;
        self.new_text = next_new;
        self.map = next_map;
        Ok(Record {
            start,
            removed: record.removed.clone(),
            inserted: record.inserted.clone(),
        })
    }
}

/// Whether replacing `removed` at `start` in `before` with `inserted` gives
/// exactly `after`.
fn applies(before: &str, start: usize, removed: &str, inserted: &str, after: &str) -> bool {
    let end = start + removed.len();
    before.get(start..end) == Some(removed)
        && after.len() + removed.len() == before.len() + inserted.len()
        && after.get(..start) == before.get(..start)
        && after.get(start..start + inserted.len()) == Some(inserted)
        && after.get(start + inserted.len()..) == before.get(end..)
}
