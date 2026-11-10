//! In-memory exact patch history. The clock controls grouping, never durability.
use crate::{Affinity, DisplayRange, InlineFormat, SourceOffset, SourceRange};
use ropey::Rope;
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Native marked text stays provisional. Only its final commit enters source,
/// as one isolated history action, never joined with preceding/following typing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum InputAction {
    Typing,
    Isolated,
    CompositionCommit,
}

/// Nonoverlapping replacements in ascending opening-display coordinates.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DisplayUtf16Replacement {
    pub range: crate::DisplayUtf16Range,
    pub inserted: Vec<u16>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DisplayReplacement {
    pub range: DisplayRange,
    pub inserted: String,
}
/// Injected monotonic elapsed time. A backwards reading starts a new group;
/// neither this clock nor an elapsed grouping delay acknowledges persistence.
pub trait HistoryClock: Send + Sync {
    fn now(&self) -> Duration;
}

pub(crate) struct MonotonicClock(web_time::Instant);
impl Default for MonotonicClock {
    fn default() -> Self {
        Self(web_time::Instant::now())
    }
}
impl HistoryClock for MonotonicClock {
    fn now(&self) -> Duration {
        self.0.elapsed()
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) struct SourceAtom {
    pub source_len: usize,
    pub display_len: usize,
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) struct SourcePoint {
    pub source: SourceOffset,
    /// An interior boundary of one decoded source atom, in visible UTF-8 bytes.
    pub within: usize,
    pub atom: Option<SourceAtom>,
}
#[derive(Clone, Copy)]
pub(crate) struct ExactSelection {
    pub start: SourcePoint,
    pub end: SourcePoint,
}
#[derive(Clone, Copy)]
pub(crate) enum SourceSelection {
    Exact(ExactSelection),
    Derived,
}

pub(crate) struct HistoryEntry {
    pub(crate) before_source: SourceSelection,
    pub(crate) after_source: SourceSelection,
    pub(crate) before_selection: DisplayRange,
    pub(crate) before_affinity: Affinity,
    pub(crate) before_links: crate::inline::PendingLinks,
    pub(crate) before_formats: Option<Vec<InlineFormat>>,
    pub(crate) after_selection: DisplayRange,
    pub(crate) after_affinity: Affinity,
    pub(crate) after_links: crate::inline::PendingLinks,
    pub(crate) after_formats: Option<Vec<InlineFormat>>,
    pub(crate) range: SourceRange,
    pub(crate) removed: String,
    pub(crate) inserted: String,
}

impl HistoryEntry {
    pub(crate) fn relocate_exact(
        &mut self,
        source: usize,
        display: usize,
    ) -> Result<usize, crate::EditorError> {
        let (SourceSelection::Exact(before), SourceSelection::Exact(after)) =
            (&mut self.before_source, &mut self.after_source)
        else {
            return Err(crate::EditorError::UnrepresentableFormat);
        };
        before.start.source.0 += source;
        before.end.source.0 += source;
        after.start.source.0 += source;
        after.end.source.0 += source;
        self.range.start.0 += source;
        self.range.end.0 += source;
        self.before_selection.start.0 += display;
        self.before_selection.end.0 += display;
        self.after_selection.start.0 += display;
        self.after_selection.end.0 += display;
        Ok(10
            + self.before_links.relocate_source(source)
            + self.after_links.relocate_source(source))
    }
}

pub(crate) struct HistoryGroup {
    pub entries: Vec<HistoryEntry>,
    /// The engine-written run (start, source bytes) before and after the group.
    pub written: [Option<(usize, String)>; 2],
}
impl HistoryGroup {
    pub fn new(entries: Vec<HistoryEntry>) -> Self {
        Self {
            entries,
            written: [None, None],
        }
    }
}
/// The user input that owns a source edit, including any necessary local repair.
pub(crate) struct HistoryInput<'a> {
    pub range: DisplayRange,
    pub inserted: &'a str,
    pub action: InputAction,
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum TypingKind {
    Insert,
    BackwardDelete,
    ForwardDelete,
}
pub(crate) struct TypingRun {
    kind: TypingKind,
    selection: DisplayRange,
    at: Duration,
}
impl TypingRun {
    pub fn new(kind: TypingKind, selection: DisplayRange, at: Duration) -> Self {
        Self {
            kind,
            selection,
            at,
        }
    }
    pub fn relocate(mut self, display_start: usize, accepted_at: Duration) -> Self {
        self.selection.start.0 += display_start;
        self.selection.end.0 += display_start;
        self.at = accepted_at;
        self
    }
    pub fn continues(&self, kind: TypingKind, range: DisplayRange, now: Duration) -> bool {
        let adjacent = match kind {
            TypingKind::Insert | TypingKind::ForwardDelete => range.start == self.selection.end,
            TypingKind::BackwardDelete => range.end == self.selection.end,
        };
        self.kind == kind
            && adjacent
            && now
                .checked_sub(self.at)
                .is_some_and(|elapsed| elapsed < Duration::from_millis(500))
    }
}
pub(crate) fn typing_kind(
    range: DisplayRange,
    inserted: &str,
    selection: DisplayRange,
) -> Option<TypingKind> {
    use unicode_segmentation::UnicodeSegmentation;
    if range.start == range.end
        && inserted.graphemes(true).count() == 1
        && !inserted.contains(['\r', '\n'])
    {
        Some(TypingKind::Insert)
    } else if inserted.is_empty() && range.start != range.end && selection.start == selection.end {
        if range.end == selection.end {
            Some(TypingKind::BackwardDelete)
        } else if range.start == selection.end {
            Some(TypingKind::ForwardDelete)
        } else {
            None
        }
    } else {
        None
    }
}

/// Compose sequential source patches over a cheap Rope clone. Only the affected
/// envelope is materialized, once, for one recovery acceptance and view change.
/// Ordinary recording retains patches and never composes a growing typing run.
pub(crate) struct Transaction {
    source: Rope,
    footprint: Option<(usize, usize, usize)>, // start, opening end, current end
}
impl Transaction {
    pub fn new(source: &Rope) -> Self {
        Self {
            source: source.clone(),
            footprint: None,
        }
    }
    pub fn apply(&mut self, range: SourceRange, inserted: &str) {
        let (a, z) = (range.start.0, range.end.0);
        self.footprint = Some(match self.footprint {
            None => (a, z, a + inserted.len()),
            Some((start, old_end, current_end)) => (
                start.min(a),
                old_end + z.saturating_sub(current_end),
                current_end.max(z) - (z - a) + inserted.len(),
            ),
        });
        let start = self.source.byte_to_char(a);
        let end = self.source.byte_to_char(z);
        self.source.remove(start..end);
        self.source.insert(start, inserted);
    }
    pub fn finish(self) -> (SourceRange, String) {
        let (start, old_end, current_end) = self.footprint.unwrap();
        (
            SourceRange {
                start: SourceOffset(start),
                end: SourceOffset(old_end),
            },
            self.source.byte_slice(start..current_end).to_string(),
        )
    }
}
