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
    /// Leading front matter bytes of `text`, reparsed as the metadata row.
    pub metadata: usize,
    /// Length and shape of each replacement row.
    pub pieces: Vec<(usize, row::Shape)>,
    /// Source copied and parsed by boundary scans and refused attempts.
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
        let old_metadata = self.metadata_len();
        let (metadata, metadata_scanned) = self.metadata_after(source, edit, old_metadata);
        let mut first = if metadata != old_metadata || edit.range.start.0 < old_metadata {
            0
        } else {
            // Unchanged metadata never joins its neighbor; leave it untouched.
            let first = self
                .rows
                .locate(edit.range.start.0, false)
                .saturating_sub(1);
            first.max(usize::from(metadata > 0 && self.rows.len() > 1))
        };
        let mut last = (self.rows.locate(edit.range.end.0, false) + 1).min(self.rows.len() - 1);
        // A cut paragraph whose meaning reaches outside the window widens to
        // its complete extent once; seams elsewhere remain sealed.
        let mut partition_bytes = metadata_scanned;
        let mut footnote_step = 1;
        loop {
            let (_, source_start, display_start) = self.rows.at(first);
            let (row, old_end, display_end) = self.rows.at(last);
            let source_end = old_end + row.source_len - edit.removed.len() + edit.inserted.len();
            if source_end < metadata && last + 1 < self.rows.len() {
                last += 1;
                continue;
            }
            let display_end = display_end + row.display.len();
            let text = source.byte_slice(source_start..source_end).to_string();
            let metadata = if source_start == 0 { metadata } else { 0 };
            let first_row = self.rows.at(first).0;
            let opener = first_row.opener.as_deref().filter(|_| metadata == 0);
            let next = self.continued_line(source, last + 1, source_end);
            let next_opener = next
                .as_ref()
                .and_then(|_| self.rows.at(last + 1).0.opener.clone());
            // The row after a raw HTML block's end condition starts without a
            // blank line; the window's new meaning may continue into it.
            if next.is_none() && last + 1 < self.rows.len() && !ends_blank(&text) {
                partition_bytes += text.len();
                last += 1;
                continue;
            }
            // A raw HTML block, unclosed fence or footnote that still owns the
            // window's final blank continues into following rows; reinterpret
            // them too. A cut continuation row instead proves its own seam.
            let (open, parsed) = match opener {
                Some(opener) => row::open_at_end(&format!("{opener}{text}")),
                None => row::open_at_end(&text),
            };
            partition_bytes += parsed;
            match open {
                Some(_) if last + 1 >= self.rows.len() => {}
                Some(row::OpenEnd::Html | row::OpenEnd::Code) if next_opener.is_some() => {}
                Some(row::OpenEnd::Html | row::OpenEnd::Code) => {
                    partition_bytes += text.len();
                    last = self.rows.len() - 1;
                    continue;
                }
                Some(row::OpenEnd::Footnote) => {
                    // Double the step: a long definition costs linear work.
                    partition_bytes += text.len();
                    footnote_step *= 2;
                    last = (last + footnote_step).min(self.rows.len() - 1);
                    continue;
                }
                None => {}
            }
            let body = &text[metadata..];
            let outside = Outside {
                continues: metadata == 0 && first_row.continues,
                first_number: first_row.first_number(),
                opener,
                next: next.as_deref(),
                next_opener: next_opener.as_deref(),
                followed: last + 1 < self.rows.len(),
            };
            let found = partition(body, outside);
            // A block reaching the window end owns a following blank row, and
            // its range takes the indent of a following indented line.
            if !found.widen_forward
                && found.open_tail
                && next.is_none()
                && last + 1 < self.rows.len()
            {
                let next_len = self.rows.at(last + 1).0.source_len;
                let following = source.byte_slice(source_end..source_end + next_len);
                let indented = following
                    .bytes()
                    .next()
                    .is_some_and(|b| b == b' ' || b == b'\t');
                // A list item there may continue the list ending the window;
                // its marker alone decides, so only the marker is read.
                let prefix = following.slice(..following.len_chars().min(16)).to_string();
                let line = prefix.lines().next().unwrap_or_default();
                let item = list_marker(line).is_some_and(|rest| {
                    let marker = &line[..line.len() - rest.len()];
                    partition_bytes += text.len() + marker.len();
                    row::reaches_into(&text, marker)
                });
                if item
                    || empty_item_tail(&text)
                    || indented
                    || following.bytes().all(|b| b.is_ascii_whitespace())
                {
                    partition_bytes += text.len();
                    last += 1;
                    continue;
                }
            }
            if !found.widen_back && !found.widen_forward {
                let pieces: Vec<_> = found
                    .rows
                    .iter()
                    .map(|piece| (piece.text.len(), piece.shape.clone()))
                    .collect();
                return Window {
                    first,
                    last,
                    source_start,
                    display_start,
                    source_end,
                    display_end,
                    text,
                    metadata,
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

/// An empty list item owns a following blank line only at the end of the
/// note; before a paragraph that blank leaves the list.
fn empty_item_tail(text: &str) -> bool {
    if !ends_blank(text) {
        return false;
    }
    let Some(line) = text.trim_end().rsplit('\n').next() else {
        return false;
    };
    list_marker(line).is_some_and(|rest| rest.trim().is_empty())
}

/// The text after a list marker starting `line` within three spaces.
fn list_marker(line: &str) -> Option<&str> {
    let body = line.trim_start_matches(' ');
    if line.len() - body.len() > 3 {
        return None;
    }
    let digits = body.len() - body.trim_start_matches(|c: char| c.is_ascii_digit()).len();
    match body.as_bytes().get(digits)? {
        b'-' | b'*' | b'+' if digits == 0 => {}
        b'.' | b')' if (1..=9).contains(&digits) => {}
        _ => return None,
    }
    let rest = &body[digits + 1..];
    (rest.is_empty() || rest.starts_with([' ', '\t', '\r', '\n'])).then_some(rest)
}

/// Whether `text` ends with a blank line, the separator every uncut row ends at.
fn ends_blank(text: &str) -> bool {
    let body = text.strip_suffix('\n').unwrap_or(text);
    body.rsplit('\n')
        .next()
        .is_some_and(|line| line.trim().is_empty())
        && body.len() < text.len()
}
