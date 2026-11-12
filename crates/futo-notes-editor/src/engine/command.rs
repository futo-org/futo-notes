//! Commands. Every command has one shape: it reads the lines it is pointed
//! at and the selection, and returns text edits plus a new selection. It
//! edits the lines it names and nothing else (renumbering a numbered list is
//! the one exception, and names the lines it bumps).
//!
//! `run` applies a command as one action behind one guard: after the edits,
//! the lines around them are read forward until the reader's carry settles.
//! If a line the command did not name now reads as a different kind of
//! block (a fence or front matter opened or closed, a table header gained or
//! lost), the command is cancelled: no edit, no history entry. Typing never
//! goes through the guard.
use super::edit::{Batch, Change};
use super::history::Group;
use super::line::Entry;
use super::{read, store, Engine};
use crate::lines::{block, Carry, FenceRole, FrontMatterRole, Kind, Line, TableRole};
use crate::{Affinity, DisplayOffset, DisplayRange, EditorError, Revision, SourceEdit};
use std::ops::Range;

/// One text edit, in source offsets of the text before the command.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Edit {
    pub range: Range<usize>,
    pub text: String,
}

impl Edit {
    pub fn new(range: Range<usize>, text: impl Into<String>) -> Self {
        Self {
            range,
            text: text.into(),
        }
    }

