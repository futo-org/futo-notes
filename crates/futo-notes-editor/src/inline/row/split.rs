//! Row partitioning. Blank lines bound independent inline parses; a large
//! top-level paragraph is further cut at sealed soft-line seams so a local
//! edit reparses only its neighborhood (#314).
//!
//! A seam is sealed when the standalone parse of each side equals the joined
//! parse: no inline element crosses it, its previous line has no hard-break
//! spelling, and its next line cannot start a block. Cut paragraphs keep the
//! invariant that no row holds a literal delimiter able to pair across rows;
//! otherwise the whole paragraph stays one row.
use pulldown_cmark::{Event, Parser, Tag, TagEnd};

/// Paragraphs below this size keep their single row.
pub(crate) const SPLIT_MIN: usize = 2048;
/// Minimum bytes between chosen seams.
const CHUNK: usize = 512;

pub(crate) struct Partition<'a> {
    /// Row text and whether it continues the preceding row's paragraph.
    pub rows: Vec<(&'a str, bool)>,
    /// The first row continues an outside paragraph whose meaning changed.
    pub widen_back: bool,
    /// The last row's paragraph must absorb the following outside row.
    pub widen_forward: bool,
}

/// `continues`: the text's first row continues the preceding outside row.
/// `next_continues`: the outside row after this text continues its last row.
pub(crate) fn partition(source: &str, continues: bool, next_continues: bool) -> Partition<'_> {
    let deep = continues || next_continues || source.len() >= SPLIT_MIN;
    #[cfg(test)]
    let deep = deep && !UNCUT.with(|uncut| uncut.get());
    let mut protected = Vec::new();
    let mut cuts = Vec::new();
    let (mut widen_back, mut widen_forward) = (false, false);
    if !deep {
        protected.extend(
            Parser::new(source)
                .into_offset_iter()
                .filter_map(|(event, range)| match event {
                    Event::Start(Tag::CodeBlock(_) | Tag::List(_)) => Some(range),
                    _ => None,
                }),
        );
    } else {
        (widen_back, widen_forward) =
            analyze(source, continues, next_continues, &mut protected, &mut cuts);
    }
    let mut protected_index = 0;
    let mut rows = Vec::new();
    let mut start = 0;
    let mut offset = 0;
    let mut cut_index = 0;
    let mut row_continues = continues;
    for line in source.split_inclusive('\n') {
        let line_start = offset;
        offset += line.len();
        if cuts.get(cut_index) == Some(&line_start) {
            cut_index += 1;
            rows.push((&source[start..line_start], row_continues));
            start = line_start;
            row_continues = true;
        }
        while protected_index < protected.len() && protected[protected_index].end <= line_start {
            protected_index += 1;
        }
        let in_code = protected
            .get(protected_index)
            .is_some_and(|range| range.start <= line_start && line_start < range.end);
        if !in_code && line.trim_matches([' ', '\t', '\r', '\n']).is_empty() {
            rows.push((&source[start..offset], row_continues));
            start = offset;
            row_continues = false;
        }
    }
    if start < source.len() || rows.is_empty() {
        rows.push((&source[start..], row_continues));
    }
    Partition {
        rows,
        widen_back,
        widen_forward,
    }
}

/// One parse finds protected blocks, sealed cuts and outside dependencies.
fn analyze(
    source: &str,
    continues: bool,
    next_continues: bool,
    protected: &mut Vec<std::ops::Range<usize>>,
    cuts: &mut Vec<usize>,
) -> (bool, bool) {
    let (mut widen_back, mut widen_forward) = (false, false);
    let mut depth = 0usize;
    let mut first_block = None;
    let mut last_paragraph_end = None;
    let mut last_is_paragraph = false;
    let mut paragraph: Option<Paragraph> = None;
    for (event, range) in Parser::new_ext(source, super::parser_options()).into_offset_iter() {
        if first_block.is_none() {
            first_block = Some(matches!(event, Event::Start(Tag::Paragraph)) && depth == 0);
        }
        match &event {
            Event::Start(tag) if is_block(tag) => {
                if matches!(tag, Tag::CodeBlock(_) | Tag::List(_)) {
                    protected.push(range.clone());
                }
                if depth == 0 {
                    last_is_paragraph = matches!(tag, Tag::Paragraph);
                    if matches!(tag, Tag::Paragraph) {
                        paragraph = Some(Paragraph::new(range.clone()));
                    }
                }
                if is_container(tag) {
                    depth += 1;
                }
            }
            Event::End(TagEnd::Paragraph) if depth == 0 => {
                if let Some(found) = paragraph.take() {
                    let connected_first = continues
                        && source[..found.range.start]
                            .trim_start_matches(' ')
                            .is_empty();
                    let end = found.range.end;
                    let connected_last = next_continues && reaches_end(source, end);
                    if found.dangling || !found.depth.is_empty() {
                        widen_back |= connected_first;
                        widen_forward |= connected_last;
                    } else if found.range.len() >= SPLIT_MIN || connected_first || connected_last {
                        found.cuts(source, cuts);
                    }
                    last_paragraph_end = Some(end);
                }
            }
            Event::End(tag) if is_container_end(tag) => depth -= 1,
            Event::Rule | Event::Html(_) if depth == 0 => last_is_paragraph = false,
            _ => {
                if let Some(open) = paragraph.as_mut() {
                    open.inline(source, &event, range);
                }
            }
        }
    }
    if continues && first_block != Some(true) {
        widen_back = true;
    }
    if next_continues {
        let sealed = last_is_paragraph
            && last_paragraph_end.is_some_and(|end| reaches_end(source, end))
            && seam_after(source, source.len());
        widen_forward |= !sealed;
    }
    (widen_back, widen_forward)
}

