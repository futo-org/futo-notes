//! One actual owned-word ending uses the canonical span, never text search.
use super::*;

pub(super) fn finish(
    pieces: &mut [Piece],
    markers: &mut Vec<Marker>,
    body: Range<usize>,
    origin: &TypedAngleOrigin,
    whitespace: bool,
    work: &mut ReferenceWork,
) -> Result<(), EditorError> {
    let text = displayed(&pieces[body.clone()], work);
    let links = canonical_links(&text, work);
    if links.is_empty() {
        return Ok(()); // Existing invalid/incomplete candidate retirement.
    }
    let span = links
        .first()
        .filter(|span| {
            links.len() == 1
                && span.open.start == 0
                && 0 < span.close.end
                && span.close.end <= text.len()
        })
        .ok_or(EditorError::UnrepresentableFormat)?;
    let SpanKind::Link(target) = &span.kind else {
        return Err(EditorError::UnrepresentableFormat);
    };
    if target.title.is_some() || target.reference.is_some() {
        return Err(EditorError::UnrepresentableFormat);
    }
    work.items += 1;
    let prefix = if span.close.end == text.len() {
        let saved = origin
            .uri
            .as_ref()
            .ok_or(EditorError::UnrepresentableFormat)?;
        work.items += saved.displayed.len()
            + text.len()
            + saved.meaning.destination.len()
            + target.destination.len()
            + 2;
        if saved.displayed.as_ref() != text || saved.meaning != *target {
            return Err(EditorError::UnrepresentableFormat);
        }
        body
    } else {
        // A partial canonical prefix is a word-end conversion of the actual
        // seeded candidate. It is never stored as a complete URI payload.
        if !whitespace || origin.uri.is_some() {
            return Err(EditorError::UnrepresentableFormat);
        }
        let mut shown = 0;
        let mut end = body.start;
        for index in body.clone() {
            work.items += 2;
            if shown == span.close.end {
                break;
            }
            let part = &pieces[index];
            shown += part.display.len();
            if shown > span.close.end {
                return Err(EditorError::UnrepresentableFormat);
            }
            end = index + 1;
        }
        if shown != span.close.end || end == body.start {
            return Err(EditorError::UnrepresentableFormat);
        }
        body.start..end
    };
    let id = markers.len();
    markers.push(Marker {
        source: None,
        literal_url: false,
        pending: true,
        activate: false,
        kind: SpanKind::Link(target.clone()),
        open: "<".into(),
        close: ">".into(),
    });
    work.items += 1;
    work.copied += 2;
    for piece in &mut pieces[prefix] {
        work.items += 1;
        piece.spans.push(id);
    }
    // The common final canonical verifier chooses the existing WWW spelling;
    // the ordinary input owner retires pending semantics at actual Space.
    Ok(())
}
