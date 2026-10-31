//! The selected ADD Code command is the sole guarded-word producer.
use super::*;
use crate::inline::{
    references::ReferenceWork,
    row::SpanKind,
    spelling::{Marker, Piece, PieceOrigin},
};

#[derive(Default)]
struct Body {
    first: usize,
    last: usize,
    displayed: String,
}
impl GuardState {
    pub(in crate::inline) fn enroll(
        &mut self,
        pieces: &mut [Piece],
        markers: &[Marker],
    ) -> Result<ReferenceWork, EditorError> {
        let mut work = ReferenceWork::default();
        if !markers.iter().any(|marker| {
            work.items += 1;
            marker.literal_url
        }) {
            return Ok(work);
        }
        let mut bodies: Vec<Option<Body>> = (0..markers.len()).map(|_| None).collect();
        work.items += 1 + bodies.len();
        for (index, piece) in pieces.iter().enumerate() {
            work.items += 1;
            let Some(id) = piece.literal_url else {
                continue;
            };
            let Some((open, close)) = &markers[id].source else {
                return Err(EditorError::UnrepresentableFormat);
            };
            let Some(PieceOrigin::Source(source)) = &piece.origin else {
                return Err(EditorError::UnrepresentableFormat);
            };
            work.items += 3;
            if !markers[id].pending
                || source.start < open.end
                || close.start < source.end
                || piece.guard.is_some()
            {
                return Err(EditorError::UnrepresentableFormat);
            }
            let body = bodies[id].get_or_insert_with(|| Body {
                first: index,
                last: index,
                displayed: String::new(),
            });
            body.last = index;
            body.displayed.push_str(&piece.display);
            work.copied += piece.display.len();
            work.items += 2;
        }
        for (id, body) in bodies.into_iter().enumerate() {
            work.items += 1;
            let Some(body) = body else {
                continue;
            };
            let (open, close) = markers[id]
                .source
                .as_ref()
                .ok_or(EditorError::UnrepresentableFormat)?;
            let SpanKind::Link(meaning) = &markers[id].kind else {
                return Err(EditorError::UnrepresentableFormat);
            };
            if meaning.title.is_some()
                || meaning.reference.is_some()
                || body.first == 0
                || body.last + 1 >= pieces.len()
            {
                return Err(EditorError::UnrepresentableFormat);
            }
            let opener = &pieces[body.first - 1];
            let closer = &pieces[body.last + 1];
            work.items += 6;
            if opener.display != "<"
                || closer.display != ">"
                || !matches!(&opener.origin, Some(PieceOrigin::Source(source)) if source.end == open.start && source.len() == opener.raw.len())
                || !matches!(&closer.origin, Some(PieceOrigin::Source(source)) if source.start == close.end && source.len() == closer.raw.len())
            {
                return Err(EditorError::UnrepresentableFormat);
            }
            let (canonical, read) = crate::inline::links::bare_links(&body.displayed);
            work.items += read.items;
            work.parsed += read.parsed;
            work.copied += read.copied;
            work.items += 1 + canonical.len();
            let valid = canonical.len() == 1
                && canonical[0].open.start == 0
                && canonical[0].close.end == body.displayed.len()
                && match &canonical[0].kind {
                    SpanKind::Link(target) => {
                        work.items += target.destination.len() + meaning.destination.len();
                        target == meaning
                    }
                    _ => false,
                };
            if !valid {
                return Err(EditorError::UnrepresentableFormat);
            }
            let owner = self.owners.len();
            work.items += 3;
            work.copied += body.displayed.len();
            self.owners.push(Some(Arc::new(CodeWordIdentity {
                meaning: meaning.clone(),
                displayed: Arc::from(body.displayed),
            })));
            pieces[body.first - 1].guard = Some(GuardPart {
                id: owner,
                role: GuardRole::Open,
            });
            pieces[body.last + 1].guard = Some(GuardPart {
                id: owner,
                role: GuardRole::Close,
            });
            for piece in &mut pieces[body.first..=body.last] {
                work.items += 2;
                if piece.literal_url != Some(id) {
                    return Err(EditorError::UnrepresentableFormat);
                }
                piece.guard = Some(GuardPart {
                    id: owner,
                    role: GuardRole::Inner,
                });
            }
        }
        Ok(work)
    }
}
