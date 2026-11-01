//! A tight top-level bullet list, cut between top-level items.
use super::{Cut, CHUNK};
use pulldown_cmark::Tag;

/// A top-level item's marker byte and content column, measured like the
/// list metadata, or `None` when tabs or a wide indent make it context bound.
fn bullet_line(line: &str) -> Option<(u8, usize)> {
    let text = line.trim_start_matches(' ');
    let indent = line.len() - text.len();
    let marker = *text.as_bytes().first()?;
    if indent > 3 || !matches!(marker, b'-' | b'*' | b'+') {
        return None;
    }
    let rest = &text[1..];
    let padding = rest.bytes().take_while(|&b| b == b' ').count();
    if rest[padding..].starts_with('\t') {
        return None;
    }
    Some((marker, indent + 1 + if padding > 4 { 1 } else { padding }))
}

struct Item {
    line: usize,
    /// Marker byte and content column.
    marker: Option<(u8, usize)>,
    nested: bool,
}

/// A tight top-level bullet list. Cuts fall between items with the same
/// content column and no nested list, so neither the sink target nor the
/// previous content column depends on the other row.
pub(super) struct ListScan {
    pub(super) range: std::ops::Range<usize>,
    bullet: bool,
    items: Vec<Item>,
}

impl ListScan {
    pub(super) fn new(range: std::ops::Range<usize>, number: &Option<u64>) -> Self {
        Self {
            range,
            bullet: number.is_none(),
            items: Vec::new(),
        }
    }

    pub(super) fn nested(&mut self, source: &str, tag: &Tag<'_>, depth: usize, at: usize) {
        match tag {
            Tag::Item if depth == 1 => {
                let line = source[..at].rfind('\n').map_or(0, |end| end + 1);
                let marker = source[line..].split_inclusive('\n').next().unwrap_or("");
                self.items.push(Item {
                    line,
                    marker: bullet_line(marker),
                    nested: false,
                });
            }
            // Nested lists name a sink target; a code or HTML block ending an
            // item displays its final line ending only before a sibling.
            Tag::List(_) | Tag::CodeBlock(_) | Tag::HtmlBlock => {
                if let Some(item) = self.items.last_mut() {
                    item.nested = true;
                }
            }
            _ => {}
        }
    }

    pub(super) fn trimmed_end(&self, source: &str) -> usize {
        let text = &source[self.range.clone()];
        let kept = text.trim_end_matches([' ', '\t', '\r', '\n']).len();
        let line_end = text[kept..]
            .find('\n')
            .map_or(text.len(), |at| kept + at + 1);
        self.range.start + line_end
    }

    pub(super) fn reaches_end(&self, source: &str) -> bool {
        self.trimmed_end(source) == source.len()
    }

    pub(super) fn cuttable(&self, source: &str) -> bool {
        let body = &source[self.range.start..self.trimmed_end(source)];
        self.bullet
            && self.items.iter().all(|item| item.marker.is_some())
            && !body
                .split_inclusive('\n')
                .any(|line| line.trim_matches([' ', '\t', '\r', '\n']).is_empty())
    }

    /// Neither item beside a cut nests a block, so each row's first and last
    /// top-level lines name the list's own owner.
    pub(super) fn cuts(&self, cuts: &mut Vec<(usize, Cut)>) {
        let mut last = self.range.start;
        for pair in self.items.windows(2) {
            let (previous, item) = (&pair[0], &pair[1]);
            let column = |item: &Item| item.marker.map(|marker| marker.1);
            if !previous.nested
                && !item.nested
                && column(previous) == column(item)
                && item.line - last >= CHUNK
            {
                cuts.push((item.line, Cut::Continue));
                last = item.line;
            }
        }
    }

    /// The following row's first line continues this list as a sibling.
    pub(super) fn continued_by(&self, next: &str) -> bool {
        let Some(last) = self.items.last() else {
            return false;
        };
        !last.nested && last.marker.is_some() && bullet_line(next) == last.marker
    }
}
