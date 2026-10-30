//! History anchors belong to their entry's before/after source generation.
//! Exact stage transfer relocates source, never a later display projection.
use super::*;
use crate::history::SourceSelection;

impl EditorSession {
    pub(super) fn capture_history_selection(&self) -> (SourceSelection, usize) {
        if !self.projection.references_complete && self.context.origin.is_none() {
            return (SourceSelection::Derived, 0);
        }
        let (range, work) = self
            .projection
            .source_selection(self.selection, self.affinity);
        (SourceSelection::Exact(range), work)
    }

    pub(super) fn project_history_selection(
        &self,
        selection: SourceSelection,
        fallback: DisplayRange,
    ) -> (DisplayRange, usize) {
        match selection {
            SourceSelection::Exact(range) => {
                let (start, a) = self.projection.display_at_with_work(range.start.source.0);
                let (end, z) = if range.start == range.end {
                    (start, 0)
                } else {
                    self.projection.display_at_with_work(range.end.source.0)
                };
                (
                    DisplayRange {
                        start: DisplayOffset(start + range.start.within),
                        end: DisplayOffset(end + range.end.within),
                    },
                    a + z,
                )
            }
            // Derived sessions can use their own local history. This is not
            // permission to relocate it into canonical source coordinates.
            SourceSelection::Derived => (fallback, 0),
        }
    }
}