fn is_block(tag: &Tag<'_>) -> bool {
    !matches!(
        tag,
        Tag::Emphasis
            | Tag::Strong
            | Tag::Strikethrough
            | Tag::Superscript
            | Tag::Subscript
            | Tag::Link { .. }
            | Tag::Image { .. }
    )
}

fn is_container(tag: &Tag<'_>) -> bool {
    !matches!(
        tag,
        Tag::Paragraph | Tag::Heading { .. } | Tag::CodeBlock(_)
    ) && is_block(tag)
        && !matches!(tag, Tag::HtmlBlock)
}

fn is_container_end(tag: &TagEnd) -> bool {
    !matches!(
        tag,
        TagEnd::Paragraph
            | TagEnd::Heading(_)
            | TagEnd::CodeBlock
            | TagEnd::HtmlBlock
            | TagEnd::Emphasis
            | TagEnd::Strong
            | TagEnd::Strikethrough
            | TagEnd::Superscript
            | TagEnd::Subscript
            | TagEnd::Link
            | TagEnd::Image
    )
}

/// A paragraph range ends at its final line; only that line ending may follow.
fn reaches_end(source: &str, end: usize) -> bool {
    matches!(&source[end.min(source.len())..], "" | "\n" | "\r\n")
}

/// The line ending at `at` ends with LF and no hard-break spelling.
fn seam_after(source: &str, at: usize) -> bool {
    let Some(line) = source[..at].strip_suffix('\n') else {
        return false;
    };
    let line = line.strip_suffix('\r').unwrap_or(line);
    !line.ends_with([' ', '\t', '\\'])
}

/// The line at `at` continues a paragraph and cannot start a block alone.
fn seam_before(source: &str, at: usize) -> bool {
    let rest = &source[at..];
    let text = rest.trim_start_matches(' ');
    if rest.len() - text.len() > 3 {
        return false;
    }
    let Some(first) = text.chars().next() else {
        return false;
    };
    if !first.is_alphanumeric() {
        return false;
    }
    let digits = text.bytes().take_while(u8::is_ascii_digit).count();
    !(digits > 0 && matches!(text.as_bytes().get(digits), Some(b'.' | b')')))
}

struct Paragraph {
    range: std::ops::Range<usize>,
    /// Ranges no seam may enter: inline elements and literal bracket pairs.
    covered: Vec<std::ops::Range<usize>>,
    /// Open literal brackets.
    depth: Vec<usize>,
    dangling: bool,
}

impl Paragraph {
    fn new(range: std::ops::Range<usize>) -> Self {
        Self {
            range,
            covered: Vec::new(),
            depth: Vec::new(),
            dangling: false,
        }
    }

    fn inline(&mut self, source: &str, event: &Event<'_>, range: std::ops::Range<usize>) {
        match event {
            Event::Text(_) => self.scan(source, range),
            Event::InlineHtml(_) | Event::Html(_) => {
                let raw = &source[range.clone()];
                self.dangling |= !(raw.starts_with('<') && raw.ends_with('>'));
                self.covered.push(range);
            }
            Event::Start(_) | Event::Code(_) | Event::InlineMath(_) | Event::DisplayMath(_) => {
                self.covered.push(range)
            }
            Event::FootnoteReference(_) => self.dangling = true,
            _ => {}
        }
    }

    /// Literal characters that could pair with syntax in another row.
    fn scan(&mut self, source: &str, range: std::ops::Range<usize>) {
        let bytes = source.as_bytes();
        for at in range {
            let byte = bytes[at];
            if !matches!(byte, b'*' | b'_' | b'~' | b'`' | b'[' | b']' | b'<') {
                continue;
            }
            let escapes = bytes[..at]
                .iter()
                .rev()
                .take_while(|&&b| b == b'\\')
                .count();
            if escapes % 2 == 1 {
                continue;
            }
            let before = source[..at].chars().next_back();
            let after = source[at + 1..].chars().next();
            let space = |c: Option<char>| c.is_none_or(char::is_whitespace);
            self.dangling |= match byte {
                b'`' => true,
                b'[' => {
                    self.depth.push(at);
                    false
                }
                b']' => match self.depth.pop() {
                    Some(open) => {
                        self.covered.push(open..at + 1);
                        false
                    }
                    None => true,
                },
                b'<' => after.is_none_or(|c| c.is_ascii_alphabetic() || "/!?".contains(c)),
                b'_' => {
                    let word = |c: Option<char>| c.is_some_and(char::is_alphanumeric);
                    !(space(before) && space(after) || word(before) && word(after))
                }
                _ => !(space(before) && space(after)),
            };
        }
    }

    fn cuts(mut self, source: &str, cuts: &mut Vec<usize>) {
        self.covered.sort_by_key(|range| range.start);
        let mut covered = self.covered.iter().peekable();
        let mut reach = 0;
        let mut last = self.range.start;
        let mut at = self.range.start;
        while let Some(next) = source[at..self.range.end].find('\n') {
            at += next + 1;
            if at >= self.range.end {
                break;
            }
            while let Some(range) = covered.next_if(|range| range.start < at) {
                reach = reach.max(range.end);
            }
            if reach <= at
                && at - last >= CHUNK
                && seam_after(source, at)
                && seam_before(source, at)
            {
                cuts.push(at);
                last = at;
            }
        }
    }
}

#[cfg(test)]
thread_local! {
    /// Reference projections without paragraph cuts.
    pub(crate) static UNCUT: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}
