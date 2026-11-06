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
    /// What committing `text` over `range` formats. A commit keeps the
    /// characters it shares with the range's start and end (reconversion), so
    /// those keep their committed formats; the changed middle is typed text and
    /// takes the formats typing there carries: the carried (pending) formats at
    /// the caret, or the formats of the first character it replaces.
    pub(super) fn marked_runs(&self, range: DisplayRange, text: &str) -> Vec<MarkedRun> {
        let original = self
            .projection
            .display
            .byte_slice(range.start.0..range.end.0)
            .to_string();
        let prefix = original
            .char_indices()
            .zip(text.chars())
            .find(|((_, a), b)| a != b)
            .map_or(original.len().min(text.len()), |((at, _), _)| at);
        let suffix = original[prefix..]
            .chars()
            .rev()
            .zip(text[prefix..].chars().rev())
            .take_while(|(a, b)| a == b)
            .map(|(a, _)| a.len_utf8())
            .sum::<usize>();
        let mut runs = Vec::new();
        if prefix > 0 || suffix > 0 {
            let slice = self.projection.query(self.revision, range);
            let shift = text.len() as isize - original.len() as isize;
            for run in &slice.runs {
                let start = run.range.start.0 - range.start.0;
                let end = run.range.end.0 - range.start.0;
                let mut push = |start: usize, end: usize| {
                    if start < end && !run.formats.is_empty() {
                        runs.push(MarkedRun {
                            start,
                            end,
                            formats: sorted(run.formats.clone()),
                        });
                    }
                };
                push(start, end.min(prefix));
                let tail = original.len() - suffix;
                push(
                    (start.max(tail) as isize + shift) as usize,
                    (end.max(tail) as isize + shift) as usize,
                );
            }
        }
        let middle = prefix..text.len() - suffix;
        if !middle.is_empty() {
            let formats = if range == self.selection {
                self.active_formats()
            } else {
                let at = DisplayOffset(range.start.0 + prefix);
                let affinity = if prefix < original.len() - suffix || at.0 == 0 {
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
                    start: middle.start,
                    end: middle.end,
                    formats,
                });
            }
        }
        runs.sort_by_key(|run| run.start);
        runs
    }
}

fn sorted(mut formats: Vec<InlineFormat>) -> Vec<InlineFormat> {
    formats.sort();
    formats.dedup();
    formats
}
