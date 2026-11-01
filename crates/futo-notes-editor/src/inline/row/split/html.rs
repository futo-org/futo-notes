//! Cuts inside a top-level raw HTML block. Its lines display literally, so a
//! continuation row reparses its block's opener line before its own text; the
//! line after its end condition starts a fresh block. Only kinds 1-5 are cut:
//! they alone run past blank lines.
use super::{Cut, CHUNK, SPLIT_MIN};
use pulldown_cmark::{Event, Parser, Tag};
use std::ops::Range;

/// CommonMark kinds 1-5 end at a terminator rather than a blank line.
fn ends_at_terminator(opener: &str) -> bool {
    let lower = opener.trim_start_matches(' ').to_ascii_lowercase();
    [
        "<!--",
        "<?",
        "<![cdata[",
        "<pre",
        "<script",
        "<style",
        "<textarea",
    ]
    .iter()
    .any(|start| lower.starts_with(start))
        || lower.starts_with("<!") && lower.as_bytes().get(2).is_some_and(u8::is_ascii_alphabetic)
}

pub(super) fn cuts(
    text: &str,
    block: Range<usize>,
    base: usize,
    connected: bool,
    cuts: &mut Vec<(usize, Cut)>,
) {
    let body = &text[block.clone()];
    if body.contains("[[") || !(block.len() >= SPLIT_MIN || connected) {
        return;
    }
    let Some(line) = body.find('\n') else {
        return;
    };
    let opener = block.start..block.start + line + 1;
    // Kinds 6 and 7 end at a blank line and stay one blank-separated row.
    if !ends_at_terminator(&text[opener.clone()]) {
        return;
    }
    let mut last = block.start;
    let mut at = opener.end;
    // A continued block must end its own row, like a block cut here.
    let mut cut = block.start < base;
    while at < block.end {
        if at - last >= CHUNK {
            cuts.push((at, Cut::Html(opener.clone())));
            last = at;
            cut = true;
        }
        at += text[at..block.end]
            .find('\n')
            .map_or(block.end - at, |end| end + 1);
    }
    if cut && block.end < text.len() && text[..block.end].ends_with('\n') {
        cuts.push((block.end, Cut::Head));
    }
}

/// The first line of the block starting at `start`.
pub(super) fn opener_line(text: &str, start: usize) -> &str {
    let line = text[start..]
        .find('\n')
        .map_or(text.len(), |end| start + end + 1);
    &text[start..line]
}

/// The block starting at `start` still owns the following row's first line.
pub(super) fn still_open(text: &str, start: usize, next: &str) -> bool {
    let joined = format!("{}{next}", &text[start..]);
    let shown = text.len() - start;
    Parser::new_ext(&joined, crate::inline::row::parser_options())
        .into_offset_iter()
        .next()
        .is_some_and(|(event, range)| {
            matches!(event, Event::Start(Tag::HtmlBlock)) && range.end > shown
        })
}
