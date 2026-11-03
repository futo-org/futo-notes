//! Row partitioning. Blank lines bound independent inline parses; a large
//! top-level paragraph is further cut at sealed soft-line seams so a local
//! edit reparses only its neighborhood (#314).
//!
//! A seam is sealed when the standalone parse of each side equals the joined
//! parse: no inline element crosses it, its previous line has no hard-break
//! spelling, and its next line cannot start a block. Cut paragraphs keep the
//! invariant that no row holds a literal delimiter able to pair across rows;
//! otherwise the whole paragraph stays one row. A long line is further cut
//! inside a space-delimited word of ASCII letters (a word seam): no inline
//! construct reads such a word, so each side's parse is still the joined one. A tight top-level bullet list
//! is cut between top-level items, which inline syntax never crosses.
use pulldown_cmark::{CodeBlockKind, Event, Parser, Tag, TagEnd};
mod html;
mod list;
mod paragraph;
mod seams;
mod word;
pub(crate) use list::list_marker;
use list::ListScan;
use paragraph::{seam_after, seam_before, Paragraph};
pub(crate) use seams::delimiter_neutral;
use seams::is_table;
pub(crate) use word::WORD_TAIL;

/// A row boundary chosen inside the text.
#[derive(Clone)]
pub(super) enum Cut {
    /// The next row continues this row's paragraph or list.
    Continue,
    /// The next row continues a raw HTML or fenced code block with this
    /// opener line.
    Opener(std::ops::Range<usize>),
    /// The next row starts a fresh block.
    Head,
    /// The next row continues a nested list after these ancestor lines.
    Context(String),
}

/// What surrounds the text: its first row's continuation and the following
/// row's first line when that row continues the text's last row.
#[derive(Clone, Copy, Default)]
pub(crate) struct Outside<'a> {
    pub continues: bool,
    /// The opener line of the raw HTML or fenced block the first row continues.
    pub opener: Option<&'a str>,
    pub next: Option<&'a str>,
    /// The physical number of the first row's first item, which continues
    /// an ordered list: the row's seam holds while that number stands.
    pub first_number: Option<u64>,
    /// More source follows the text.
    pub followed: bool,
    /// The opener line of the block the following row continues.
    pub next_opener: Option<&'a str>,
    /// The edit being reparsed creates, removes and reflanks no emphasis
    /// delimiter run, so literal runs outside the text keep their pairing.
    pub neutral: bool,
    /// The nested list context of the first row.
    pub context: Option<&'a str>,
    /// The nested list context of the following row, when it continues.
    pub next_context: Option<&'a str>,
    /// The preceding row's tail when the text starts at a word seam inside
    /// that row's last line.
    pub previous: Option<&'a str>,
}

/// Paragraphs below this size keep their single row.
pub(crate) const SPLIT_MIN: usize = 2048;
/// Minimum bytes between chosen seams.
const CHUNK: usize = 512;

use super::Shape;

pub(crate) struct Piece<'a> {
    pub text: &'a str,
    pub shape: Shape,
}

pub(crate) struct Partition<'a> {
    pub rows: Vec<Piece<'a>>,
    /// The first row continues an outside paragraph whose meaning changed.
    pub widen_back: bool,
    /// The last row's paragraph must absorb the following outside row.
    pub widen_forward: bool,
    /// A code, list, HTML or footnote block reaches the end, so the following
    /// row may still belong to it (its range can take that row's indent).
    pub open_tail: bool,
}

