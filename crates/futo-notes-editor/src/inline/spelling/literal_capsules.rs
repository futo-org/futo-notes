//! Validate operation-only literal output against the same final parser row.
use super::{render::Rendered, Piece, Row, SpanKind};
use crate::{
    inline::{references::ReferenceWork, typed_angle::TypedState},
    EditorError, InlineFormat,
};

impl TypedState {
    pub(super) fn has_literal_proof(&self) -> bool {
        !self.literal_capsules.is_empty()
    }

    pub(super) fn verify_literal_capsules(
        &self,
        pieces: &[Piece],
        rendered: &Rendered,
        candidate: &Row,
    ) -> Result<ReferenceWork, EditorError> {
        let mut work = ReferenceWork::default();
        if !self.has_literal_proof() {
            return Ok(work);
        }
        let mut blocked = Vec::new();
        for span in &candidate.spans {
            work.items += 1;
            if matches!(
                span.kind,
                SpanKind::Link(_) | SpanKind::Format(InlineFormat::Code)
            ) {
                work.items += 1;
                blocked.push(span.open.start..span.close.end);
            }
        }
        blocked.sort_unstable_by(|a, b| {
            work.items += 1;
            a.start.cmp(&b.start)
        });
        let mut forbidden = 0;
        let mut segment = 0;
        let mut previous = 0;
        for capsule in &self.literal_capsules {
            work.items += 2;
            if capsule.is_empty() {
                return Err(EditorError::UnrepresentableFormat);
            }
            for index in capsule.clone() {
                work.items += 3;
                let piece = pieces
                    .get(index)
                    .ok_or(EditorError::UnrepresentableFormat)?;
                let source = rendered
                    .pieces
                    .get(index)
                    .ok_or(EditorError::UnrepresentableFormat)?;
                if source.is_empty() || source.start < previous || piece.display.is_empty() {
                    return Err(EditorError::UnrepresentableFormat);
                }
                previous = source.end;
                while segment < candidate.segments.len()
                    && candidate.segments[segment].source.end <= source.start
                {
                    work.items += 1;
                    segment += 1;
                }
                let mut at = source.start;
                let mut shown = 0;
                while at < source.end {
                    work.items += 3;
                    let actual = candidate
                        .segments
                        .get(segment)
                        .ok_or(EditorError::UnrepresentableFormat)?;
                    if actual.source.start > at
                        || at >= actual.source.end
                        || actual.display.is_empty()
                    {
                        return Err(EditorError::UnrepresentableFormat);
                    }
                    let end = actual.source.end.min(source.end);
                    let display = if actual.identity {
                        let start = actual.display.start + at - actual.source.start;
                        start..start + end - at
                    } else {
                        // A decoded/escaped atom cannot be split to invent a
                        // missing semantic witness. Literal runs may be cut
                        // arithmetically only under their canonical identity.
                        if at != actual.source.start || end != actual.source.end {
                            return Err(EditorError::UnrepresentableFormat);
                        }
                        actual.display.clone()
                    };
                    let text = candidate
                        .display
                        .get(display)
                        .ok_or(EditorError::UnrepresentableFormat)?;
                    let expected = piece
                        .display
                        .get(shown..shown + text.len())
                        .ok_or(EditorError::UnrepresentableFormat)?;
                    if !text.bytes().zip(expected.bytes()).all(|(a, b)| {
                        work.items += 1;
                        a == b
                    }) {
                        return Err(EditorError::UnrepresentableFormat);
                    }
                    shown += text.len();
                    at = end;
                    if at == actual.source.end {
                        segment += 1;
                    }
                }
                if at != source.end || shown != piece.display.len() {
                    return Err(EditorError::UnrepresentableFormat);
                }
                while forbidden < blocked.len() && blocked[forbidden].end <= source.start {
                    work.items += 1;
                    forbidden += 1;
                }
                work.items += 1;
                if blocked
                    .get(forbidden)
                    .is_some_and(|span| span.start < source.end && source.start < span.end)
                {
                    return Err(EditorError::UnrepresentableFormat);
                }
            }
        }
        Ok(work)
    }
}
