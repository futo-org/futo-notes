//! A tight top-level list, cut between top-level items, or between sibling
//! items at any depth when the list holds only items, paragraphs and
//! headings: a row cut inside a nested list is parsed after its ancestors'
//! synthetic lines (its context).
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

/// An item at any depth: its marker restated, and the synthetic context line
/// it contributes as an ancestor (`None` when it cannot be restated).
#[derive(Clone)]
struct Open {
    marker: Marker,
    marker_column: usize,
    line: Option<String>,
    /// Where the item's line starts.
    start: usize,
}

/// A list at one depth: its start number, items so far and last item.
struct Level {
    start: Option<u64>,
    count: u64,
    last: Option<Open>,
}

/// A sibling item where a row may start, with its ancestors' context.
struct DeepCut {
    line: usize,
    depth: usize,
    context: Option<String>,
}

/// The item marker at `at` (spaces before it allowed): its marker column,
/// marker and the text after the marker, or `None` for tabs or no marker.
fn item_marker(source: &str, at: usize) -> Option<(usize, Marker, bool, Option<String>)> {
    let line = source[..at].rfind('\n').map_or(0, |end| end + 1);
    let text = &source[at..];
    let marker = at + (text.len() - text.trim_start_matches(' ').len());
    let before = &source[line..marker];
    if before.contains('\t') || !before.is_ascii() {
        return None;
    }
    let end = source[marker..]
        .find('\n')
        .map_or(source.len(), |end| marker + end + 1);
    let (_, digits, byte, rest) = list_marker(&source[marker..end])?;
    let number = match digits {
        0 => None,
        _ => Some(source[marker..marker + digits].parse().ok()?),
    };
    let padding = rest.bytes().take_while(|&b| b == b' ').count();
    if rest[padding..].starts_with('\t') {
        return None;
    }
    let body = rest[padding..].trim_end_matches(['\r', '\n']);
    let column = marker - line;
    let width = if padding > 4 { 1 } else { padding };
    let restated = (1..=4).contains(&padding)
        && !body.is_empty()
        && !body.starts_with(' ')
        && !body.contains('\r');
    let line_text = restated.then(|| {
        format!(
            "{}{}{}#\n",
            " ".repeat(column),
            &source[marker..marker + digits + 1],
            " ".repeat(padding)
        )
    });
    // A row may start here only where the line holds this marker first and
    // no second marker opens a list on the same line.
    let first =
        before.trim_start_matches(' ').is_empty() && list_marker(&rest[padding..]).is_none();
    Some((
        column,
        Marker {
            byte,
            number,
            column: column + digits + 1 + width,
        },
        first,
        line_text,
    ))
}

/// A tight top-level list. Cuts fall between sibling items with the same
/// content column, so the previous content column does not depend on the
/// other row. A list holding blocks other than items, paragraphs and headings
/// is cut only between top-level items without a nested block. An ordered
/// list is cut only before an item whose physical number is its ordinal, so
/// each row's own parse numbers its items as the whole list does; a context
/// restates only ancestors numbered so.
pub(super) struct ListScan {
    pub(super) range: std::ops::Range<usize>,
    start: Option<u64>,
    items: Vec<Item>,
    /// Only items, paragraphs and headings, without tabs or CR: rows may be
    /// cut between siblings at any depth.
    deep: bool,
    levels: Vec<Level>,
    deep_cuts: Vec<DeepCut>,
    /// Where the text after a context starts.
    base: usize,
    /// The first item starting at `base`: its depth, whether it starts its
    /// list and that list's start number.
    first: Option<(usize, bool, Option<u64>)>,
    /// An item in the context holds content after its nested list, which a
    /// row cut inside that list would hold without the item.
    broken_first: bool,
}

impl ListScan {
    pub(super) fn new(range: std::ops::Range<usize>, number: &Option<u64>, base: usize) -> Self {
        Self {
            range,
            start: *number,
            items: Vec::new(),
            deep: true,
            levels: vec![Level {
                start: *number,
                count: 0,
                last: None,
            }],
            deep_cuts: Vec::new(),
            base,
            first: None,
            broken_first: false,
        }
    }

    /// Content at container `depth` (an item's own body when even): after
    /// that item's nested list, no row may start inside the nested list,
    /// since the row would hold this content without its item.
    pub(super) fn content(&mut self, depth: usize) {
        if !self.deep || depth < 2 || !depth.is_multiple_of(2) {
            return;
        }
        let level = depth / 2;
        if self.levels.len() <= level {
            return;
        }
        self.levels.truncate(level);
        let Some(item) = self.levels[level - 1].last.as_ref().map(|item| item.start) else {
            return;
        };
        if item < self.base {
            self.broken_first = true;
        }
        self.deep_cuts
            .retain(|cut| cut.depth <= level || cut.line <= item);
    }

