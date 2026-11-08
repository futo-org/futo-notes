//! How marked text is drawn: the inline formats it will have once committed.
use super::*;
use serde::{Deserialize, Serialize};

/// One formatted stretch of marked text, in byte offsets into `Composition::text`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MarkedRun {
    pub start: usize,
    pub end: usize,
    pub formats: Vec<InlineFormat>,
}

impl EditorSession {
    /// What committing `text` over `range` formats. A commit replaces only the
    /// stretches that differ (reconversion), so the characters it shares keep
    /// their committed formats; each changed stretch is typed text and takes the
    /// formats typing there carries: the carried (pending) formats at the caret,
    /// or the formats of the first character it replaces. The stretches are the
    /// ones the commit itself replaces (`os_replacement::differing_runs`).
    pub(super) fn marked_runs(&self, range: DisplayRange, text: &str) -> Vec<MarkedRun> {
        let original = self
            .projection
            .display
            .byte_slice(range.start.0..range.end.0)
            .to_string();
        let replacements = crate::session::os_replacement::differing_runs(&original, text, 0);
        let slice = self.projection.query(self.revision, range);
        let mut runs = Vec::new();
        // The shared stretch of the original `old` becomes `new..` in `text`.
        let mut keep =
            |old: std::ops::Range<usize>, new_start: usize, runs: &mut Vec<MarkedRun>| {
                for run in &slice.runs {
                    let start = (run.range.start.0 - range.start.0).max(old.start);
                    let end = (run.range.end.0 - range.start.0).min(old.end);
                    if start < end && !run.formats.is_empty() {
                        runs.push(MarkedRun {
                            start: start - old.start + new_start,
                            end: end - old.start + new_start,
                            formats: sorted(run.formats.clone()),
                        });
                    }
                }
            };
        let (mut old_at, mut new_at) = (0, 0);
        for replacement in &replacements {
            let (start, end) = (replacement.range.start.0, replacement.range.end.0);
            keep(old_at..start, new_at, &mut runs);
            new_at += start - old_at;
            if !replacement.inserted.is_empty() {
                let formats = if range == self.selection && range.start == range.end {
                    self.active_formats()
                } else {
                    let at = DisplayOffset(range.start.0 + start);
                    let affinity = if start < end || at.0 == 0 {
                        Affinity::Forward
                    } else {
                        Affinity::Backward
                    };
                    let (low, high) = self.projection.source_bounds(at.0);
                    let source = match affinity {
                        Affinity::Backward => low,
                        Affinity::Forward => high,
                    };
                    sorted(self.projection.formats_at(source))
                };
                if !formats.is_empty() {
                    runs.push(MarkedRun {
                        start: new_at,
                        end: new_at + replacement.inserted.len(),
                        formats,
                    });
                }
            }
            new_at += replacement.inserted.len();
            old_at = end;
        }
        keep(old_at..original.len(), new_at, &mut runs);
        runs.sort_by_key(|run| run.start);
        runs
    }
}

fn sorted(mut formats: Vec<InlineFormat>) -> Vec<InlineFormat> {
    formats.sort();
    formats.dedup();
    formats
}