pub(crate) fn partition<'a>(source: &'a str, outside: Outside<'_>) -> Partition<'a> {
    let deep = outside.continues || outside.next.is_some() || source.len() >= SPLIT_MIN;
    #[cfg(test)]
    let deep = deep && !UNCUT.with(|uncut| uncut.get());
    // A continued HTML row is read after its block's opener line.
    let joined;
    let (text, base) = match outside.opener.or(outside.context).filter(|_| deep) {
        Some(prefix) => {
            joined = format!("{prefix}{source}");
            (joined.as_str(), prefix.len())
        }
        None => (source, 0),
    };
    let mut protected = Vec::new();
    let mut cuts = Vec::new();
    let mut starts = Vec::new();
    let (mut widen_back, mut widen_forward) = (false, false);
    if !deep {
        protected.extend(
            Parser::new_ext(source, super::parser_options())
                .into_offset_iter()
                .filter_map(|(event, range)| match event {
                    Event::Start(tag) if protects(&tag) => Some(range),
                    _ => None,
                }),
        );
    } else {
        (widen_back, widen_forward) =
            analyze(text, base, outside, &mut protected, &mut cuts, &mut starts);
    }
    let back = |at: usize| at.max(base) - base;
    for range in &mut protected {
        *range = back(range.start)..back(range.end);
    }
    let cuts: Vec<_> = cuts
        .into_iter()
        .filter(|(at, _)| *at > base)
        .map(|(at, cut)| (at - base, cut))
        .collect();
    let starts: Vec<_> = starts
        .into_iter()
        .filter(|&at| at >= base)
        .map(back)
        .collect();
    let mut protected_index = 0;
    // Text, continues, opener, context, and whether it starts mid-line.
    type Pending<'s> = (&'s str, bool, Option<String>, Option<String>, bool);
    let mut rows: Vec<Pending<'_>> = Vec::new();
    let mut start = 0;
    let mut offset = 0;
    let mut cut_index = 0;
    let mut row_continues = outside.continues;
    let mut row_opener = outside.opener.map(str::to_owned);
    let mut row_context = outside.context.map(str::to_owned);
    let mut row_mid = outside.previous.is_some();
    for line in source.split_inclusive('\n') {
        let line_start = offset;
        offset += line.len();
        // A line-start cut, then any word seams inside the line.
        while let Some((at, cut)) = cuts.get(cut_index).filter(|(at, _)| *at < offset) {
            let at = *at;
            cut_index += 1;
            rows.push((
                &source[start..at],
                row_continues,
                row_opener.take(),
                row_context.take(),
                row_mid,
            ));
            start = at;
            row_continues = !matches!(cut, Cut::Head);
            row_mid = at > line_start;
            match cut {
                Cut::Opener(opener) => row_opener = Some(text[opener.clone()].to_owned()),
                Cut::Context(context) => row_context = Some(context.clone()),
                _ => {}
            }
        }
        while protected_index < protected.len() && protected[protected_index].end <= line_start {
            protected_index += 1;
        }
        let in_code = protected
            .get(protected_index)
            .is_some_and(|range| range.start <= line_start && line_start < range.end);
        if !in_code && line.trim_matches([' ', '\t', '\r', '\n']).is_empty() {
            rows.push((
                &source[start..offset],
                row_continues,
                row_opener.take(),
                row_context.take(),
                row_mid,
            ));
            start = offset;
            row_continues = false;
            row_mid = false;
        }
    }
    if start < source.len() || rows.is_empty() {
        rows.push((
            &source[start..],
            row_continues,
            row_opener.take(),
            row_context.take(),
            row_mid,
        ));
    }
    let mut offset = 0;
    let mut starts = starts.into_iter().peekable();
    let continued: Vec<bool> = rows.iter().skip(1).map(|row| row.1).collect();
    let count = rows.len();
    let pieces = rows
        .into_iter()
        .enumerate()
        .map(|(index, (text, continues, opener, context, mid_line))| {
            let end = offset + text.len();
            let mut single = true;
            while let Some(at) = starts.next_if(|&at| at < end) {
                single &= at <= offset;
            }
            offset = end;
            let continued = continued
                .get(index)
                .copied()
                .unwrap_or(outside.next.is_some());
            let shape = Shape {
                continues,
                through: continues && continued && single,
                continued,
                followed: index + 1 < count || outside.followed,
                opener,
                context,
                mid_line,
            };
            Piece { text, shape }
        })
        .collect();
    let kept = source.trim_end_matches([' ', '\t', '\r', '\n']).len();
    let open_tail = protected.iter().any(|range| range.end > kept);
    Partition {
        open_tail,
        rows: pieces,
        widen_back,
        widen_forward,
    }
}