    pub fn insert(at: usize, text: impl Into<String>) -> Self {
        Self::new(at..at, text)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Command {
    /// Non-overlapping edits, in any order.
    pub edits: Vec<Edit>,
    /// The lines the command names, as non-empty ranges of line indices
    /// before it. Each edit lies inside them: from the first named line's
    /// start through the last named line's ending. Named lines may change
    /// kind; no other line may.
    pub lines: Vec<Range<usize>>,
    /// The selection after the edits, in source offsets of the new text.
    pub selection: Range<usize>,
    /// The affinity of a collapsed caret; `None` keeps what landing there picks.
    pub affinity: Option<Affinity>,
    /// Typing: a key's plain text edit, which always lands (no guard).
    pub typed: bool,
}

impl Command {
    /// A command naming `lines` that leaves the selection at `selection`
    /// (source offsets after the edits).
    pub fn new(edits: Vec<Edit>, lines: Range<usize>, selection: Range<usize>) -> Self {
        Self {
            edits,
            lines: vec![lines],
            selection,
            affinity: None,
            typed: false,
        }
    }

    /// Where source offset `at` (before the edits) lands after them. An
    /// offset strictly inside an edit's removed text, or at an insertion's
    /// point, lands after the edit's text when `after`, else before it.
    pub fn map(&self, at: usize, after: bool) -> usize {
        let mut out = at as isize;
        for edit in &self.edits {
            let (start, end) = (edit.range.start, edit.range.end);
            let growth = edit.text.len() as isize - (end - start) as isize;
            if end < at || (end == at && start < end) {
                out += growth;
            } else if start < at || (start == at && end == at) {
                // `at` is inside this edit (`at <= end` here).
                out -= (at - start) as isize;
                if after {
                    out += edit.text.len() as isize;
                }
            }
        }
        out as usize
    }
}

/// What kind of block a line reads as, for the guard. Text-driven facts
/// (indent, quote depth, marker spelling) cannot change on a line the
/// command does not edit, so only the kind and frame role count.
fn class(kind: &Kind) -> (u8, u8) {
    match kind {
        Kind::Plain { .. } => (0, 0),
        Kind::Blank => (1, 0),
        Kind::Heading { .. } => (2, 0),
        Kind::List { .. } => (3, 0),
        Kind::Divider => (4, 0),
        Kind::FrontMatter(role) => (
            5,
            match role {
                FrontMatterRole::Open => 0,
                FrontMatterRole::Body => 1,
                FrontMatterRole::Close => 2,
            },
        ),
        Kind::Fence { role, .. } => (
            6,
            match role {
                FenceRole::Open => 0,
                FenceRole::Code => 1,
                FenceRole::Close => 2,
            },
        ),
        Kind::Table { role, .. } => (
            7,
            match role {
                TableRole::Header => 0,
                TableRole::Delimiter => 1,
                TableRole::Row => 2,
            },
        ),
    }
}

/// A line's class read alone: a header is read as the plain line it is
/// until the delimiter row under it, which is compared on its own.
fn alone(kind: &Kind) -> (u8, u8) {
    match kind {
        Kind::Table {
            role: TableRole::Header,
            ..
        } => (0, 0),
        kind => class(kind),
    }
}

/// The guard's record of the lines around a command, taken before it runs.
struct Before {
    /// Line 1, the line above the named lines and the unnamed lines between
    /// them: index before the command, and class.
    lines: Vec<(usize, (u8, u8))>,
    /// Each named range's end (ranges sorted and merged), with the lines
    /// the named ranges up to it gain (or lose) in all.
    deltas: Vec<(usize, isize)>,
    /// The first line after the named ones and the carry at its start.
    after: Option<(usize, Carry)>,
}

impl Before {
    /// Where unnamed line `index` (before the command) is after it.
    fn shift(&self, index: usize) -> usize {
        let at = self.deltas.partition_point(|(end, _)| *end <= index);
        let moved = at.checked_sub(1).map_or(0, |last| self.deltas[last].1);
        (index as isize + moved) as usize
    }
}

fn newlines(text: &str) -> isize {
    text.bytes().filter(|&b| b == b'\n').count() as isize
}

impl Engine {
    /// The guard's record. Every step is a binary search or one pass, so a
    /// command naming many separate lines costs no more than its lines.
    fn before_command(&self, command: &Command, edits: &[Edit]) -> Result<Before, EditorError> {
        let count = self.store.len();
        if command.lines.is_empty()
            || command
                .lines
                .iter()
                .any(|range| range.is_empty() || range.end > count)
        {
            return Err(EditorError::InvalidRange);
        }
        let mut sorted = command.lines.clone();
        sorted.sort_by_key(|range| range.start);
        let mut ranges: Vec<Range<usize>> = Vec::with_capacity(sorted.len());
        for range in sorted {
            match ranges.last_mut() {
                Some(last) if range.start <= last.end => last.end = last.end.max(range.end),
                _ => ranges.push(range),
            }
        }
        let named = |index: usize| {
            let at = ranges.partition_point(|range| range.end <= index);
            ranges.get(at).is_some_and(|range| range.start <= index)
        };
        let (first, end) = (ranges[0].start, ranges[ranges.len() - 1].end);
        let mut lines: Vec<(usize, (u8, u8))> = Vec::new();
        let mut look = |index: usize| {
            // Only line 1 and the line above come before the ascending run,
            // so only they can repeat an index.
            if !named(index) && lines.iter().take(2).all(|(seen, _)| *seen != index) {
                lines.push((index, class(&self.store.get(index).line.kind)));
            }
        };
        look(0);
        if first > 0 {
            look(first - 1);
        }
        for index in first..end {
            look(index);
        }
        // Each edit's line count change goes to the named range holding it.
        let bounds: Vec<(usize, usize)> = ranges
            .iter()
            .map(|range| {
                (
                    self.store.before(range.start).source,
                    self.store.before(range.end).source,
                )
            })
            .collect();
        let mut gained = vec![0isize; ranges.len()];
        for edit in edits {
            let at = bounds.partition_point(|&(_, to)| to < edit.range.end);
            if bounds
                .get(at)
                .is_some_and(|&(from, _)| edit.range.start >= from)
            {
                gained[at] +=
                    newlines(&edit.text) - newlines(&self.source_slice(edit.range.clone()));
            }
        }
        let mut total = 0;
        let deltas = ranges
            .iter()
            .zip(gained)
            .map(|(range, gained)| {
                total += gained;
                (range.end, total)
            })
            .collect();
        let lowest = self.store.before(first).source;
        let highest = self.store.before(end).source;
        if edits
            .iter()
            .any(|edit| edit.range.start < lowest || edit.range.end > highest)
        {
            debug_assert!(false, "a command edits a line it does not name: {edits:?}");
            return Err(EditorError::InvalidRange);
        }
        Ok(Before {
            lines,
            deltas,
            after: (end < count).then(|| (end, self.store.get(end).carry.clone())),
        })
    }

    /// Whether, after the edits, every line the command did not name reads
    /// as the same kind of block as before.
    fn guard_holds(&self, before: &Before) -> bool {
        let count = self.store.len();
        for &(index, was) in &before.lines {
            let now = before.shift(index);
            if now >= count || class(&self.store.get(now).line.kind) != was {
                return false;
            }
        }
        let Some((end, carry)) = &before.after else {
            return true;
        };
        // Read the unnamed lines below as they read before, until the carry
        // they had matches the carry they have.
        let mut old = carry.clone();
        let mut index = before.shift(*end);
        while index < count {
            let entry = self.store.get(index);
            if entry.carry == old {
                return true;
            }
            let was = block::read_line(&mut old, &entry.text, 0);
            if alone(&was.kind) != alone(&entry.line.kind) {
                return false;
            }
            index += 1;
        }
        true
    }

    /// Run the command `build` makes from the engine's state, as one action
    /// behind the guard. Pending marked text commits first, in the same
    /// acceptance and as its own undo step, and `build` reads the note with
    /// it in place. `None` when nothing changed or the guard cancelled.
    pub(crate) fn run(
        &mut self,
        expected: Revision,
        build: impl FnOnce(&Engine) -> Result<Option<Command>, EditorError>,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<Change>, EditorError> {
        self.check_revision(expected)?;
        let opening = self.point();
        let marked = self.composition.take();
        let mut batch = Batch::default();
        let mut committed = None;
        if let Some(marked) = &marked {
            let commit = self.plan_input(self.outside_crlf(marked.range), &marked.text);
            self.raw(&mut batch, commit.range.clone(), &commit.inserted);
            self.caret_at(commit.caret);
            committed = Some((batch.records.len(), self.point()));
        }
        let restore = |engine: &mut Self, batch: Batch| {
            engine.revert(batch);
            engine.restore(&opening);
            engine.composition = marked.clone();
        };
        let command = match build(self) {
            Ok(command) => command,
            Err(error) => {
                restore(self, batch);
                return Err(error);
            }
        };
        let mut applied = false;
        if let Some(command) = &command {
            match self.apply(&mut batch, command) {
                Ok(true) => applied = true,
                Ok(false) => {
                    // Cancelled: keep only the commit, if there is one.
                    restore(self, batch);
                    if marked.is_none() {
                        return Ok(None);
                    }
                    self.composition = None;
                    batch = Batch::default();
                    let marked = marked.as_ref().expect("marked text");
                    let commit = self.plan_input(self.outside_crlf(marked.range), &marked.text);
                    self.raw(&mut batch, commit.range.clone(), &commit.inserted);
                    self.caret_at(commit.caret);
                }
                Err(error) => {
                    restore(self, batch);
                    return Err(error);
                }
            }
        }
        let accepted = match self.accept(batch, accept) {
            Ok(accepted) => accepted,
            Err(error) => {
                self.restore(&opening);
                self.composition = marked;
                return Err(error);
            }
        };
        let Some((edit, shown, mut records)) = accepted else {
            self.restore(&opening);
            return Ok(None);
        };
        self.typing = None;
        self.formats = None;
        self.history.redo.clear();
        let mut before = opening;
        if let Some((count, after_commit)) = committed {
            let rest = records.split_off(count);
            if records.iter().any(|r| r.removed != r.inserted) {
                self.history.undo.push(Group {
                    records,
                    before,
                    after: after_commit.clone(),
                });
                before = after_commit;
            }
            records = rest;
        }
        if applied {
            let command = command.expect("an applied command");
            self.land(command.selection, command.affinity);
        }
        if !records.is_empty() {
            self.history.undo.push(Group {
                records,
                before,
                after: self.point(),
            });
        }
        Ok(Some(self.change(edit, shown)))
    }

    /// Apply `command`'s edits to `batch`, then the guard. `false` when the
    /// guard fails (the edits stay in `batch` for the caller to revert).
    fn apply(&mut self, batch: &mut Batch, command: &Command) -> Result<bool, EditorError> {
        let mut edits = command.edits.clone();
        edits.sort_by_key(|edit| (edit.range.start, edit.range.end));
        for edit in &edits {
            if edit.range.start > edit.range.end {
                return Err(EditorError::InvalidRange);
            }
            self.check_source(edit.range.start)?;
            self.check_source(edit.range.end)?;
        }
        if edits
            .windows(2)
            .any(|pair| pair[0].range.end > pair[1].range.start)
        {
            return Err(EditorError::InvalidRange);
        }
        let before = if command.typed {
            None
        } else {
            Some(self.before_command(command, &edits)?)
        };
        // Last first, so earlier offsets stay valid.
        for edit in edits.iter().rev() {
            self.raw(batch, edit.range.clone(), &edit.text);
        }
        Ok(before.is_none_or(|before| self.guard_holds(&before)))
    }

    /// Put the selection at source `range` of the current text.
    pub(crate) fn land(&mut self, range: Range<usize>, affinity: Option<Affinity>) {
        if range.start == range.end {
            self.caret_at(range.start);
            if let Some(affinity) = affinity {
                if self.pin.is_none() {
                    self.affinity = affinity;
                }
            }
            return;
        }
        self.pin = None;
        let selection = DisplayRange {
            start: DisplayOffset(self.display_of(range.start)),
            end: DisplayOffset(self.display_of(range.end)),
        };
        self.selection = self.outside_metadata(self.outside_crlf(selection));
        if let Some(affinity) = affinity {
            self.affinity = affinity;
        }
    }

    // ---- What commands read ----

    pub(crate) fn line(&self, index: usize) -> &Entry {
        self.store.get(index)
    }

    pub(crate) fn line_count(&self) -> usize {
        self.store.len()
    }

    /// Source offset where line `index` starts.
    pub(crate) fn line_start(&self, index: usize) -> usize {
        self.store.before(index).source
    }

    /// The line holding source offset `at`.
    pub(crate) fn line_of(&self, at: usize) -> usize {
        read::line_at(&self.store, at).0
    }

    /// The selection in source offsets: a collapsed caret where it maps,
    /// else from the first visible source after its start to the last
    /// before its end.
    pub(crate) fn source_selection(&self, range: DisplayRange) -> Range<usize> {
        if range.start == range.end {
            if range == self.selection {
                let at = self.caret_source();
                return at..at;
            }
            let (lo, hi) = self.source_bounds(range.start.0);
            let at = if self.affinity == Affinity::Backward {
                lo
            } else {
                hi
            };
            return at..at;
        }
        let start = self.source_bounds(range.start.0).1;
        let end = self.source_bounds(range.end.0).0.max(start);
        start..end
    }

    /// The lines display `range` touches. A selection that ends at the very
    /// start of a line's display does not touch that line.
    pub(crate) fn lines_of(&self, range: DisplayRange) -> Range<usize> {
        let source = self.source_selection(range);
        let first = self.line_of(source.start);
        let (mut last, _) = self.line_at_display(store::display, range.end.0);
        if range.start != range.end && last > first {
            let start = self.store.before(last).display;
            if range.end.0 == start {
                last -= 1;
            }
        }
        first..last.max(first) + 1
    }
}

/// `prefix` then `text`, with a `\` written into `text` when without it the
/// line would not read as `keeps` wants, after `carry`. Removing the bullet
/// from `- # todo` keeps a plain line by writing `\# todo`. Nothing is
/// escaped when the line already reads as wanted, or when no `\` helps.
pub(crate) fn kept_line(
    carry: &Carry,
    prefix: &str,
    text: &str,
    keeps: impl Fn(&Line) -> bool,
) -> String {
    let read = |line: &str| {
        let mut carry = carry.clone();
        carry.first = false;
        block::read_line(&mut carry, line, 0)
    };
    let plain = format!("{prefix}{text}");
    if keeps(&read(&plain)) {
        return plain;
    }
    let lead = text.len() - text.trim_start_matches([' ', '\t']).len();
    let rest = &text[lead..];
    let at = match rest.bytes().next() {
        Some(b) if b.is_ascii_punctuation() => Some(lead),
        Some(b) if b.is_ascii_digit() => {
            let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
            matches!(rest.as_bytes().get(digits), Some(b'.' | b')')).then_some(lead + digits)
        }
        _ => None,
    };
    if let Some(at) = at {
        let escaped = format!("{prefix}{}\\{}", &text[..at], &text[at..]);
        if keeps(&read(&escaped)) {
            return escaped;
        }
    }
    plain
}
