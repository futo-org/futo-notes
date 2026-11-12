//! The left-to-right pass: escapes, code spans, `<…>` autolinks, wikilinks,
//! and link and image brackets with their destinations.
use super::{Span, SpanKind, Taken};
use std::ops::Range;

/// Escapes, code spans, `<…>` autolinks, wikilinks, links and images, in one
/// pass. Returns the link labels and the images.
pub(super) fn scan(
    text: &str,
    taken: &mut [Taken],
    spans: &mut Vec<Span>,
) -> (Vec<Range<usize>>, Vec<Range<usize>>) {
    let bytes = text.as_bytes();
    let n = bytes.len();
    // One pass, left to right, as CommonMark reads: escapes, code spans,
    // `<…>` autolinks, wikilinks, and link and image brackets. A link's
    // destination is read raw at its `]`, so nothing after `](` starts there.
    let wikilinks = futo_notes_wikilinks::find_wikilinks(text);
    let mut wikilinks = wikilinks.into_iter().peekable();
    let mut links: Vec<Range<usize>> = Vec::new();
    let mut images: Vec<Range<usize>> = Vec::new();
    // Open brackets: position, whether `![`, whether still active.
    let mut openers: Vec<(usize, bool, bool)> = Vec::new();
    let mut i = 0;
    while i < n {
        while wikilinks.peek().is_some_and(|link| link.start < i) {
            wikilinks.next();
        }
        match bytes[i] {
            b'\\' | b'`' | b'<' => i = literal_run(text, i, taken, spans),
            b'[' if wikilinks.peek().is_some_and(|link| link.start == i) => {
                let link = wikilinks.next().unwrap();
                taken[link.start..link.end].fill(Taken::Wikilink);
                spans.push(Span {
                    kind: SpanKind::Wikilink {
                        target: link.target,
                    },
                    range: link.start..link.end,
                    open: link.start..link.start,
                    close: link.end..link.end,
                });
                i = link.end;
            }
            b'!' if bytes.get(i + 1) == Some(&b'[')
                && !wikilinks.peek().is_some_and(|link| link.start == i + 1) =>
            {
                openers.push((i, true, true));
                i += 2;
            }
            b'[' => {
                openers.push((i, false, true));
                i += 1;
            }
            b']' => {
                let found = match openers.pop() {
                    Some((at, image, true)) => {
                        inline_link(text, i + 1).map(|link| (at, image, link))
                    }
                    _ => None,
                };
                let Some((at, image, (end, destination, title))) = found else {
                    i += 1;
                    continue;
                };
                if !image {
                    for opener in openers.iter_mut().filter(|opener| !opener.1) {
                        opener.2 = false;
                    }
                }
                let link = Bracketed {
                    at,
                    close: i,
                    end,
                    image,
                };
                push_link(
                    link,
                    destination,
                    title,
                    taken,
                    spans,
                    &mut links,
                    &mut images,
                );
                i = end;
            }
            _ => i += 1,
        }
    }
    (links, images)
}

/// An escape, code span or `<…>` autolink at `i`, when one starts there;
/// where reading continues.
pub(super) fn literal_run(
    text: &str,
    i: usize,
    taken: &mut [Taken],
    spans: &mut Vec<Span>,
) -> usize {
    let bytes = text.as_bytes();
    match bytes[i] {
        b'\\' if bytes.get(i + 1).is_some_and(u8::is_ascii_punctuation) => {
            spans.push(Span {
                kind: SpanKind::Escape,
                range: i..i + 2,
                open: i..i + 1,
                close: i + 2..i + 2,
            });
            taken[i..i + 2].fill(Taken::Escape);
            i + 2
        }
        b'`' => {
            let run = bytes[i..].iter().take_while(|&&b| b == b'`').count();
            match closing_run(bytes, i + run, run) {
                Some(close) => {
                    spans.push(code_span(text, i, run, close));
                    taken[i..close + run].fill(Taken::Code);
                    close + run
                }
                None => i + run,
            }
        }
        b'<' => match autolink(text, i) {
            Some((end, destination)) => {
                spans.push(Span {
                    kind: SpanKind::Url { destination },
                    range: i..end,
                    open: i..i + 1,
                    close: end - 1..end,
                });
                taken[i..end].fill(Taken::Code);
                end
            }
            None => i + 1,
        },
        _ => i + 1,
    }
}

/// A `[…](…)` or `![…](…)`: its `[` or `!`, its `]`, and its end.
pub(super) struct Bracketed {
    pub(super) at: usize,
    pub(super) close: usize,
    pub(super) end: usize,
    pub(super) image: bool,
}

pub(super) fn push_link(
    link: Bracketed,
    destination: String,
    title: Option<String>,
    taken: &mut [Taken],
    spans: &mut Vec<Span>,
    links: &mut Vec<Range<usize>>,
    images: &mut Vec<Range<usize>>,
) {
    let Bracketed {
        at,
        close,
        end,
        image,
    } = link;
    let label = at + if image { 2 } else { 1 }..close;
    if image {
        images.push(at..end);
        spans.push(Span {
            kind: SpanKind::Image {
                alt: label,
                destination,
                title,
            },
            range: at..end,
            open: at..at,
            close: end..end,
        });
    } else {
        taken[at] = Taken::LinkSyntax;
        taken[close..end].fill(Taken::LinkSyntax);
        links.push(label);
        spans.push(Span {
            kind: SpanKind::Link { destination, title },
            range: at..end,
            open: at..at + 1,
            close: close..end,
        });
    }
}

