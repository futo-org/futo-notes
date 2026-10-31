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

    pub(crate) fn has_fields(&self) -> bool {
        !self.ranges.is_empty() || !self.delimiters.is_empty()
    }

    /// A logical emitted window is owned by the planner. Every payload field
    /// still needs complete copied-source correspondence; no clipped atom.
    pub(crate) fn map_copied(
        &self,
        window: Range<usize>,
        mut map: impl FnMut(Range<usize>) -> (Option<Range<usize>>, usize),
    ) -> Result<Self, crate::EditorError> {
        let mut mapped = Self {
            window,
            ranges: Vec::new(),
            delimiters: Vec::new(),
            work: self.work + 2,
        };
        for (before, after) in [
            (&self.ranges, &mut mapped.ranges),
            (&self.delimiters, &mut mapped.delimiters),
        ] {
            for range in before {
                let (found, work) = map(range.clone());
                mapped.work += 3 + work;
                let found = found.ok_or(crate::EditorError::UnrepresentableFormat)?;
                if found.start < mapped.window.start
                    || found.end > mapped.window.end
                    || found.is_empty()
                {
                    return Err(crate::EditorError::UnrepresentableFormat);
                }
                after.push(found);
            }
        }
        Ok(mapped)
    }

    /// Apply one actual source-only repair step to still-owned raw fields.
    /// Starts at an insertion move Right; ends there stay Left. Overwritten
    /// or internally split identities require correspondence and are rejected.
    pub(crate) fn source_step(
        &mut self,
        range: Range<usize>,
        inserted: usize,
    ) -> Result<(), crate::EditorError> {
        if range.start < self.window.start || range.end > self.window.end {
            return Err(crate::EditorError::UnrepresentableFormat);
        }
        let removed = range.len();
        for field in self.ranges.iter_mut().chain(&mut self.delimiters) {
            self.work += 1;
            if range.end <= field.start {
                field.start = field.start - removed + inserted;
                field.end = field.end - removed + inserted;
                self.work += 2;
            } else if field.end <= range.start {
            } else {
                return Err(crate::EditorError::UnrepresentableFormat);
            }
        }
        self.window.end = self.window.end - removed + inserted;
        self.work += 1;
        Ok(())
    }

    pub fn after_window(&self, edit: &SourceEdit) -> Range<usize> {
        self.window.start..self.window.end - edit.removed.len() + edit.inserted.len()
    }
}
