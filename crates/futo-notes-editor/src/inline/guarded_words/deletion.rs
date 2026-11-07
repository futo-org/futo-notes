//! One actual user deletion may continue a live URI with a fresh payload.
use super::*;
use crate::inline::{
    edit::EditIntent,
    references::ReferenceWork,
    row::SpanKind,
    spelling::{Marker, Piece, PieceOrigin},
};
use crate::{InlineFormat, InputAction};

impl GuardState {
    pub(in crate::inline) fn prove_deletion(
        &self,
        pieces: &[Piece],
        markers: &[Marker],
        selected: Range<usize>,
        inserted: &str,
        intent: EditIntent,
    ) -> Result<(Option<usize>, usize), EditorError> {
        if self.owners.is_empty()
            || !inserted.is_empty()
            || selected.is_empty()
            || intent.action() != Some(InputAction::Isolated)
        {
            return Ok((None, 0));
        }
        let mut owner = None;
        let mut code = None;
        let mut at = 0;
        let mut work = 0;
        for piece in pieces {
            work += 1;
            let end = at + piece.display.len();
            if at < selected.end && selected.start < end {
                work += 4;
                if at < selected.start || selected.end < end {
                    return Err(EditorError::UnrepresentableFormat);
                }
                let Some(part) = piece.guard else {
                    return Ok((None, work));
                };
                if part.role != GuardRole::Inner
                    || owner.is_some_and(|id| id != part.id)
                    || !matches!(&piece.origin, Some(PieceOrigin::Source(source)) if source.len() == piece.raw.len())
                {
                    return Err(EditorError::UnrepresentableFormat);
                }
                owner = Some(part.id);
                let mut piece_code = None;
                for id in &piece.spans {
                    work += 1;
                    if markers[*id].kind == SpanKind::Format(InlineFormat::Code) {
                        piece_code = Some(*id);
                    }
                }
                let Some(id) = piece_code else {
                    return Ok((None, work));
                };
                if code.is_some_and(|old| old != id) {
                    return Err(EditorError::UnrepresentableFormat);
                }
                code = Some(id);
            }
            at = end;
        }
        let (Some(owner), Some(code)) = (owner, code) else {
            return Ok((None, work));
        };
        // The selected complete body is the only Code span in this owner. A
        // canonical marker's omitted source bytes remain the emitter's job.
        at = 0;
        for piece in pieces {
            work += 1;
            let end = at + piece.display.len();
            for id in &piece.spans {
                work += 1;
                if *id == code && !(selected.start <= at && end <= selected.end) {
                    return Err(EditorError::UnrepresentableFormat);
                }
                if piece.guard.is_some_and(|part| part.id == owner)
                    && markers[*id].kind == SpanKind::Format(InlineFormat::Code)
                    && *id != code
                {
                    return Err(EditorError::UnrepresentableFormat);
                }
            }
            at = end;
        }
        Ok((Some(owner), work))
    }

    pub(in crate::inline) fn finish_deletion(
        &mut self,
        pieces: &[Piece],
        owner: usize,
    ) -> Result<ReferenceWork, EditorError> {
        let mut work = ReferenceWork::default();
        let mut displayed = String::new();
        let (mut open, mut close) = (0, 0);
        for piece in pieces {
            work.items += 1;
            let Some(part) = piece.guard.filter(|part| part.id == owner) else {
                continue;
            };
            work.items += 2;
            if !matches!(piece.origin, Some(PieceOrigin::Source(_))) {
                return Err(EditorError::UnrepresentableFormat);
            }
            match part.role {
                GuardRole::Open => open += 1,
                GuardRole::Close => close += 1,
                GuardRole::Inner => {
                    displayed.push_str(&piece.display);
                    work.copied += piece.display.len();
                }
            }
        }
        if open != 1 || close != 1 {
            return Err(EditorError::UnrepresentableFormat);
        }
        let (canonical, read) = crate::inline::links::bare_links(&displayed);
        work.items += read.items;
        work.parsed += read.parsed;
        work.copied += read.copied;
        work.items += 1 + canonical.len();
        if canonical.is_empty() {
            // Only this proven user deletion may retire the actual owner. The
            // final emitter still owes complete membership and canonical literal
            // NoCode/NoLink proof before the owner is omitted from its output.
            work.items += 2;
            self.after_deletion = Some(AfterDeletion::RetireLiteral { owner, displayed });
            return Ok(work);
        }
        let Some(span) = canonical.first().filter(|span| {
            canonical.len() == 1 && span.open.start == 0 && span.close.end <= displayed.len()
        }) else {
            return Err(EditorError::UnrepresentableFormat);
        };
        let SpanKind::Link(meaning) = &span.kind else {
            return Err(EditorError::UnrepresentableFormat);
        };
        if meaning.title.is_some() || meaning.reference.is_some() {
            return Err(EditorError::UnrepresentableFormat);
        }
        work.items += 1;
        if span.close.end < displayed.len() {
            // A parser-trimmed suffix no longer forms the whole owned URI.
            // Keep the same complete literal retirement proof as a non-URI.
            work.items += 2;
            self.after_deletion = Some(AfterDeletion::RetireLiteral { owner, displayed });
            return Ok(work);
        }
        work.items += 3;
        work.copied += displayed.len();
        self.owners[owner] = Some(Arc::new(CodeWordIdentity {
            meaning: meaning.clone(),
            displayed: Arc::from(displayed),
        }));
        self.after_deletion = Some(AfterDeletion::Continue(owner));
        Ok(work)
    }
}
