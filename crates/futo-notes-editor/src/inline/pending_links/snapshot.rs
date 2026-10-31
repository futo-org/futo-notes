//! Owned pending source snapshots and explicit coordinate steps.
use crate::SourceEdit;
use std::ops::Range;

#[derive(Clone)]
pub(crate) struct PendingLinks {
    pub window: Range<usize>,
    pub ranges: Vec<Range<usize>>,
    pub delimiters: Vec<Range<usize>>,
    pub work: usize,
}
impl PendingLinks {
    /// Translate exact source windows, including every transient witness.
    pub(crate) fn relocate_source(&mut self, origin: usize) -> usize {
        self.window.start += origin;
        self.window.end += origin;
        for range in self.ranges.iter_mut().chain(&mut self.delimiters) {
            range.start += origin;
            range.end += origin;
        }
        2 * (1 + self.ranges.len() + self.delimiters.len())
    }

    pub fn after_window(&self, edit: &SourceEdit) -> Range<usize> {
        self.window.start..self.window.end - edit.removed.len() + edit.inserted.len()
    }
}
