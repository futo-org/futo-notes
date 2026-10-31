//! Fixed exact boundary → input → physical parent source generations.
use super::*;
use crate::history::SourcePoint;
use std::ops::Range;

#[derive(Clone, Copy)]
pub(in crate::session) struct SourceStep {
    pub revision: Revision,
    pub range: SourceRange,
    pub inserted: usize,
}
impl SourceStep {
    pub fn read(edit: &SourceEdit) -> Self {
        Self {
            revision: edit.previous_revision,
            range: edit.range,
            inserted: edit.inserted.len(),
        }
    }
    pub fn matches(&self, revision: Revision, range: SourceRange, inserted: usize) -> bool {
        self.revision == revision && self.range == range && self.inserted == inserted
    }
}
pub(super) struct Protected {
    pub outer: SourceStep,
    pub boundary: SourceStep,
    pub window: Range<usize>,
    pub display_window: Range<usize>,
}
impl Protected {
    pub fn retained(
        &self,
        input: &InputSource,
        revision: Revision,
        range: SourceRange,
        inserted: usize,
        mut point: SourcePoint,
    ) -> (Option<SourcePoint>, usize) {
        if !self.outer.matches(revision, range, inserted) {
            return (None, 1);
        }
        let Some(local) = point.source.0.checked_sub(self.window.start) else {
            return (None, 2);
        };
        let extent = point.atom.map_or(0, |atom| atom.source_len);
        if local + extent > self.window.len() {
            return (None, 3);
        }
        point.source.0 = local;
        // The boundary is an actual insertion. Start/point uses Right bias;
        // a complete atom must remain wholly on one retained side.
        let boundary = self.boundary.range.start.0;
        if local < boundary && boundary < local + extent {
            return (None, 4);
        }
        if boundary <= local {
            point.source.0 += self.boundary.inserted;
        }
        let at = point.source.0;
        let end = at + extent;
        let touched = extent > 0 && at < input.range.end.0 && input.range.start.0 < end;
        let (mapped, visits) = if !touched && at < input.range.start.0 {
            (Some(point), 1)
        } else if !touched && input.range.end.0 <= at {
            point.source.0 = at - (input.range.end.0 - input.range.start.0) + input.inserted;
            (Some(point), 1)
        } else if !touched && at == input.range.start.0 && point.within == 0 {
            (Some(point), 1)
        } else {
            input.retained.map(point)
        };
        (
            mapped.map(|mut point| {
                point.source.0 += self.window.start;
                point
            }),
            visits + 8,
        )
    }
    pub fn retained_range(
        &self,
        input: &InputSource,
        range: Range<usize>,
    ) -> (Option<Range<usize>>, usize) {
        let Some(start) = range.start.checked_sub(self.window.start) else {
            return (None, 1);
        };
        let Some(end) = range.end.checked_sub(self.window.start) else {
            return (None, 2);
        };
        if start > end || end > self.window.len() {
            return (None, 3);
        }
        let at = self.boundary.range.start.0;
        if start < at && at < end {
            return (None, 4);
        }
        // Whole ranges ending at the insertion stay Left; ranges beginning
        // there move Right. No inserted separator becomes retained lineage.
        let (start, end) = if at <= start {
            (start + self.boundary.inserted, end + self.boundary.inserted)
        } else {
            (start, end)
        };
        let (mapped, work) = if end <= input.range.start.0 {
            (Some(start..end), 1)
        } else if input.range.end.0 <= start {
            let delta = |at| at - (input.range.end.0 - input.range.start.0) + input.inserted;
            (Some(delta(start)..delta(end)), 1)
        } else {
            input.retained.retained_range(start..end)
        };
        (
            mapped.map(|range| self.window.start + range.start..self.window.start + range.end),
            work + 8,
        )
    }
}
