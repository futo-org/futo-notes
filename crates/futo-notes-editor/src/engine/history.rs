//! Undo history: the text edits an action made, plus the selection, affinity,
//! carried formats and caret pin before and after it. Undo applies the
//! reverse edits; there is no per-command undo code.
use crate::{Affinity, DisplayRange, InlineFormat};

/// Where the caret stood, and what typing there would carry.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Point {
    pub selection: DisplayRange,
    pub affinity: Affinity,
    pub formats: Option<Vec<InlineFormat>>,
    /// The exact source offset of a collapsed caret, when the display offset
    /// alone cannot say which side of hidden syntax it is on.
    pub pin: Option<usize>,
}

/// One text edit: at `start`, `removed` became `inserted`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Record {
    pub start: usize,
    pub removed: String,
    pub inserted: String,
}

/// One undo step: the records of one action (or one typing run), in order.
#[derive(Clone, Debug)]
pub(crate) struct Group {
    pub records: Vec<Record>,
    pub before: Point,
    pub after: Point,
}

#[derive(Default)]
pub(crate) struct History {
    pub undo: Vec<Group>,
    pub redo: Vec<Group>,
}
