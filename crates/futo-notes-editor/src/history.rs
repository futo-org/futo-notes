//! In-memory exact patch history. The clock controls grouping, never durability.
use crate::DisplayRange;
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
