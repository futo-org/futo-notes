//! Shape span membership before rendering: block and blank-line seams,
//! emphasis edge whitespace and sufficient code delimiters.
use super::{Marker, Piece, SpanKind};
use crate::InlineFormat;

// Block commands create a real parser boundary even with one source newline.
// Close before that exact separator and reopen after the following block prefix.
pub(in crate::inline) fn split_block_spans(pieces: &mut [Piece], boundaries: &[usize]) {
    let mut at = 0;
    for piece in pieces {
        let end = at + piece.display.len();
        if (piece.display.ends_with('\n') && boundaries.contains(&end))
            || (piece.display == "\r" && boundaries.contains(&(end + 1)))
            || (piece.display.is_empty() && !piece.trailing && boundaries.contains(&at))
        {
            piece.spans.clear();
        }
        at = end;
    }
}

// CommonMark inline spans cannot cross a blank line. Close them before the
// separator and reopen after it; preserve the separator's exact raw bytes.
pub(super) fn split_paragraph_spans(pieces: &mut [Piece]) {
    let mut start = 0;
    while start < pieces.len() {
        if !pieces[start]
            .display
            .chars()
            .all(|ch| matches!(ch, ' ' | '\t' | '\r' | '\n'))
        {
            start += 1;
            continue;
        }
        let mut end = start;
        let mut newlines = 0;
        while end < pieces.len()
            && pieces[end]
                .display
                .chars()
                .all(|ch| matches!(ch, ' ' | '\t' | '\r' | '\n'))
        {
            newlines += pieces[end]
                .display
                .bytes()
                .filter(|&ch| ch == b'\n')
                .count();
            end += 1;
        }
        if newlines >= 2 {
            for piece in &mut pieces[start..end] {
                piece.spans.clear();
            }
        }
        start = end;
    }
}

pub(super) fn trim_emphasis_edges(pieces: &mut [Piece], markers: &[Marker]) {
    // Emphasis cannot begin/end in whitespace. Keep such bytes outside the
    // markers and carry the active formatting separately for the next key.
    for (id, marker) in markers.iter().enumerate() {
        if !matches!(
            marker.kind,
            SpanKind::Format(InlineFormat::Bold | InlineFormat::Italic | InlineFormat::Strike)
        ) {
            continue;
        }
        let mut start = 0;
        while start < pieces.len() {
            if !pieces[start].spans.contains(&id) {
                start += 1;
                continue;
            }
            let mut end = start + 1;
            while end < pieces.len() && pieces[end].spans.contains(&id) {
                end += 1;
            }
            for piece in &mut pieces[start..end] {
                if !piece.display.chars().all(char::is_whitespace) {
                    break;
                }
                piece.spans.retain(|v| *v != id);
            }
            for piece in pieces[start..end].iter_mut().rev() {
                if !piece.display.chars().all(char::is_whitespace) {
                    break;
                }
                piece.spans.retain(|v| *v != id);
            }
            start = end;
        }
    }
}

pub(super) fn repair_code_delimiters(pieces: &[Piece], markers: &mut [Marker]) {
    // Code is isolated from markdown. Keep sufficient backticks, and
    // distinguish delimiter padding from spaces in the visible content.
    for (id, marker) in markers.iter_mut().enumerate() {
        if marker.kind != SpanKind::Format(InlineFormat::Code) {
            continue;
        }
        let content: String = pieces
            .iter()
            .filter(|p| p.spans.contains(&id))
            .map(|p| p.raw.as_str())
            .collect();
        if content.is_empty() {
            continue;
        }
        let normalized = content.replace("\r\n", " ").replace(['\r', '\n'], " ");
        let old_width = marker.open.bytes().take_while(|b| *b == b'`').count();
        let max = content.split(|c| c != '`').map(str::len).max().unwrap_or(0);
        let width = old_width.max(max + 1);
        let old_padding = marker.open.len() > old_width || marker.close.len() > old_width;
        let all_spaces = normalized.chars().all(|c| c == ' ');
        let pad = !all_spaces
            && (old_padding
                || content.starts_with('`')
                || content.ends_with('`')
                || (normalized.starts_with(' ') && normalized.ends_with(' ')));
        if width != old_width || pad != old_padding {
            let delimiter = "`".repeat(width);
            marker.open = format!("{delimiter}{}", if pad { " " } else { "" });
            marker.close = format!("{}{delimiter}", if pad { " " } else { "" });
        }
    }
}
