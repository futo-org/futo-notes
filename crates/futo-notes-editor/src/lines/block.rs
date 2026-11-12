//! What each line of a note is. One pass over lines with a small carry; a line
//! never looks at a line after it, except that a delimiter row makes the line
//! directly above it a table header.
use std::ops::Range;

/// What the lines above hand to the next line.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Carry {
    /// No line has been read yet: only this line can open front matter.
    pub first: bool,
    /// Front matter is open and runs until a `---` line.
    pub front_matter: bool,
    pub fence: Option<OpenFence>,
    /// Inside a table with this many header cells.
    pub table: Option<usize>,
    /// The line above starts with `|` at the top level outside a table, so a
    /// delimiter row here makes it a header with this many cells.
    pub header_above: Option<usize>,
}

impl Carry {
    pub fn start() -> Self {
        Self {
            first: true,
            ..Self::default()
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct OpenFence {
    pub ch: u8,
    pub len: usize,
    /// The opening fence's language, which every line inside it carries.
    pub language: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FrontMatterRole {
    Open,
    Body,
    Close,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FenceRole {
    Open,
    Code,
    Close,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TableRole {
    Header,
    Delimiter,
    Row,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    /// Text that is no other block. An indented plain line is drawn at its own
    /// `indent` (columns); its leading whitespace is then `marker`.
    Plain {
        indent: usize,
    },
    Blank,
    Heading {
        level: u8,
    },
    /// `-`, `*`, `+`, or digits then `.` or `)`. `marker` on the line holds
    /// indent, list marker, the space after it and a task box.
    List {
        /// Columns of the line's own leading whitespace.
        indent: usize,
        /// The marker as typed: `-`, `3)`, `10.`.
        text: Range<usize>,
        ordered: bool,
        task: Option<bool>,
    },
    Divider,
    FrontMatter(FrontMatterRole),
    Fence {
        role: FenceRole,
        /// Columns of a fence line's own leading whitespace; code lines keep
        /// their whitespace as code and report 0.
        indent: usize,
        /// The info string's first word on an opening fence.
        language: Option<Range<usize>>,
    },
    Table {
        role: TableRole,
        columns: usize,
    },
}

/// One line. Offsets are absolute in the note.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Line {
    /// The line without its ending.
    pub range: Range<usize>,
    /// Bytes of the ending: 0, 1 (`\n`) or 2 (`\r\n`).
    pub ending: usize,
    pub kind: Kind,
    pub quote: usize,
    /// Syntax before the content: quote markers, a list or heading marker and
    /// the space after it, the leading whitespace of a list or indented plain line.
    pub marker: Range<usize>,
    /// What inline reading applies to. Empty for blank, divider, fence,
    /// front matter and delimiter lines.
    pub content: Range<usize>,
}

impl Line {
    pub fn end(&self) -> usize {
        self.range.end + self.ending
    }
}

/// Every line of `source`, and the carry before each one. A note always has
/// at least one line; a final line ending opens one more, empty line.
pub(crate) fn read(source: &str) -> (Vec<Line>, Vec<Carry>) {
    let mut lines = Vec::new();
    let mut carries = Vec::new();
    let mut carry = Carry::start();
    let mut at = 0;
    loop {
        carries.push(carry.clone());
        let line = read_line(&mut carry, source, at);
        let last = line.ending == 0;
        at = line.end();
        place(&mut lines, line);
        if last {
            return (lines, carries);
        }
    }
}

/// Push `line`; a delimiter row makes the line above it a header.
pub(crate) fn place(lines: &mut Vec<Line>, line: Line) {
    if let Kind::Table {
        role: TableRole::Delimiter,
        columns,
    } = line.kind
    {
        if let Some(above) = lines.last_mut() {
            above.kind = Kind::Table {
                role: TableRole::Header,
                columns,
            };
        }
    }
    lines.push(line);
}

/// Where a line sits: its start, length without the ending, and ending.
struct Place {
    start: usize,
    len: usize,
    ending: usize,
}

impl Place {
    /// A line of `kind`; `marker` and `content` are relative to its start.
    fn line(&self, kind: Kind, quote: usize, marker: Range<usize>, content: Range<usize>) -> Line {
        Line {
            range: self.start..self.start + self.len,
            ending: self.ending,
            kind,
            quote,
            marker: self.start + marker.start..self.start + marker.end,
            content: self.start + content.start..self.start + content.end,
        }
    }

    /// A line that is all syntax.
    fn syntax(&self, kind: Kind) -> Line {
        self.line(kind, 0, 0..self.len, self.len..self.len)
    }
}

/// The line starting at `start`, and the carry after it.
pub(crate) fn read_line(carry: &mut Carry, source: &str, start: usize) -> Line {
    let rest = &source[start..];
    let (len, ending) = match rest.find('\n') {
        Some(newline) if newline > 0 && rest.as_bytes()[newline - 1] == b'\r' => (newline - 1, 2),
        Some(newline) => (newline, 1),
        None => (rest.len(), 0),
    };
    let text = &rest[..len];
    let place = Place { start, len, ending };
    let first = std::mem::take(&mut carry.first);
    let header_above = carry.header_above.take();

    if first && text == "---" && closes_front_matter(&source[start + len..]) {
        carry.front_matter = true;
        return place.syntax(Kind::FrontMatter(FrontMatterRole::Open));
    }
    if carry.front_matter {
        let role = if text == "---" {
            carry.front_matter = false;
            FrontMatterRole::Close
        } else {
            FrontMatterRole::Body
        };
        return place.syntax(Kind::FrontMatter(role));
    }
    if let Some(open) = carry.fence.clone() {
        return fenced(carry, open, &place, text);
    }
    read_block(carry, &place, text, header_above)
}

/// Whether a line of exactly `---` follows in `rest`, the text after line 1:
/// only then does line 1 open front matter.
pub(crate) fn closes_front_matter(rest: &str) -> bool {
    rest.split('\n')
        .skip(1)
        .any(|line| line.strip_suffix('\r').unwrap_or(line) == "---")
}

/// A line inside an open fence: code, or the closing fence.
fn fenced(carry: &mut Carry, open: OpenFence, place: &Place, text: &str) -> Line {
    let (indent, _) = indent(text);
    let body = text[indent..].trim_end_matches([' ', '\t']);
    let run = body.bytes().take_while(|&b| b == open.ch).count();
    let closes = run >= open.len && run == body.len();
    if closes {
        carry.fence = None;
    }
    let kind = Kind::Fence {
        role: if closes {
            FenceRole::Close
        } else {
            FenceRole::Code
        },
        indent: if closes { width(&text[..indent]) } else { 0 },
        language: None,
    };
    if closes {
        place.syntax(kind)
    } else {
        place.line(kind, 0, 0..0, 0..place.len)
    }
}

/// A line outside fences and front matter, read by its own text and the
/// table above it.
fn read_block(carry: &mut Carry, place: &Place, text: &str, header_above: Option<usize>) -> Line {
    let (start, len) = (place.start, place.len);
    let line = |kind, quote, marker, content| place.line(kind, quote, marker, content);
    let empty = len..len;
    let (quote, body) = quotes(text);
    let (indent_bytes, width) = indent(&text[body..]);
    let at = body + indent_bytes;
    let own = &text[at..];

    let top = quote == 0 && width == 0;
    if let Some(columns) = carry.table {
        if top && own.starts_with('|') {
            let kind = Kind::Table {
                role: TableRole::Row,
                columns,
            };
            return line(kind, 0, 0..0, 0..len);
        }
        carry.table = None;
    }

    if own.chars().all(char::is_whitespace) {
        return line(Kind::Blank, quote, 0..body, empty);
    }

    if quote == 0 {
        if let Some((ch, run)) = fence_open(own) {
            return fence_opener(carry, place, own, width, ch, run);
        }
    }

    if top && own.starts_with('|') {
        if let Some(columns) = header_above.filter(|_| delimiter_row(own)) {
            carry.table = Some(columns);
            let kind = Kind::Table {
                role: TableRole::Delimiter,
                columns,
            };
            return line(kind, 0, 0..len, empty);
        }
        carry.header_above = Some(super::table::cells(own).len()).filter(|&cells| cells > 0);
        return line(Kind::Plain { indent: 0 }, 0, 0..0, 0..len);
    }

    if top && divider(own) {
        return line(Kind::Divider, 0, 0..len, empty);
    }

    if width == 0 {
        if let Some(level) = heading(own) {
            let marker = at + level as usize + 1;
            return line(Kind::Heading { level }, quote, 0..marker, marker..len);
        }
    }

    if let Some((marker_len, ordered)) = list_marker(own) {
        let text_range = at..at + marker_len;
        let mut content = at + marker_len + 1;
        let task = if ordered {
            None
        } else {
            task_box(&text[content..])
        };
        if task.is_some() {
            content += 4;
        }
        let kind = Kind::List {
            indent: width,
            text: start + text_range.start..start + text_range.end,
            ordered,
            task,
        };
        return line(kind, quote, 0..content, content..len);
    }

    line(Kind::Plain { indent: width }, quote, 0..at, at..len)
}

/// An opening fence, at its own indent.
fn fence_opener(
    carry: &mut Carry,
    place: &Place,
    own: &str,
    width: usize,
    ch: u8,
    run: usize,
) -> Line {
    let info = own[run..].trim_start_matches([' ', '\t']);
    let word = info.find([' ', '\t']).unwrap_or(info.len());
    let info_start = place.start + place.len - info.len();
    let language = (word > 0).then_some(info_start..info_start + word);
    carry.fence = Some(OpenFence {
        ch,
        len: run,
        language: (word > 0).then(|| info[..word].to_owned()),
    });
    place.syntax(Kind::Fence {
        role: FenceRole::Open,
        indent: width,
        language,
    })
}

/// Quote depth and the byte where the quoted text starts. Each `>` counts
/// when a space, tab, another `>` or the line's end follows it; one space or
/// tab after it belongs to the marker.
fn quotes(text: &str) -> (usize, usize) {
    let bytes = text.as_bytes();
    let mut depth = 0;
    let mut at = 0;
    while bytes.get(at) == Some(&b'>') {
        match bytes.get(at + 1) {
            None | Some(b'>') => at += 1,
            Some(b' ' | b'\t') => at += 2,
            Some(_) => break,
        }
        depth += 1;
    }
    (depth, at)
}

/// Columns a tab counts for in an indent; a space counts for one.
pub(crate) const TAB_WIDTH: usize = 4;

/// Leading whitespace: its bytes and its width in columns.
fn indent(text: &str) -> (usize, usize) {
    let bytes = text
        .bytes()
        .take_while(|&b| b == b' ' || b == b'\t')
        .count();
    (bytes, width(&text[..bytes]))
}

/// The width in columns of spaces and tabs.
pub(crate) fn width(whitespace: &str) -> usize {
    whitespace
        .bytes()
        .map(|b| if b == b'\t' { TAB_WIDTH } else { 1 })
        .sum()
}

fn fence_open(own: &str) -> Option<(u8, usize)> {
    let ch = *own.as_bytes().first()?;
    if ch != b'`' && ch != b'~' {
        return None;
    }
    let run = own.bytes().take_while(|&b| b == ch).count();
    (run >= 3).then_some((ch, run))
}

fn divider(own: &str) -> bool {
    let Some(ch) = own
        .bytes()
        .next()
        .filter(|b| matches!(b, b'-' | b'*' | b'_'))
    else {
        return false;
    };
    own.len() >= 3 && own.bytes().all(|b| b == ch)
}

fn heading(own: &str) -> Option<u8> {
    let hashes = own.bytes().take_while(|&b| b == b'#').count();
    ((1..=6).contains(&hashes) && matches!(own.as_bytes().get(hashes), Some(b' ' | b'\t')))
        .then_some(hashes as u8)
}

/// The marker's length and whether it is numbered, when a space or tab
/// follows it.
fn list_marker(own: &str) -> Option<(usize, bool)> {
    let bytes = own.as_bytes();
    let spaced = |at: usize| matches!(bytes.get(at), Some(b' ' | b'\t'));
    if matches!(bytes.first(), Some(b'-' | b'*' | b'+')) && spaced(1) {
        return Some((1, false));
    }
    let digits = bytes.iter().take_while(|b| b.is_ascii_digit()).count();
    (digits > 0 && matches!(bytes.get(digits), Some(b'.' | b')')) && spaced(digits + 1))
        .then_some((digits + 1, true))
}

/// `[ ]`, `[x]` or `[X]` then a space or tab, at the start of `rest`.
fn task_box(rest: &str) -> Option<bool> {
    let bytes = rest.as_bytes();
    if bytes.len() < 4 || bytes[0] != b'[' || bytes[2] != b']' || !matches!(bytes[3], b' ' | b'\t')
    {
        return None;
    }
    match bytes[1] {
        b' ' => Some(false),
        b'x' | b'X' => Some(true),
        _ => None,
    }
}

/// `|---|:--:|`: every cell is dashes with optional colons at either end.
fn delimiter_row(own: &str) -> bool {
    let cells = super::table::cells(own);
    !cells.is_empty()
        && cells.iter().all(|cell| {
            let cell = own[cell.clone()].trim_matches([' ', '\t']);
            let inner = cell.strip_prefix(':').unwrap_or(cell);
            let inner = inner.strip_suffix(':').unwrap_or(inner);
            !inner.is_empty() && inner.bytes().all(|b| b == b'-')
        })
}
