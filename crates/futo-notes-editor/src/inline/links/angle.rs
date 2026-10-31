//! Canonical word-end spelling for visible hand-typed angle pairs.
mod ownership;
use super::bare_links;
use std::ops::Range;

/// A hand-typed angle pair is visible punctuation. When Space ends its URL,
/// preserve that punctuation around the parser-owned autolink spelling.
#[derive(Default)]
pub(in crate::inline) struct AngleFinish {
    pub work: super::super::references::ReferenceWork,
    pub materialized: usize,
    pub source: Option<Range<usize>>,
}

pub(in crate::inline) fn finish_angle_word(
    pieces: &mut [super::super::spelling::Piece],
    markers: &mut Vec<super::super::spelling::Marker>,
    insertion: usize,
    inserted: &str,
) -> AngleFinish {
    if !inserted.chars().next().is_some_and(char::is_whitespace) || insertion == 0 {
        return AngleFinish::default();
    }
    let mut work = 0;
    let mut start = insertion;
    while start > 0 {
        work += 1;
        if pieces[start - 1].display.chars().any(|ch| {
            work += 1;
            ch.is_whitespace()
        }) {
            break;
        }
        start -= 1;
    }
    let word: String = pieces[start..insertion]
        .iter()
        .map(|piece| piece.display.as_str())
        .collect();
    let mut result = AngleFinish {
        materialized: word.len(),
        ..Default::default()
    };
    result.work.items += work + insertion - start + 2;
    if !word.starts_with('<') || !word.ends_with('>') {
        return result;
    }
    let Some(owned) = ownership::authorize(
        pieces,
        markers,
        start..insertion,
        word.len(),
        &mut result.work.items,
    ) else {
        return result;
    };
    result.work.items += 1;
    if pieces[start].raw != "\\<" && !(owned.code_colon && pieces[start].raw == "<") {
        return result;
    }
    let inner = &word[1..word.len() - 1];
    let (links, parsed) = bare_links(inner);
    result.work.parsed += parsed;
    result.work.items += links.len();
    result.work.copied += links
        .iter()
        .filter_map(|span| match &span.kind {
            super::super::row::SpanKind::Link(target) => {
                Some(target.destination.len() + target.title.as_ref().map_or(0, String::len))
            }
            _ => None,
        })
        .sum::<usize>();
    let Some(link) = links
        .first()
        .filter(|link| links.len() == 1 && link.open.start == 0 && link.close.end == inner.len())
    else {
        return result;
    };
    result.work.items += 1;
    // The exact old word envelope was established before canonical parsing.
    // Retirement is not target correspondence and never maps a raw interior.
    result.source = Some(owned.source);
    if owned.code_colon {
        ownership::consume_colons(&mut pieces[start..insertion], &mut result.work.items);
    }
    result.materialized += 4; // Two canonical marker bytes and both literal angles.
    result.work.items += 1;
    let id = markers.len();
    markers.push(super::super::spelling::Marker {
        literal_url: false,
        pending: false,
        activate: false,
        kind: link.kind.clone(),
        open: "<".into(),
        close: ">".into(),
    });
    pieces[start].raw = "<".into();
    if let Some(last) = pieces[start..insertion]
        .iter_mut()
        .rev()
        .find(|piece| !piece.display.is_empty())
    {
        last.raw = ">".into();
    }
    let mut at = 0;
    for piece in &mut pieces[start..insertion] {
        let end = at + piece.display.len();
        if 1 <= at && end <= word.len() - 1 {
            piece.spans.push(id);
        }
        at = end;
    }
    result
}

/// A newly typed closer can make standard source use the same canonical inner
/// autolink as word end. Only an already pending original URI grants ownership;
/// loaded literal angle text and authored autolinks cannot acquire it by shape.
pub(in crate::inline) fn complete_typed_angle(
    pieces: &mut [super::super::spelling::Piece],
    markers: &mut Vec<super::super::spelling::Marker>,
    insertion: Range<usize>,
    inserted: &str,
    intent: super::super::edit::EditIntent,
    pending: &[Range<usize>],
) -> AngleFinish {
    use super::super::{row::SpanKind, spelling::PieceOrigin};
    let mut result = AngleFinish::default();
    if !matches!(
        intent,
        super::super::edit::EditIntent::Input(crate::InputAction::Typing)
    ) || inserted != ">"
        || insertion.len() != 1
        || pending.is_empty()
    {
        return result;
    }
    result.work.items += 1;
    if !matches!(&pieces[insertion.start].origin, Some(PieceOrigin::Inserted(range)) if *range == (0..1))
    {
        return result;
    }
    let mut start = insertion.start;
    while start > 0 {
        result.work.items += 1;
        if pieces[start - 1].display.contains(char::is_whitespace) {
            break;
        }
        start -= 1;
    }
    if start + 1 >= insertion.start
        || pieces[start].display != "<"
        || !matches!(pieces[start].raw.as_str(), "<" | "\\<")
        || !matches!(pieces[start].origin, Some(PieceOrigin::Source(_)))
    {
        return result;
    }
    let mut source: Option<Range<usize>> = None;
    for piece in &pieces[start..insertion.start] {
        result.work.items += 1;
        for id in &piece.spans {
            result.work.items += 1;
            if matches!(
                markers[*id].kind,
                SpanKind::Link(_) | SpanKind::Format(crate::InlineFormat::Code)
            ) {
                return result;
            }
        }
        let Some(PieceOrigin::Source(range)) = &piece.origin else {
            return result;
        };
        if let Some(previous) = &mut source {
            result.work.items += 1;
            if previous.end != range.start {
                return result;
            }
            previous.end = range.end;
        } else {
            source = Some(range.clone());
        }
    }
    let Some(PieceOrigin::Source(first)) = &pieces[start + 1].origin else {
        return result;
    };
    let inner_source = first.start..source.unwrap().end;
    if !pending.iter().any(|range| {
        result.work.items += 1;
        *range == inner_source
    }) {
        return result;
    }
    let inner: String = pieces[start + 1..insertion.start]
        .iter()
        .map(|piece| {
            result.work.items += 1;
            piece.display.as_str()
        })
        .collect();
    result.materialized += inner.len();
    let (links, parsed) = bare_links(&inner);
    result.work.parsed += parsed;
    result.work.items += links.len() + 1;
    result.work.copied += links
        .iter()
        .filter_map(|link| match &link.kind {
            SpanKind::Link(target) => {
                Some(target.destination.len() + target.title.as_ref().map_or(0, String::len))
            }
            _ => None,
        })
        .sum::<usize>();
    let Some(link) = links
        .first()
        .filter(|link| links.len() == 1 && link.open.start == 0 && link.close.end == inner.len())
    else {
        return result;
    };
    let id = markers.len();
    markers.push(super::super::spelling::Marker {
        literal_url: false,
        pending: true,
        activate: false,
        kind: link.kind.clone(),
        open: "<".into(),
        close: ">".into(),
    });
    pieces[start].raw = "<".into();
    result.materialized += 3; // New literal opener plus canonical marker pair.
    for piece in &mut pieces[start + 1..insertion.start] {
        result.work.items += 1;
        piece.spans.push(id);
    }
    result
}
