//! A tight top-level list, cut between top-level items.
use super::{Cut, CHUNK};
use pulldown_cmark::Tag;

/// A top-level item's marker byte (bullet or ordered delimiter), physical
/// number and content column, measured like the list metadata, or `None`
/// when tabs or a wide indent make it context bound.
#[derive(Clone, Copy, PartialEq)]
struct Marker {
    byte: u8,
    number: Option<u64>,
    column: usize,
}

/// The list marker starting `line` within three spaces: its indent, digit
/// count, marker byte and the text after it, which starts with whitespace.
pub(crate) fn list_marker(line: &str) -> Option<(usize, usize, u8, &str)> {
    let text = line.trim_start_matches(' ');
    let indent = line.len() - text.len();
    let digits = text.bytes().take_while(u8::is_ascii_digit).count();
    let byte = *text.as_bytes().get(digits)?;
    let bullet = digits == 0 && matches!(byte, b'-' | b'*' | b'+');
    let ordered = (1..=9).contains(&digits) && matches!(byte, b'.' | b')');
    if !(bullet || ordered) {
        return None;
    }
    // The marker byte is ASCII, so the text after it starts on a boundary.
    let rest = &text[digits + 1..];
    let spaced = rest.is_empty() || rest.starts_with([' ', '\t', '\r', '\n']);
    (indent <= 3 && spaced).then_some((indent, digits, byte, rest))
}

fn marker_line(line: &str) -> Option<Marker> {
    let (indent, digits, byte, rest) = list_marker(line)?;
    let number = match digits {
        0 => None,
        _ => Some(line[indent..indent + digits].parse().ok()?),
    };
    let padding = rest.bytes().take_while(|&b| b == b' ').count();
    if rest[padding..].starts_with('\t') {
        return None;
    }
    let padding = if padding > 4 { 1 } else { padding };
    Some(Marker {
        byte,
        number,
        column: indent + digits + 1 + padding,
    })
}

struct Item {
    line: usize,
    marker: Option<Marker>,
    nested: bool,
}

/// A tight top-level list. Cuts fall between items with the same content
/// column and no nested list, so neither the sink target nor the previous
/// content column depends on the other row. An ordered list is cut only
/// before an item whose physical number is its ordinal, so each row's own
/// parse numbers its items as the whole list does.
pub(super) struct ListScan {
    pub(super) range: std::ops::Range<usize>,
    start: Option<u64>,
    items: Vec<Item>,
}

impl ListScan {
    pub(super) fn new(range: std::ops::Range<usize>, number: &Option<u64>) -> Self {
        Self {
            range,
            start: *number,
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
                    marker: marker_line(marker),
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
        self.items.iter().all(|item| item.marker.is_some())
            && !body
                .split_inclusive('\n')
                .any(|line| line.trim_matches([' ', '\t', '\r', '\n']).is_empty())
    }

    /// Neither item beside a cut nests a block, so each row's first and last
    /// top-level lines name the list's own owner.
    /// The physical number an item at `index` needs to be its ordinal.
    fn ordinal(&self, index: usize) -> Option<u64> {
        self.start.map(|start| start + index as u64)
    }

    pub(super) fn cuts(&self, cuts: &mut Vec<(usize, Cut)>) {
        let mut last = self.range.start;
        for (index, pair) in self.items.windows(2).enumerate() {
            let (previous, item) = (&pair[0], &pair[1]);
            let column = |item: &Item| item.marker.map(|marker| marker.column);
            if !previous.nested
                && !item.nested
                && column(previous) == column(item)
                && item.marker.and_then(|marker| marker.number) == self.ordinal(index + 1)
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
        let Some(marker) = last.marker.filter(|_| !last.nested) else {
            return false;
        };
        marker_line(next)
            == Some(Marker {
                number: self.ordinal(self.items.len()),
                ..marker
            })
    }
}
