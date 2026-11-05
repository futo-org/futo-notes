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

pub(super) fn repair_boundaries(
    pieces: &mut [Piece],
    markers: &[super::Marker],
    missing: &[usize],
) {
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
        // Code shows an entity verbatim; its neighbor on the other side of
        // the span is the one to encode.
        let code = piece
            .spans
            .iter()
            .any(|&id| markers[id].kind == SpanKind::Format(crate::InlineFormat::Code));
        if !code
            && piece.raw == piece.display
            && piece.display.chars().count() == 1
            && !piece.display.chars().any(char::is_whitespace)
        {
            let scalar = piece.display.chars().next().unwrap() as u32;
            piece.raw = format!("&#{scalar};");
        }
    }
}

/// Escape every literal inline delimiter in `scope` that is spelled as itself,
/// so it can no longer open, close or pair: the fallback for a typed delimiter
/// whose flanking cannot keep the row's formatting. Code, URL-spelled links,
/// guarded words and hidden pieces keep their bytes. Returns whether any
/// piece changed.
pub(super) fn escape_literal_delimiters(
    pieces: &mut [Piece],
    markers: &[super::Marker],
    scope: Range<usize>,
) -> bool {
    let mut changed = false;
    for piece in &mut pieces[scope] {
        let opaque = piece.spans.iter().any(|&id| match &markers[id].kind {
            SpanKind::Format(format) => *format == crate::InlineFormat::Code,
            SpanKind::Link(_) => matches!(markers[id].open.as_str(), "" | "<"),
        });
        if opaque
            || piece.raw != piece.display
            || piece.guard.is_some()
            || piece.literal_url.is_some()
            || piece.definition.is_some()
            || piece.physical_prefix
            || piece.trailing
            || !piece.display.contains(DELIMITERS)
        {
            continue;
        }
        piece.raw = piece
            .display
            .chars()
            .map(|ch| {
                if DELIMITERS.contains(&ch) {
                    format!("\\{ch}")
                } else {
                    ch.to_string()
                }
            })
            .collect();
        changed = true;
    }
    changed
}

const DELIMITERS: [char; 11] = ['*', '_', '~', '`', '[', ']', '<', '>', '!', '&', '\\'];
