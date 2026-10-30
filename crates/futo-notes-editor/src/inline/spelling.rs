//! Preserve marker spelling, repair delimiter boundaries and verify candidates
//! against the CommonMark parser before any source is accepted.
mod pieces;
mod render;
pub(super) use pieces::{Marker, Piece, PieceOrigin, Spelling};
mod url_timing;
use super::row::SpanKind;
use super::row::{Row, Span};
use crate::{EditorError, InlineFormat};
use render::{render, Rendered};
use std::ops::Range;
pub(super) use url_timing::prepare_url_input;

pub(super) fn spell(
    pieces: Vec<Piece>,
    markers: Vec<Marker>,
    insertion: Range<usize>,
    literal: bool,
    references: &std::sync::Arc<super::references::References>,
) -> Result<Spelling, EditorError> {
    spell_with_anchors(pieces, markers, insertion, literal, references, &[])
}

pub(super) fn spell_with_anchors(
    mut pieces: Vec<Piece>,
    mut markers: Vec<Marker>,
    insertion: Range<usize>,
    literal: bool,
    references: &std::sync::Arc<super::references::References>,
    anchors: &[usize],
) -> Result<Spelling, EditorError> {
    split_paragraph_spans(&mut pieces);
    trim_emphasis_edges(&mut pieces, &markers);
    repair_code_delimiters(&pieces, &mut markers);
    let expected: String = pieces.iter().map(|piece| piece.display.as_str()).collect();
    let mut rendered = render(&pieces, &markers, insertion.start, insertion.end);
    let mut parsed = 0;
    let mut link_metadata_items = rendered.link_metadata_items;
    let mut link_copied_bytes = 0;
    if literal {
        let mut candidate =
            Row::parse_with_references(&rendered.text, references, &rendered.winners);
        parsed += candidate.parsed_source_bytes;
        link_metadata_items += candidate.reference_work.items;
        link_copied_bytes += candidate.reference_work.copied;
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
            link_metadata_items += rendered.link_metadata_items;
            candidate = Row::parse_with_references(&rendered.text, references, &rendered.winners);
            parsed += candidate.parsed_source_bytes;
            link_metadata_items += candidate.reference_work.items;
            link_copied_bytes += candidate.reference_work.copied;
        }
        let mut missing: Vec<_> = rendered
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
        // A bare/autolink spelling is valid only while it reopens with the
        // retained destination. Editing its label can require explicit syntax.
        let mut repaired_link = false;
        for &id in &missing {
            let marker = &mut markers[id];
            if let SpanKind::Link(destination) = &marker.kind {
                if let Some(reference) = destination.reference.as_ref().filter(|_| {
                    marker.open == "[" && (marker.close == "]" || marker.close == "][]")
                }) {
                    // Parser-normalized reference keys preserve their original
                    // source escapes. A full tail retains identity when the
                    // shortcut/collapsed label changes, without editing its
                    // separate definition or making it newly unused.
                    marker.close = format!("][{reference}]");
                    link_metadata_items += 1;
                    link_copied_bytes += reference.len();
                    repaired_link = true;
                } else if marker.open.is_empty() && marker.close.is_empty()
                    || marker.open == "<" && marker.close == ">"
                {
                    marker.open = "[".into();
                    marker.close = format!(
                        "](<{}>)",
                        super::links::destination_source(&destination.destination)
                    );
                    repaired_link = true;
                }
            }
        }
        if repaired_link {
            rendered = render(&pieces, &markers, insertion.start, insertion.end);
            link_metadata_items += rendered.link_metadata_items;
            candidate = Row::parse_with_references(&rendered.text, references, &rendered.winners);
            parsed += candidate.parsed_source_bytes;
            link_metadata_items += candidate.reference_work.items;
            link_copied_bytes += candidate.reference_work.copied;
            missing = rendered
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
        }
        if candidate.display != expected || !missing.is_empty() {
            // An entity changes CommonMark's delimiter flanking while
            // decoding to the same visible scalar. Repair only the exact
            // neighbor of a marker that the library could no longer pair.
            repair_boundaries(&mut pieces, &missing);
            rendered = render(&pieces, &markers, insertion.start, insertion.end);
            link_metadata_items += rendered.link_metadata_items;
            let candidate =
                Row::parse_with_references(&rendered.text, references, &rendered.winners);
            parsed += candidate.parsed_source_bytes;
            link_metadata_items += candidate.reference_work.items;
            link_copied_bytes += candidate.reference_work.copied;
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
            link_metadata_items += rendered.link_metadata_items;
            let candidate =
                Row::parse_with_references(&rendered.text, references, &rendered.winners);
            parsed += candidate.parsed_source_bytes;
            link_metadata_items += candidate.reference_work.items;
            link_copied_bytes += candidate.reference_work.copied;
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
    let mut mapped = Vec::with_capacity(anchors.len());
    for &anchor in anchors {
        let mut at = 0;
        let mut found = None;
        for (piece, source) in pieces.iter().zip(&rendered.pieces) {
            link_metadata_items += 1;
            let end = at + piece.display.len();
            if !piece.display.is_empty() && (anchor == at || anchor == end) {
                found = Some(if anchor == at {
                    source.start
                } else {
                    source.end
                });
                break;
            }
            at = end;
        }
        mapped.push(found.ok_or(EditorError::UnrepresentableFormat)?);
    }
    Ok(Spelling {
        origins: url_timing::collect_origins(&pieces, &rendered, &mut link_metadata_items),
        input_start: rendered
            .pieces
            .get(insertion.start)
            .map_or(rendered.caret, |range| range.start),
        delimiters: url_timing::collect_delimiters(&pieces, &rendered, &mut link_metadata_items),
        anchors: mapped,
        text: rendered.text,
        caret: rendered.caret,
        parsed,
        link_metadata_items,
        link_copied_bytes,
    })
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
