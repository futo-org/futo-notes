//! Local literal and delimiter-flanking repairs for canonical spelling.
use super::{render::Rendered, Piece, Row, SpanKind};
use std::ops::Range;

pub(super) fn repair_literal_boundaries(
    pieces: &mut [Piece],
    rendered: &Rendered,
    candidate: &Row,
    insertion: &Range<usize>,
    near_only: bool,
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
                    && block.heading_syntax == super::super::blocks::HeadingSyntax::Atx
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
    // that the candidate now consumes as hidden block syntax. A first pass
    // keeps to the insertion and what precedes it: escaping them can already
    // dissolve a later block, whose own escape could not decode inside raw inline HTML.
    let mut repaired = Vec::new();
    for (index, (piece, source)) in pieces.iter_mut().zip(&rendered.pieces).enumerate() {
        if near_only && index >= insertion.end {
            continue;
        }
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

pub(super) fn repair_boundaries(pieces: &mut [Piece], missing: &[usize]) {
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
