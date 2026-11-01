//! Cuts inside a top-level raw HTML block or fenced code block. Neither holds
//! inline meaning, so a continuation row reparses its block's opener line
//! before its own text; the line after the block's end starts a fresh block.
//! Only HTML kinds 1-5 are cut: they alone run past blank lines.
use super::{Cut, CHUNK, SPLIT_MIN};
use std::ops::Range;

/// CommonMark kinds 1-5 end at a terminator rather than a blank line. A kind
/// 1 tag name must end at whitespace, `>` or the line end (`<prefix>` is 7).
fn ends_at_terminator(opener: &str) -> bool {
    let lower = opener.trim_start_matches(' ').to_ascii_lowercase();
    let kind_one = ["<pre", "<script", "<style", "<textarea"]
        .iter()
        .any(|tag| {
            lower.strip_prefix(tag).is_some_and(|rest| {
                rest.is_empty() || rest.starts_with([' ', '\t', '>', '\r', '\n'])
            })
        });
    kind_one
        || ["<!--", "<?", "<![cdata["]
            .iter()
            .any(|start| lower.starts_with(start))
        || lower.starts_with("<!") && lower.as_bytes().get(2).is_some_and(u8::is_ascii_alphabetic)
}

/// `fence`: the block is fenced code rather than raw HTML.
pub(super) fn cuts(
    text: &str,
    block: Range<usize>,
    (base, fence): (usize, bool),
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
    if !fence && !ends_at_terminator(&text[opener.clone()]) {
        return;
    }
    let mut last = block.start;
    let mut at = opener.end;
    // A fence's final body line ending is its hidden frame, so its closer
    // line never starts a row.
    let closer = closer_line(text, &block, fence).unwrap_or(block.end);
    // A continued block must end its own row, like a block cut here.
    let mut cut = block.start < base;
    while at < block.end {
        if at - last >= CHUNK && at < closer {
            cuts.push((at, Cut::Opener(opener.clone())));
            last = at;
            cut = true;
        }
        at += text[at..block.end]
            .find('\n')
            .map_or(block.end - at, |end| end + 1);
    }
    // A fence's range ends at its closer run, before the line ending.
    let rest = &text[block.end..];
    let end = match rest.find('\n') {
        Some(at) if !text[..block.end].ends_with('\n') && rest[..at].trim().is_empty() => {
            block.end + at + 1
        }
        _ => block.end,
    };
    if cut && end < text.len() && text[..end].ends_with('\n') {
        cuts.push((end, Cut::Head));
    }
}

/// The start of a closed fence's closer line.
pub(super) fn closer_line(text: &str, block: &Range<usize>, fence: bool) -> Option<usize> {
    let body = &text[block.clone()];
    if !fence || crate::inline::row::unclosed_fence(body) {
        return None;
    }
    let trimmed = body.trim_end_matches(['\r', '\n']);
    Some(block.start + trimmed.rfind('\n').map_or(0, |at| at + 1))
}