/// One parse finds protected blocks, sealed cuts and outside dependencies.
fn analyze(
    source: &str,
    base: usize,
    outside: Outside<'_>,
    protected: &mut Vec<std::ops::Range<usize>>,
    cuts: &mut Vec<(usize, Cut)>,
    starts: &mut Vec<usize>,
) -> (bool, bool) {
    // A paragraph or list continues from outside only without an HTML
    // prefix; a nested list context is the list's own ancestors.
    let context = outside.context.filter(|_| base > 0);
    let html_prefix = base > 0 && context.is_none();
    let continues = outside.continues && (base == 0 || context.is_some());
    let next = outside.next.filter(|_| outside.next_opener.is_none());
    let (mut widen_back, mut widen_forward) = (false, false);
    let mut depth = 0usize;
    let mut first_block = None;
    // The last top-level block, when it is a cut-compatible tail.
    let mut tail = Tail::Other;
    let mut paragraph: Option<Paragraph> = None;
    let mut list: Option<ListScan> = None;
    let mut html = None;
    for (event, range) in Parser::new_ext(source, super::parser_options()).into_offset_iter() {
        if first_block.is_none() {
            first_block = Some(if context.is_some() {
                depth == 0 && matches!(event, Event::Start(Tag::List(_)))
            } else if html_prefix {
                matches!(
                    event,
                    Event::Start(Tag::HtmlBlock | Tag::CodeBlock(CodeBlockKind::Fenced(_)))
                ) && range.end > base
            } else {
                depth == 0
                    && match &event {
                        Event::Start(Tag::Paragraph | Tag::List(None)) => true,
                        Event::Start(Tag::List(Some(number))) => {
                            outside.first_number == Some(*number)
                        }
                        _ => false,
                    }
            });
        }
        match &event {
            Event::Start(tag) if is_block(tag) => {
                if protects(tag) {
                    protected.push(range.clone());
                }
                if depth == 0 {
                    starts.push(range.start);
                    tail = Tail::Other;
                    match tag {
                        Tag::Paragraph => paragraph = Some(Paragraph::new(range.clone())),
                        Tag::List(number) => {
                            list = Some(ListScan::new(range.clone(), number, base))
                        }
                        Tag::HtmlBlock => html = Some((range.clone(), false)),
                        Tag::CodeBlock(CodeBlockKind::Fenced(_)) => {
                            html = Some((range.clone(), true))
                        }
                        _ => {}
                    }
                } else if let Some(open) = list.as_mut() {
                    open.nested(source, tag, depth, range.start);
                }
                if is_container(tag) {
                    depth += 1;
                }
            }
            Event::End(TagEnd::Paragraph) if depth == 0 => {
                if let Some(mut found) = paragraph.take() {
                    found.wikilinks(source);
                    let connected_first = continues && at_line_start(source, found.range.start);
                    let end = found.range.end;
                    let connected_last = next.is_some() && reaches_end(source, end);
                    // An emphasis literal keeps an ordinary paragraph whole;
                    // a table's rows cut around it, and only an edit that can
                    // change some delimiter run reparses the whole table.
                    let table = found.emphasis && is_table(source, &found.range);
                    // Connections at word seams outside the text.
                    let word_first = connected_first && outside.previous.is_some();
                    let word_last = connected_last && !source.ends_with('\n');
                    if found.dangling || !found.depth.is_empty() || found.emphasis && !table {
                        widen_back |= connected_first;
                        widen_forward |= connected_last;
                    } else if found.word_dangling && (word_first || word_last) {
                        widen_back |= word_first;
                        widen_forward |= word_last;
                    } else {
                        if found.emphasis && !outside.neutral {
                            widen_back |= connected_first;
                            widen_forward |= connected_last;
                        }
                        if found.range.len() >= SPLIT_MIN || connected_first || connected_last {
                            // A line cut at a word seam outside the text is long.
                            found.cuts(source, (word_first, word_last), cuts);
                        }
                    }
                    if reaches_end(source, end) {
                        tail = Tail::Paragraph;
                    }
                }
            }
            Event::End(tag) if is_container_end(tag) => {
                depth -= 1;
                if depth == 0 {
                    if let Some(mut found) = list.take() {
                        let connected_first = continues && at_line_start(source, found.range.start);
                        let reaches = found.reaches_end(source);
                        let connected_last = next.is_some() && reaches;
                        let cuttable = found.cuttable(source);
                        // A context row's first item must still continue
                        // its list where the context says.
                        if let Some(context) = context.filter(|_| connected_first) {
                            widen_back |=
                                !(cuttable && found.first_continues(context, outside.first_number));
                        }
                        if cuttable {
                            if found.range.len() >= SPLIT_MIN || connected_first || connected_last {
                                found.cuts(cuts);
                            }
                            if reaches {
                                tail = Tail::List(found);
                            }
                        } else {
                            widen_back |= connected_first;
                            widen_forward |= connected_last;
                        }
                    }
                }
            }
            Event::Rule if depth == 0 => {
                starts.push(range.start);
                tail = Tail::Other;
            }
            Event::End(TagEnd::HtmlBlock | TagEnd::CodeBlock) if depth == 0 => {
                if let Some((mut block, fence)) = html.take() {
                    // A fence opener line keeps its indentation, which body
                    // lines strip.
                    if fence {
                        block.start = source[..block.start].rfind('\n').map_or(0, |at| at + 1);
                    }
                    // A fence stays open into the following row only unclosed.
                    let reaches = reaches_end(source, block.end)
                        && (!fence || super::unclosed_fence(&source[block.clone()]));
                    let connected = block.start < base || outside.next_opener.is_some() && reaches;
                    // A continued fence closing on the row's first line makes
                    // the preceding row's final line ending its frame.
                    widen_back |= block.start < base
                        && html::closer_line(source, &block, fence) == Some(base);
                    html::cuts(source, block.clone(), (base, fence), connected, cuts);
                    if reaches {
                        tail = Tail::Opened(block.start);
                    }
                }
            }
            _ => {
                if let Some(open) = paragraph.as_mut() {
                    open.inline(source, &event, range);
                } else if let Some(open) = list.as_mut() {
                    open.content(depth);
                }
            }
        }
    }
    if (continues || base > 0) && first_block != Some(true) {
        widen_back = true;
    }
    if let Some(previous) = outside.previous {
        widen_back |= !word::sealed(previous, &source[base..]);
    }
    if let Some(next) = outside.next {
        let sealed = match &tail {
            // The following row keeps its opener only when that line stands.
            Tail::Opened(start) => {
                outside.next_opener == Some(super::opener_line(source, *start))
                    && super::reaches_into(&source[*start..], next)
            }
            _ if outside.next_opener.is_some() => false,
            Tail::List(found) => found.continued_by(next, outside.next_context),
            _ if outside.next_context.is_some() => false,
            Tail::Paragraph => {
                seam_after(source, source.len()) && seam_before(next, 0)
                    || word::sealed(source, next)
            }
            Tail::Other => false,
        };
        widen_forward |= !sealed;
    }
    (widen_back, widen_forward)
}

