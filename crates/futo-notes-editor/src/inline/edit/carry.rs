//! Retain active marker identities when carrying formatting across input.
use super::{delimiter, InlineFormat, Marker, Piece, SpanKind};

pub(in crate::inline) fn carry_formats(
    before: &mut [Piece],
    after: &[Piece],
    markers: &mut Vec<Marker>,
    active: &mut Vec<usize>,
    formats: &[InlineFormat],
) {
    active.retain(|id| {
        markers[*id]
            .kind
            .format()
            .is_none_or(|format| formats.contains(&format))
    });
    for &format in formats {
        if !active
            .iter()
            .any(|id| markers[*id].kind == SpanKind::Format(format))
        {
            let previous = before
                .iter()
                .rev()
                .take_while(|piece| {
                    !piece.display.contains(['\r', '\n'])
                        && !(piece.display.is_empty() && !piece.raw.is_empty())
                })
                .find(|piece| !piece.display.chars().all(char::is_whitespace));
            let neighbor =
                previous.or_else(|| after.iter().find(|piece| !piece.display.is_empty()));
            let reusable = neighbor.and_then(|piece| {
                piece
                    .spans
                    .iter()
                    .copied()
                    .find(|id| markers[*id].kind == SpanKind::Format(format))
            });
            let id = if let Some(id) = reusable {
                for piece in before.iter_mut().rev() {
                    if piece.display.contains(['\r', '\n'])
                        || piece.display.is_empty() && !piece.raw.is_empty()
                        || !piece.display.chars().all(char::is_whitespace)
                    {
                        break;
                    }
                    piece.spans.push(id);
                }
                id
            } else {
                let delimiter = delimiter(format);
                let spelling = before.iter().rev().chain(after.iter()).find_map(|piece| {
                    piece
                        .spans
                        .iter()
                        .find(|id| markers[**id].kind == SpanKind::Format(format))
                        .map(|id| (markers[*id].open.clone(), markers[*id].close.clone()))
                });
                let id = markers.len();
                let (open, close) =
                    spelling.unwrap_or_else(|| (delimiter.into(), delimiter.into()));
                markers.push(Marker {
                    source: None,
                    literal_url: false,
                    pending: false,
                    activate: false,
                    kind: SpanKind::Format(format),
                    open,
                    close,
                });
                id
            };
            active.push(id);
        }
    }
}

/// Inserted Markdown wrapped in one style's delimiters inside or beside a span
/// of that style. CommonMark cannot nest or abut equal delimiter runs
/// (`**a**` then `**b**` reads `**a****b**`), so the wrapped text joins the
/// span instead: its identity and the kept byte range of `inserted`.
pub(in crate::inline) fn joined_span(
    inserted: &str,
    markers: &[Marker],
    beside: [&[usize]; 3],
) -> Option<(usize, std::ops::Range<usize>)> {
    let styles = [
        (InlineFormat::Bold, "**"),
        (InlineFormat::Bold, "__"),
        (InlineFormat::Strike, "~~"),
        (InlineFormat::Italic, "*"),
        (InlineFormat::Italic, "_"),
    ];
    styles.into_iter().find_map(|(format, wrap)| {
        let inner = inserted.strip_prefix(wrap)?.strip_suffix(wrap)?;
        let plain = !inner.is_empty()
            && !inner.contains(&wrap[..1])
            && !inner.contains(['\r', '\n'])
            && !inner.starts_with(char::is_whitespace)
            && !inner.ends_with(char::is_whitespace);
        let id = beside
            .into_iter()
            .flatten()
            .copied()
            .find(|id| markers[*id].kind == SpanKind::Format(format));
        Some((id.filter(|_| plain)?, wrap.len()..wrap.len() + inner.len()))
    })
}