/// The start of the next backtick run of exactly `run` after `from`.
pub(super) fn closing_run(bytes: &[u8], from: usize, run: usize) -> Option<usize> {
    let mut at = from;
    while at < bytes.len() {
        if bytes[at] == b'`' {
            let start = at;
            while at < bytes.len() && bytes[at] == b'`' {
                at += 1;
            }
            if at - start == run {
                return Some(start);
            }
        } else {
            at += 1;
        }
    }
    None
}

/// A code span; one space each side is syntax when both are there and the
/// code is not all spaces.
pub(super) fn code_span(text: &str, start: usize, run: usize, close: usize) -> Span {
    let inner = &text[start + run..close];
    let pad = usize::from(
        inner.len() >= 2 && inner.starts_with(' ') && inner.ends_with(' ') && inner.trim() != "",
    );
    Span {
        kind: SpanKind::Code,
        range: start..close + run,
        open: start..start + run + pad,
        close: close - pad..close + run,
    }
}

/// A CommonMark autolink `<scheme:…>` or `<address>` at `at`: its end and
/// destination.
pub(super) fn autolink(text: &str, at: usize) -> Option<(usize, String)> {
    let rest = &text[at + 1..];
    let close = rest.find('>')?;
    let inner = &rest[..close];
    if inner.is_empty()
        || inner
            .bytes()
            .any(|b| b == b'<' || b == b' ' || b.is_ascii_control())
    {
        return None;
    }
    let end = at + 1 + close + 1;
    let scheme = inner.split(':').next().unwrap_or("");
    if inner.contains(':')
        && (2..=32).contains(&scheme.len())
        && scheme.as_bytes()[0].is_ascii_alphabetic()
        && scheme
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'.' | b'-'))
    {
        return Some((end, inner.to_owned()));
    }
    let (local, domain) = inner.split_once('@')?;
    let local_ok = !local.is_empty()
        && local
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".!#$%&'*+/=?^_`{|}~-".contains(&b));
    let domain_ok = domain.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            && !label.starts_with('-')
            && !label.ends_with('-')
    });
    (local_ok && domain_ok).then(|| (end, format!("mailto:{inner}")))
}

/// `(destination "title")` starting at `at`: where it ends, the destination
/// and title with backslash escapes removed. Entities stay as written.
pub(super) fn inline_link(text: &str, at: usize) -> Option<(usize, String, Option<String>)> {
    let bytes = text.as_bytes();
    if bytes.get(at) != Some(&b'(') {
        return None;
    }
    let mut i = skip_space(bytes, at + 1);
    let destination;
    if bytes.get(i) == Some(&b'<') {
        let start = i + 1;
        i = start;
        loop {
            match bytes.get(i)? {
                b'>' => break,
                b'<' => return None,
                b'\\' => i += 2,
                _ => i += 1,
            }
        }
        destination = unescape(&text[start..i]);
        i += 1;
    } else {
        let start = i;
        let mut depth = 0usize;
        while let Some(&byte) = bytes.get(i) {
            match byte {
                b'\\' if bytes.get(i + 1).is_some_and(u8::is_ascii_punctuation) => i += 2,
                b'(' => {
                    depth += 1;
                    if depth > 32 {
                        return None;
                    }
                    i += 1;
                }
                b')' if depth == 0 => break,
                b')' => {
                    depth -= 1;
                    i += 1;
                }
                b' ' | b'\t' => break,
                byte if byte.is_ascii_control() => break,
                _ => i += 1,
            }
        }
        if depth != 0 {
            return None;
        }
        destination = unescape(&text[start..i]);
    }
    let spaced = i;
    i = skip_space(bytes, i);
    let mut title = None;
    if i > spaced {
        if let Some(close) = match bytes.get(i) {
            Some(b'"') => Some(b'"'),
            Some(b'\'') => Some(b'\''),
            Some(b'(') => Some(b')'),
            _ => None,
        } {
            let start = i + 1;
            i = start;
            loop {
                match *bytes.get(i)? {
                    b'\\' => i += 2,
                    b'(' if close == b')' => return None,
                    byte if byte == close => break,
                    _ => i += 1,
                }
            }
            title = Some(unescape(&text[start..i]));
            i = skip_space(bytes, i + 1);
        }
    }
    (bytes.get(i) == Some(&b')')).then(|| (i + 1, destination, title))
}

pub(super) fn skip_space(bytes: &[u8], mut at: usize) -> usize {
    while matches!(bytes.get(at), Some(b' ' | b'\t')) {
        at += 1;
    }
    at
}

pub(super) fn unescape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\\' && chars.peek().is_some_and(char::is_ascii_punctuation) {
            out.push(chars.next().unwrap());
        } else {
            out.push(ch);
        }
    }
    out
}
