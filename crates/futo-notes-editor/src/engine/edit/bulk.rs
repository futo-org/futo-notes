//! Apply a command's neighboring source edits in one line re-read.
use super::{Batch, Edit, Engine};

impl Engine {
    /// Sorted, non-overlapping edits in the original source coordinates.
    pub(crate) fn raw_edits(&mut self, batch: &mut Batch, edits: &[Edit]) {
        // Apply neighboring line edits together. Renumbering a list otherwise
        // re-reads and re-indexes the same neighbors once for every item.
        // Last group first keeps the original source offsets valid.
        let mut end = edits.len();
        while end > 0 {
            let mut start = end - 1;
            while start > 0
                && self.line_of(edits[start].range.start)
                    <= self.line_of(edits[start - 1].range.end) + 1
            {
                start -= 1;
            }
            let group = &edits[start..end];
            if group.len() == 1 {
                self.raw(batch, group[0].range.clone(), &group[0].text);
            } else {
                let from = group[0].range.start;
                let to = group[group.len() - 1].range.end;
                let mut inserted = String::new();
                let mut at = from;
                for edit in group {
                    inserted.push_str(&self.source_slice(at..edit.range.start));
                    inserted.push_str(&edit.text);
                    at = edit.range.end;
                }
                self.raw(batch, from..to, &inserted);
            }
            end = start;
        }
    }
}
