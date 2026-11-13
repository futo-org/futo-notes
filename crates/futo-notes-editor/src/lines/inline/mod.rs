//! Inline marks on one line. Nothing here sees another line, so no mark can
//! open on one line and close on the next.
//!
//! Order, as CommonMark ranks them: escapes, code spans and `<…>` autolinks
//! left to right; then wikilinks; then links and images; then bare URLs; then
//! `*`, `_` and `~~` by CommonMark's delimiter rules. Tags come from the
//! canonical tag grammar and are dropped inside code.
mod emphasis;
mod scan;
use super::url;
use emphasis::{emphasis, flanking, punctuation, Delimiter};
use scan::scan;
use std::ops::Range;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum SpanKind {
    Bold,
    Italic,
    Strike,
    Code,
    Link {
        destination: String,
        title: Option<String>,
    },
    /// A bare URL, or one inside `<…>`.
    Url {
        destination: String,
    },
    /// Drawn as one unit; `alt` is the source between `![` and `]`.
    Image {
        alt: Range<usize>,
        destination: String,
        title: Option<String>,
    },
    Wikilink {
        target: String,
    },
    Tag,
    /// `\` before ASCII punctuation; `open` is the backslash.
    Escape,
}

/// One mark. `range` is all of its source; `open` and `close` are the syntax
/// a renderer hides around the text (empty for atoms, URLs, tags, wikilinks).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Span {
    pub kind: SpanKind,
    pub range: Range<usize>,
    pub open: Range<usize>,
    pub close: Range<usize>,
}

/// The marks in `line[content]`, with offsets into `line`. The rest of the
/// line is read only to decide whether a tag's `#` follows whitespace.
pub(crate) fn read(line: &str, content: Range<usize>) -> Vec<Span> {
    let text = &line[content.clone()];
    let mut spans = read_text(text);
    let code: Vec<(usize, usize)> = spans
        .iter()
        .filter(|span| span.kind == SpanKind::Code)
        .map(|span| {
            (
                content.start + span.range.start,
                content.start + span.range.end,
            )
        })
        .collect();
    let mut spans: Vec<Span> = spans
        .drain(..)
        .map(|span| super::shift_span(span, content.start))
        .collect();
    for name in futo_notes_tags::tag_name_ranges(line, &code) {
        let hash = name.start - 1;
        if hash >= content.start && name.end <= content.end {
            spans.push(Span {
                kind: SpanKind::Tag,
                range: hash..name.end,
                open: hash..hash,
                close: name.end..name.end,
            });
        }
    }
    sort(&mut spans);
    spans
}

fn sort(spans: &mut [Span]) {
    spans.sort_by_key(|span| (span.range.start, std::cmp::Reverse(span.range.end)));
}

/// Why a byte is unavailable to the constructs read after it.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Taken {
    Free,
    /// Code span or `<…>` autolink.
    Code,
    /// A backslash escape (both bytes).
    Escape,
    Wikilink,
    /// Link syntax (`[` and `](…)`) or a whole image.
    LinkSyntax,
    Url,
}

fn read_text(text: &str) -> Vec<Span> {
    let bytes = text.as_bytes();
    let n = bytes.len();
    let mut taken = vec![Taken::Free; n];
    let mut spans = Vec::new();

    let (mut links, images) = scan(text, &mut taken, &mut spans);
    // An image is one unit: nothing inside it is read.
    let inside_image = |range: &Range<usize>| {
        images
            .iter()
            .any(|image| image.start <= range.start && range.end <= image.end && image != range)
    };
    spans.retain(|span| !inside_image(&span.range));
    links.retain(|label| !inside_image(label));
    for image in &images {
        taken[image.clone()].fill(Taken::LinkSyntax);
    }

    // Bare URLs and addresses, outside links and everything above.
    for (start, end) in free_runs(&taken, |at| links.iter().any(|label| label.contains(&at))) {
        for (from, to, kind) in literals(text, start, end) {
            taken[from..to].fill(Taken::Url);
            spans.push(Span {
                kind: SpanKind::Url {
                    destination: format!("{}{}", kind.prefix(), &text[from..to]),
                },
                range: from..to,
                open: from..from,
                close: to..to,
            });
        }
    }

    // Emphasis and strikethrough; marks inside a link's text pair only there.
    let region = |at: usize| {
        links
            .iter()
            .position(|label| label.contains(&at))
            .map_or(0, |index| index + 1)
    };
    let mut delimiters: Vec<Delimiter> = Vec::new();
    let mut i = 0;
    while i < n {
        let ch = bytes[i];
        if !matches!(ch, b'*' | b'_' | b'~') || taken[i] != Taken::Free {
            i += 1;
            continue;
        }
        let here = region(i);
        let mut end = i;
        while end < n && bytes[end] == ch && taken[end] == Taken::Free && region(end) == here {
            end += 1;
        }
        let len = end - i;
        let before = text[..i].chars().next_back();
        let after = text[end..].chars().next();
        let (left, right) = flanking(before, after);
        let (can_open, can_close) = match ch {
            b'*' => (left, right),
            b'_' => (
                left && (!right || before.is_some_and(punctuation)),
                right && (!left || after.is_some_and(punctuation)),
            ),
            _ if len == 2 => (left, right),
            _ => (false, false),
        };
        if can_open || can_close {
            delimiters.push(Delimiter {
                ch,
                region: here,
                lo: i,
                hi: end,
                len,
                can_open,
                can_close,
                active: true,
            });
        }
        i = end;
    }
    let mut regions: Vec<usize> = delimiters.iter().map(|d| d.region).collect();
    regions.sort_unstable();
    regions.dedup();
    for here in regions {
        let mut group: Vec<Delimiter> = delimiters
            .iter()
            .filter(|d| d.region == here)
            .cloned()
            .collect();
        emphasis(&mut group, &mut spans);
    }

    sort(&mut spans);
    spans
}

/// Runs of free bytes that `skip` does not exclude.
fn free_runs(taken: &[Taken], skip: impl Fn(usize) -> bool) -> Vec<(usize, usize)> {
    let mut runs = Vec::new();
    let mut start = None;
    for at in 0..=taken.len() {
        let open = at < taken.len() && taken[at] == Taken::Free && !skip(at);
        match (open, start) {
            (true, None) => start = Some(at),
            (false, Some(from)) => {
                runs.push((from, at));
                start = None;
            }
            _ => {}
        }
    }
    runs
}

/// URL and address literals in `text[start..end]`, GFM's grammar.
fn literals(text: &str, start: usize, end: usize) -> Vec<(usize, usize, url::Kind)> {
    let bytes = text.as_bytes();
    let content = url::Content { text, end };
    let mut found = Vec::new();
    let mut data = start;
    let mut at = start;
    while at < end {
        if !text.is_char_boundary(at) {
            at += 1;
            continue;
        }
        let previous = at.checked_sub(1).map(|p| bytes[p]);
        if let Some((stop, kind)) = content.literal(at, previous) {
            emails(bytes, data..at, &mut found);
            found.push((at, stop, kind));
            data = stop;
            at = stop;
        } else {
            at += 1;
        }
    }
    emails(bytes, data..end, &mut found);
    found
}

fn emails(bytes: &[u8], run: Range<usize>, found: &mut Vec<(usize, usize, url::Kind)>) {
    if run.is_empty() {
        return;
    }
    let mut local = Vec::new();
    url::emails(&bytes[run.clone()], &mut local);
    found.extend(
        local
            .into_iter()
            .map(|(start, end, kind)| (run.start + start, run.start + end, kind)),
    );
}