enum Tail {
    /// An open raw HTML or fenced block starting here.
    Opened(usize),
    Paragraph,
    List(ListScan),
    Other,
}

fn at_line_start(source: &str, at: usize) -> bool {
    source[..at].trim_start_matches(' ').is_empty()
}

/// Code, lists, raw HTML and footnote definitions own their interior blanks.
fn protects(tag: &Tag<'_>) -> bool {
    matches!(
        tag,
        Tag::CodeBlock(_) | Tag::List(_) | Tag::HtmlBlock | Tag::FootnoteDefinition(_)
    )
}

fn inline_end(tag: &TagEnd) -> bool {
    matches!(
        tag,
        TagEnd::Emphasis
            | TagEnd::Strong
            | TagEnd::Strikethrough
            | TagEnd::Superscript
            | TagEnd::Subscript
            | TagEnd::Link
            | TagEnd::Image
    )
}

fn is_block(tag: &Tag<'_>) -> bool {
    !inline_end(&tag.to_end())
}

fn is_container(tag: &Tag<'_>) -> bool {
    is_container_end(&tag.to_end())
}

/// Blocks that hold other blocks: everything but leaves and inline tags.
fn is_container_end(tag: &TagEnd) -> bool {
    !inline_end(tag)
        && !matches!(
            tag,
            TagEnd::Paragraph | TagEnd::Heading(_) | TagEnd::CodeBlock | TagEnd::HtmlBlock
        )
}

/// A paragraph range ends at its final line; only that line ending may follow.
fn reaches_end(source: &str, end: usize) -> bool {
    matches!(&source[end.min(source.len())..], "" | "\n" | "\r\n")
}

#[cfg(test)]
thread_local! {
    /// Reference projections without paragraph cuts.
    pub(crate) static UNCUT: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    /// Reference projections cut only at line seams.
    pub(crate) static NO_WORD_SEAMS: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}
