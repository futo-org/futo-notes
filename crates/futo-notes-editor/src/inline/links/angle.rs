//! Canonical word-end spelling for visible hand-typed angle pairs.
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
    let mut start = insertion;
    while start > 0 && !pieces[start - 1].display.contains(char::is_whitespace) {
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
    if !word.starts_with('<') || !word.ends_with('>') || pieces[start].raw != "\\<" {
        return result;
    }
    let inner = &word[1..word.len() - 1];
    let (links, parsed) = bare_links(inner);
    result.work = super::super::references::ReferenceWork {
        parsed,
        items: links.len(),
        copied: links
            .iter()
            .filter_map(|span| match &span.kind {
                super::super::row::SpanKind::Link(target) => {
                    Some(target.destination.len() + target.title.as_ref().map_or(0, String::len))
                }
                _ => None,
            })
            .sum(),
    };
    let Some(link) = links
        .first()
        .filter(|link| links.len() == 1 && link.open.start == 0 && link.close.end == inner.len())
    else {
        return result;
    };
    result.work.items += 1;
    let mut source: Option<Range<usize>> = None;
    let complete = pieces[start..insertion].iter().all(|piece| {
        result.work.items += 1;
        let Some(super::super::spelling::PieceOrigin::Source(range)) = &piece.origin else {
            return false;
        };
        if let Some(previous) = &mut source {
            if previous.end != range.start {
                return false;
            }
            previous.end = range.end;
        } else {
            source = Some(range.clone());
        }
        true
    });
    // Retirement is not a source mapping. The canonical converter owns this
    // whole original word, including any closing nonidentity atom it respells.
    result.source = complete.then_some(source).flatten();
    let id = markers.len();
    markers.push(super::super::spelling::Marker {
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
