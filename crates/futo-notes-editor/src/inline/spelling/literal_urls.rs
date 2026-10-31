//! Standard local spelling for literal URI words owned by a Code command.
//! IDs and source intervals come from this exact render, never matching text.
use super::{render::Rendered, Marker, Piece, PieceOrigin, Row, SpanKind};
use crate::{inline::references::ReferenceWork, EditorError, InlineFormat};
use std::ops::Range;

#[derive(Default)]
pub(super) struct Words {
    by_id: Vec<Option<Range<usize>>>,
    ordered: Vec<Range<usize>>,
}

impl Words {
    pub(super) fn read(
        pieces: &[Piece],
        markers: &[Marker],
        rendered: &Rendered,
        work: &mut ReferenceWork,
    ) -> Result<Self, EditorError> {
        if !markers.iter().any(|marker| {
            work.items += 1;
            marker.literal_url
        }) {
            return Ok(Self::default());
        }
        work.items += 2 + markers.len();
        let mut result = Self {
            by_id: vec![None; markers.len()],
            ordered: Vec::with_capacity(markers.len()),
        };
        for (piece, output) in pieces.iter().zip(&rendered.pieces) {
            work.items += 1;
            let Some(id) = piece.literal_url else {
                continue;
            };
            if !markers[id].literal_url || !matches!(piece.origin, Some(PieceOrigin::Source(_))) {
                return Err(EditorError::UnrepresentableFormat);
            }
            work.items += 2;
            let range = result.by_id[id].get_or_insert_with(|| output.clone());
            range.end = output.end;
        }
        // The same emitter owns these new inline marker bytes. Its closing
        // order is inner before outer; extend only a body contained in one
        // original word, never a format spanning foreign words or prefixes.
        for (_, span) in &rendered.spans {
            work.items += 1;
            if !matches!(span.kind, SpanKind::Format(_)) {
                continue;
            }
            let index = rendered.pieces.partition_point(|piece| {
                work.items += 1;
                piece.end <= span.open.end
            });
            let Some(id) = pieces.get(index).and_then(|piece| piece.literal_url) else {
                continue;
            };
            let Some(range) = &mut result.by_id[id] else {
                continue;
            };
            work.items += 2;
            if range.start <= span.open.end && span.close.start <= range.end {
                range.start = range.start.min(span.open.start);
                range.end = range.end.max(span.close.end);
            }
        }
        for (id, range) in result.by_id.iter().enumerate() {
            work.items += 1;
            if markers[id].literal_url && range.is_none() {
                return Err(EditorError::UnrepresentableFormat);
            }
            if let Some(range) = range {
                work.items += 2;
                result.ordered.push(range.clone());
            }
        }
        if result.ordered.windows(2).any(|pair| {
            work.items += 1;
            pair[0].start > pair[1].start || pair[0].end > pair[1].start
        }) {
            return Err(EditorError::UnrepresentableFormat);
        }
        Ok(result)
    }

    pub(super) fn has_owners(&self) -> bool {
        !self.by_id.is_empty()
    }

    pub(super) fn repair(
        &self,
        pieces: &mut [Piece],
        markers: &[Marker],
        rendered: &Rendered,
        candidate: &Row,
        work: &mut ReferenceWork,
    ) -> Result<bool, EditorError> {
        if !self.has_owners() {
            return Ok(false);
        }
        work.items += 1;
        let mut links = Vec::with_capacity(candidate.spans.len());
        for span in &candidate.spans {
            work.items += 1;
            if matches!(span.kind, SpanKind::Link(_)) {
                work.items += 1;
                links.push(span);
            }
        }
        let mut changed = false;
        let mut link = 0;
        let mut repaired = None;
        for (piece, output) in pieces.iter_mut().zip(&rendered.pieces) {
            work.items += 1;
            while link < links.len() && links[link].close.end <= output.start {
                work.items += 1;
                link += 1;
            }
            let Some(id) = piece.literal_url else {
                continue;
            };
            if piece.raw != ":" || piece.display != ":" || repaired == Some(link) {
                continue;
            }
            if piece.spans.iter().any(|id| {
                work.items += 1;
                matches!(
                    markers[*id].kind,
                    SpanKind::Link(_) | SpanKind::Format(InlineFormat::Code)
                )
            }) {
                continue;
            }
            let Some(span) = links.get(link) else {
                continue;
            };
            work.items += 2;
            if output.start < span.open.end || span.close.start < output.end {
                continue;
            }
            let range = self.by_id[id]
                .as_ref()
                .ok_or(EditorError::UnrepresentableFormat)?;
            if span.open.end < range.start || range.end < span.close.start {
                return Err(EditorError::UnrepresentableFormat);
            }
            let Some(PieceOrigin::Source(original)) = &piece.origin else {
                return Err(EditorError::UnrepresentableFormat);
            };
            work.items += 1;
            if original.len() != 1 || output.len() != 1 {
                return Err(EditorError::UnrepresentableFormat);
            }
            // The canonical raw-token parser proves this smallest standard
            // escape. Neighboring retained scalar origins own its endpoints;
            // no interior transformed-atom identity is manufactured.
            piece.raw.insert(0, '\\');
            piece.timing = true;
            work.copied += 2;
            changed = true;
            repaired = Some(link);
        }
        Ok(changed)
    }

    pub(super) fn verify(
        &self,
        pieces: &[Piece],
        rendered: &Rendered,
        candidate: &Row,
        work: &mut ReferenceWork,
    ) -> Result<(), EditorError> {
        if !self.has_owners() {
            return Ok(());
        }
        for span in &candidate.spans {
            work.items += 1;
            if !matches!(span.kind, SpanKind::Link(_)) {
                continue;
            }
            let first = self.ordered.partition_point(|range| {
                work.items += 1;
                range.end <= span.open.start
            });
            if self.ordered.get(first).is_some_and(|range| {
                work.items += 1;
                range.start < span.close.end
            }) {
                return Err(EditorError::UnrepresentableFormat);
            }
        }
        // New trusted scalar provenance is checked against the final parser's
        // complete nonidentity atom BEFORE the real source append.
        for (piece, output) in pieces.iter().zip(&rendered.pieces) {
            work.items += 1;
            if piece.literal_url.is_none() || !piece.timing || piece.raw != "\\:" {
                continue;
            }
            let index = candidate.segments.partition_point(|segment| {
                work.items += 1;
                segment.source.start < output.start
            });
            let valid = candidate.segments.get(index).is_some_and(|segment| {
                work.items += 3;
                segment.source == *output
                    && !segment.identity
                    && &candidate.display[segment.display.clone()] == ":"
            });
            if !valid {
                return Err(EditorError::UnrepresentableFormat);
            }
        }
        Ok(())
    }
}
