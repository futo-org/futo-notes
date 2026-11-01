//! The reparse window of one source edit: the edited rows and a neighbor on
//! each side, widened when a cut block's meaning reaches outside it (#314).
use super::*;

pub(super) struct Window {
    pub first: usize,
    pub last: usize,
    pub source_start: usize,
    pub display_start: usize,
    pub source_end: usize,
    pub display_end: usize,
    pub text: String,
    /// Length, `continues` and `through` of each replacement row.
    pub pieces: Vec<(usize, bool, bool)>,
    /// Source copied and parsed by refused partition attempts.
    pub partition_bytes: usize,
}

impl Projection {
    /// The first line of row `index` at source `start`, when that row
    /// continues its predecessor's paragraph or list.
    pub(crate) fn continued_line(
        &self,
        source: &Rope,
        index: usize,
        start: usize,
    ) -> Option<String> {
        if index >= self.rows.len() || !self.rows.at(index).0.continues {
            return None;
        }
        let line = source.byte_to_line(start);
        Some(source.line(line).to_string())
    }

    pub(super) fn reparse_window(&self, source: &Rope, edit: &SourceEdit) -> Window {
        let mut first = self
            .rows
            .locate(edit.range.start.0, false)
            .saturating_sub(1);
        let mut last = (self.rows.locate(edit.range.end.0, false) + 1).min(self.rows.len() - 1);
        // A cut paragraph whose meaning reaches outside the window widens to
        // its complete extent once; seams elsewhere remain sealed.
        let mut partition_bytes = 0;
        loop {
            let (_, source_start, display_start) = self.rows.at(first);
            let (row, old_end, display_end) = self.rows.at(last);
            let source_end = old_end + row.source_len - edit.removed.len() + edit.inserted.len();
            let display_end = display_end + row.display.len();
            let text = source.byte_slice(source_start..source_end).to_string();
            let continues = self.rows.at(first).0.continues;
            let next = self.continued_line(source, last + 1, source_end);
            let found = partition(&text, continues, next.as_deref());
            // A list or code block ending the window owns following blank rows.
            let blank = |raw: &str| raw.trim_matches([' ', '\t', '\r', '\n']).is_empty();
            let last_line = text
                .trim_end_matches('\n')
                .rsplit('\n')
                .next()
                .unwrap_or("");
            if !found.widen_forward
                && last + 1 < self.rows.len()
                && (blank(last_line) || text.ends_with("\n\n"))
                && found.rows.last().is_some_and(|piece| !blank(piece.text))
            {
                let next_len = self.rows.at(last + 1).0.source_len;
                if blank(
                    &source
                        .byte_slice(source_end..source_end + next_len)
                        .to_string(),
                ) {
                    partition_bytes += text.len();
                    last += 1;
                    continue;
                }
            }
            if !found.widen_back && !found.widen_forward {
                let pieces: Vec<(usize, bool, bool)> = found
                    .rows
                    .iter()
                    .map(|piece| (piece.text.len(), piece.continues, piece.through))
                    .collect();
                return Window {
                    first,
                    last,
                    source_start,
                    display_start,
                    source_end,
                    display_end,
                    text,
                    pieces,
                    partition_bytes,
                };
            }
            partition_bytes += text.len();
            // Keep one neighbor row beyond the paragraph, as the local window does.
            if found.widen_back {
                while self.rows.at(first).0.continues {
                    first -= 1;
                }
                first = first.saturating_sub(1);
            }
            if found.widen_forward {
                while last + 1 < self.rows.len() && self.rows.at(last + 1).0.continues {
                    last += 1;
                }
                last = (last + 1).min(self.rows.len() - 1);
            }
        }
    }
}