    /// Track items at every depth for cuts inside nested lists.
    fn deep_scan(&mut self, source: &str, tag: &Tag<'_>, depth: usize, at: usize) {
        match tag {
            Tag::List(number) if depth.is_multiple_of(2) => {
                self.levels.truncate(depth / 2);
                self.levels.push(Level {
                    start: *number,
                    count: 0,
                    last: None,
                });
            }
            Tag::Item if !depth.is_multiple_of(2) => {
                let level = depth.div_ceil(2);
                let line_start = source[..at].rfind('\n').map_or(0, |end| end + 1);
                // A blank line before an item belongs to an earlier item; a
                // row cut after it would hold that line without its item.
                let blank = source[..line_start.saturating_sub(1)]
                    .rsplit('\n')
                    .next()
                    .is_some_and(|line| line.trim_matches([' ', '\t', '\r']).is_empty())
                    && line_start > 0;
                if blank {
                    self.content(2 * level);
                }
                self.levels.truncate(level);
                let Some((column, marker, first, line)) = item_marker(source, at) else {
                    self.deep = false;
                    return;
                };
                let Some(list) = self.levels.get_mut(level - 1) else {
                    self.deep = false;
                    return;
                };
                let ordinal = list.start.map(|start| start + list.count);
                list.count += 1;
                let fresh = list.count == 1;
                let start = list.start;
                if self.first.is_none() && line_start >= self.base {
                    self.first = Some((level, fresh, start));
                }
                let sibling = list.last.as_ref().is_some_and(|previous| {
                    previous.marker
                        == Marker {
                            number: previous.marker.number,
                            ..marker
                        }
                        && previous.marker_column == column
                });
                let numbered = marker.number == ordinal;
                list.last = Some(Open {
                    marker,
                    marker_column: column,
                    line: line.filter(|_| numbered),
                    start: line_start,
                });
                if sibling && numbered && first && !blank {
                    let context = self.context(level - 1);
                    if level == 1 || context.is_some() {
                        self.deep_cuts.push(DeepCut {
                            line: line_start,
                            depth: level,
                            context,
                        });
                    }
                }
            }
            Tag::Paragraph | Tag::Heading { .. } => self.content(depth),
            _ => self.deep = false,
        }
    }

    /// The synthetic lines of the open items at depths `1..=depth`.
    fn context(&self, depth: usize) -> Option<String> {
        let mut lines = String::new();
        for level in &self.levels[..depth] {
            lines.push_str(level.last.as_ref()?.line.as_deref()?);
        }
        (depth > 0).then_some(lines)
    }

    /// The text after the context starts with an item continuing a list at
    /// the context's depth, numbered as the row's first item was.
    pub(super) fn first_continues(&self, context: &str, number: Option<u64>) -> bool {
        let depth = context.matches('\n').count() + 1;
        self.deep && !self.broken_first && self.first == Some((depth, true, number))
    }

    pub(super) fn nested(&mut self, source: &str, tag: &Tag<'_>, depth: usize, at: usize) {
        if self.deep {
            self.deep_scan(source, tag, depth, at);
        }
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

    pub(super) fn cuttable(&mut self, source: &str) -> bool {
        let body = &source[self.range.start..self.trimmed_end(source)];
        if body.contains(['\t', '\r']) {
            self.deep = false;
        }
        // Blank lines make a list loose, which changes no row's records;
        // cuts at any depth stay sealed across them.
        self.items.iter().all(|item| item.marker.is_some())
            && (self.deep
                || !body
                    .split_inclusive('\n')
                    .any(|line| line.trim_matches([' ', '\t', '\r', '\n']).is_empty()))
    }

    /// Neither item beside a cut nests a block, so each row's first and last
    /// top-level lines name the list's own owner.
    /// The physical number an item at `index` needs to be its ordinal.
    fn ordinal(&self, index: usize) -> Option<u64> {
        self.start.map(|start| start + index as u64)
    }

    pub(super) fn cuts(&self, cuts: &mut Vec<(usize, Cut)>) {
        let mut last = self.range.start;
        if self.deep {
            for cut in &self.deep_cuts {
                if cut.line - last >= CHUNK {
                    cuts.push((
                        cut.line,
                        match &cut.context {
                            Some(context) => Cut::Context(context.clone()),
                            None => Cut::Continue,
                        },
                    ));
                    last = cut.line;
                }
            }
            return;
        }
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

    /// The following row's first line continues this list as a sibling,
    /// after `context` when the following row holds one.
    pub(super) fn continued_by(&self, next: &str, context: Option<&str>) -> bool {
        if self.deep {
            let Some((column, marker, true, _)) = item_marker(next, 0) else {
                return false;
            };
            let Some(depth) = self.levels.iter().position(|level| {
                level
                    .last
                    .as_ref()
                    .is_some_and(|last| last.marker_column == column)
            }) else {
                return false;
            };
            let level = &self.levels[depth];
            let last = level.last.as_ref().unwrap();
            return last.marker
                == Marker {
                    number: last.marker.number,
                    ..marker
                }
                && marker.number == level.start.map(|start| start + level.count)
                && self.context(depth).as_deref() == context;
        }
        if context.is_some() {
            return false;
        }
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
