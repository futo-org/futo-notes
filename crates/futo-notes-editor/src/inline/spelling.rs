//! Preserve marker spelling, repair delimiter boundaries and verify candidates
//! against the CommonMark parser before any source is accepted.
use super::row::{Row, Span};
use crate::{EditorError, InlineFormat};
use std::ops::Range;

pub(super) struct Piece {
    pub raw: String,
    pub display: String,
    pub spans: Vec<usize>,
}
pub(super) struct Marker {
    pub format: InlineFormat,
    pub open: String,
    pub close: String,
}

pub(super) struct Spelling {
    pub text: String,
    pub caret: usize,
    pub parsed: usize,
}

pub(super) fn spell(
    mut pieces: Vec<Piece>,
    mut markers: Vec<Marker>,
    insertion: Range<usize>,
    literal: bool,
) -> Result<Spelling, EditorError> {
    split_paragraph_spans(&mut pieces);
    trim_emphasis_edges(&mut pieces, &markers);
    repair_code_delimiters(&pieces, &mut markers);
    let expected: String = pieces.iter().map(|piece| piece.display.as_str()).collect();
    let mut rendered = render(&pieces, &markers, insertion.start, insertion.end);
    let mut parsed = 0;
    if literal {
        let candidate = Row::parse(&rendered.text);
        parsed += rendered.text.len();
        let missing: Vec<_> = rendered
            .spans
            .iter()
            .filter(|(_, expected)| {
                !candidate.spans.iter().any(|span| {
                    span.format == expected.format
                        && span.open == expected.open
                        && span.close == expected.close
                })
            })
            .map(|(id, _)| *id)
            .collect();
        if candidate.display != expected || !missing.is_empty() {
            // An entity changes CommonMark's delimiter flanking while
            // decoding to the same visible scalar. Repair only the exact
            // neighbor of a marker that the library could no longer pair.
            repair_boundaries(&mut pieces, &missing);
            rendered = render(&pieces, &markers, insertion.start, insertion.end);
            let candidate = Row::parse(&rendered.text);
            parsed += rendered.text.len();
            let missing: Vec<_> = rendered
                .spans
                .iter()
                .filter(|(_, expected)| {
                    !candidate.spans.iter().any(|span| {
                        span.format == expected.format
                            && span.open == expected.open
                            && span.close == expected.close
                    })
                })
                .map(|(id, _)| *id)
                .collect();
            for id in missing {
                let marker = &mut markers[id];
                if matches!(marker.format, InlineFormat::Bold | InlineFormat::Italic) {
                    let ch = if marker.open.starts_with('*') {
                        '_'
                    } else {
                        '*'
                    };
                    let width = if marker.format == InlineFormat::Bold {
                        2
                    } else {
                        1
                    };
                    marker.open = ch.to_string().repeat(width);
                    marker.close.clone_from(&marker.open);
                }
            }
            rendered = render(&pieces, &markers, insertion.start, insertion.end);
            let candidate = Row::parse(&rendered.text);
            parsed += rendered.text.len();
            if candidate.display != expected
                || rendered.spans.iter().any(|(_, expected)| {
                    !candidate.spans.iter().any(|span| {
                        span.format == expected.format
                            && span.open == expected.open
                            && span.close == expected.close
                    })
                })
            {
                return Err(EditorError::UnrepresentableFormat);
            }
        }
    }
    Ok(Spelling {
        text: rendered.text,
        caret: rendered.caret,
        parsed,
    })
}

struct Rendered {
    text: String,
    caret: usize,
    spans: Vec<(usize, Span)>,
}
fn render(
    pieces: &[Piece],
    markers: &[Marker],
    insertion_index: usize,
    insertion_end: usize,
) -> Rendered {
    let mut output = String::new();
    let mut stack: Vec<usize> = Vec::new();
    let mut openings: Vec<Range<usize>> = Vec::new();
    let mut spans = Vec::new();
    let mut caret = None;
    for (index, piece) in pieces.iter().enumerate() {
        let common = stack
            .iter()
            .zip(&piece.spans)
            .take_while(|(a, b)| a == b)
            .count();
        while stack.len() > common {
            let id = stack.pop().unwrap();
            let open = openings.pop().unwrap();
            let start = output.len();
            output.push_str(&markers[id].close);
            spans.push((
                id,
                Span {
                    format: markers[id].format,
                    open,
                    close: start..output.len(),
                },
            ));
        }
        if index == insertion_index && insertion_index == insertion_end {
            caret = Some(output.len());
        }
        for &id in &piece.spans[common..] {
            let start = output.len();
            output.push_str(&markers[id].open);
            openings.push(start..output.len());
            stack.push(id);
        }
        output.push_str(&piece.raw);
        if index + 1 == insertion_end {
            caret = Some(output.len());
        }
    }
    if insertion_index == pieces.len() && insertion_index == insertion_end {
        caret = Some(output.len());
    }
    while let Some(id) = stack.pop() {
        let open = openings.pop().unwrap();
        let start = output.len();
        output.push_str(&markers[id].close);
        spans.push((
            id,
            Span {
                format: markers[id].format,
                open,
                close: start..output.len(),
            },
        ));
    }
    Rendered {
        caret: caret.unwrap_or(output.len()),
        text: output,
        spans,
    }
}

fn repair_boundaries(pieces: &mut [Piece], missing: &[usize]) {
    let mut encode = Vec::new();
    for &id in missing {
        for index in 0..pieces.len() {
            if !pieces[index].spans.contains(&id) {
                continue;
            }
            if index > 0 && !pieces[index - 1].spans.contains(&id) {
                encode.push(index - 1);
            }
            if index + 1 < pieces.len() && !pieces[index + 1].spans.contains(&id) {
                encode.push(index + 1);
            }
        }
    }
    encode.sort_unstable();
    encode.dedup();
    for index in encode {
        let piece = &mut pieces[index];
        if piece.raw == piece.display
            && piece.display.chars().count() == 1
            && !piece.display.chars().any(char::is_whitespace)
        {
            let scalar = piece.display.chars().next().unwrap() as u32;
            piece.raw = format!("&#{scalar};");
        }
    }
}

// CommonMark inline spans cannot cross a blank line. Close them before the
// separator and reopen after it; preserve the separator's exact raw bytes.
fn split_paragraph_spans(pieces: &mut [Piece]) {
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

fn trim_emphasis_edges(pieces: &mut [Piece], markers: &[Marker]) {
    // Emphasis cannot begin/end in whitespace. Keep such bytes outside the
    // markers and carry the active formatting separately for the next key.
    for (id, marker) in markers.iter().enumerate() {
        if marker.format == InlineFormat::Code {
            continue;
        }
        let selected: Vec<_> = pieces
            .iter()
            .enumerate()
            .filter(|(_, p)| p.spans.contains(&id))
            .map(|(i, _)| i)
            .collect();
        for &i in &selected {
            if !pieces[i].display.chars().all(char::is_whitespace) {
                break;
            }
            pieces[i].spans.retain(|v| *v != id);
        }
        for &i in selected.iter().rev() {
            if !pieces[i].display.chars().all(char::is_whitespace) {
                break;
            }
            pieces[i].spans.retain(|v| *v != id);
        }
    }
}

fn repair_code_delimiters(pieces: &[Piece], markers: &mut [Marker]) {
    // Code is isolated from markdown. Keep sufficient backticks, and
    // distinguish delimiter padding from spaces in the visible content.
    for (id, marker) in markers.iter_mut().enumerate() {
        if marker.format != InlineFormat::Code {
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
