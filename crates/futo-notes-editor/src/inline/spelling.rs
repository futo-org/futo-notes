//! Preserve marker spelling, repair delimiter boundaries and verify candidates
//! against the CommonMark parser before any source is accepted.
use super::row::SpanKind;
use super::row::{Row, Span};
use crate::{EditorError, InlineFormat};
use std::ops::Range;

pub(super) struct Piece {
    pub raw: String,
    pub display: String,
    pub spans: Vec<usize>,
    pub trailing: bool,
}
pub(super) struct Marker {
    pub kind: SpanKind,
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
        let mut candidate = Row::parse(&rendered.text);
        parsed += candidate.parsed_source_bytes;
        if candidate.display != expected {
            repair_literal_boundaries(&mut pieces, &rendered, &candidate, &insertion);
            // A speculative line-start marker must reopen as the literal text
            // the writer still sees. The block shortcut replaces this spelling
            // only when its final triggering character arrives.
            for piece in &mut pieces[insertion.clone()] {
                if piece.raw == piece.display
                    && piece
                        .display
                        .chars()
                        .all(|ch| matches!(ch, '#' | '>' | '*' | '_' | '-'))
                {
                    piece.raw = piece
                        .display
                        .chars()
                        .map(|ch| format!("&#{};", ch as u32))
                        .collect();
                }
            }
            rendered = render(&pieces, &markers, insertion.start, insertion.end);
            candidate = Row::parse(&rendered.text);
            parsed += candidate.parsed_source_bytes;
        }
        let missing: Vec<_> = rendered
            .spans
            .iter()
            .filter(|(_, expected)| {
                !candidate.spans.iter().any(|span| {
                    span.kind == expected.kind
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
            parsed += candidate.parsed_source_bytes;
            let missing: Vec<_> = rendered
                .spans
                .iter()
                .filter(|(_, expected)| {
                    !candidate.spans.iter().any(|span| {
                        span.kind == expected.kind
                            && span.open == expected.open
                            && span.close == expected.close
                    })
                })
                .map(|(id, _)| *id)
                .collect();
            for id in missing {
                let marker = &mut markers[id];
                if matches!(
                    marker.kind,
                    SpanKind::Format(InlineFormat::Bold | InlineFormat::Italic)
                ) {
                    let ch = if marker.open.starts_with('*') {
                        '_'
                    } else {
                        '*'
                    };
                    let width = if marker.kind == SpanKind::Format(InlineFormat::Bold) {
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
            parsed += candidate.parsed_source_bytes;
            if candidate.display != expected
                || rendered.spans.iter().any(|(_, expected)| {
                    !candidate.spans.iter().any(|span| {
                        span.kind == expected.kind
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
    pieces: Vec<Range<usize>>,
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
    let mut piece_ranges = Vec::with_capacity(pieces.len());
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
                    kind: markers[id].kind.clone(),
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
        let start = output.len();
        output.push_str(&piece.raw);
        piece_ranges.push(start..output.len());
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
                kind: markers[id].kind.clone(),
                open,
                close: start..output.len(),
            },
        ));
    }
    Rendered {
        caret: caret.unwrap_or(output.len()),
        text: output,
        spans,
        pieces: piece_ranges,
    }
}

fn repair_literal_boundaries(
    pieces: &mut [Piece],
    rendered: &Rendered,
    candidate: &Row,
    insertion: &Range<usize>,
) {
    for (piece, source) in pieces.iter_mut().zip(&rendered.pieces) {
        if piece.raw == "\\"
            && piece.display == "\\"
            && candidate.segments.iter().any(|segment| {
                !segment.identity
                    && segment.source.start == source.start
                    && source.end < segment.source.end
                    && candidate.display_at(source.start) == candidate.display_at(source.end)
            })
        {
            piece.raw = "&#92;".into();
        }
    }
    // A newly completed hand-typed link is still literal text. Escape the
    // visible opener, leaving the URL inside available for GFM word-end linking.
    for (piece, source) in pieces.iter_mut().zip(&rendered.pieces) {
        if matches!(piece.display.as_str(), "[" | "<")
            && piece.raw == piece.display
            && candidate.spans.iter().any(|span| {
                matches!(span.kind, SpanKind::Link(_))
                    && span.open.start <= source.start
                    && source.end <= span.open.end
            })
        {
            piece.raw.insert(0, '\\');
        }
    }
    let mut closers = Vec::new();
    for (piece, source) in pieces.iter_mut().zip(&rendered.pieces) {
        if piece.trailing && piece.display.is_empty() && piece.raw == "#" {
            if let Some(block) = candidate.blocks.iter().find(|block| {
                block.heading > 0
                    && block.heading_syntax == super::blocks::HeadingSyntax::Atx
                    && block.content.start <= source.start
                    && source.end <= block.content.end
            }) {
                if !closers.contains(&block.source.start) {
                    piece.raw.insert(0, ' ');
                    closers.push(block.source.start);
                }
            }
        }
    }
    // A deletion can expose a body space as ATX separation, or a
    // literal hash as an opener/closer. Repair only visible pieces
    // that the candidate now consumes as hidden block syntax.
    let mut repaired = Vec::new();
    for (index, (piece, source)) in pieces.iter_mut().zip(&rendered.pieces).enumerate() {
        let boundary = candidate.blocks.iter().find_map(|block| {
            if block.source.start <= source.start && source.end <= block.content.start {
                Some((block.source.start, false))
            } else if block.content.end <= source.start && source.end <= block.source.end {
                Some((block.source.start, true))
            } else {
                None
            }
        });
        if piece.raw == piece.display
            && piece.display.chars().count() == 1
            && !piece.display.contains(['\r', '\n'])
            && boundary.is_some_and(|boundary| !repaired.contains(&boundary))
            && candidate.display_at(source.start) == candidate.display_at(source.end)
        {
            let scalar = piece.display.chars().next().unwrap();
            piece.raw = if scalar.is_ascii_punctuation() && !insertion.contains(&index) {
                format!("\\{scalar}")
            } else {
                format!("&#{};", scalar as u32)
            };
            repaired.push(boundary.unwrap());
        }
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
            // A literal backslash immediately before a new closing marker
            // must not escape that marker, including at the body's end.
            if (index + 1 == pieces.len() || !pieces[index + 1].spans.contains(&id))
                && pieces[index].raw == "\\"
                && pieces[index].display == "\\"
            {
                encode.push(index);
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

// Block commands create a real parser boundary even with one source newline.
// Close before that exact separator and reopen after the following block prefix.
pub(super) fn split_block_spans(pieces: &mut [Piece], boundaries: &[usize]) {
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

fn repair_code_delimiters(pieces: &[Piece], markers: &mut [Marker]) {
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
