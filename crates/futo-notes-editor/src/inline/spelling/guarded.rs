//! Complete membership in the actual final physical emitter, including markers.
use super::render::Rendered;
use crate::inline::guarded_words::*;
use crate::inline::{
    row::{Row, SpanKind},
    spelling::{Marker, Piece},
};
use crate::EditorError;
use std::ops::Range;

impl GuardState {
    pub(super) fn collect(
        &self,
        pieces: &[Piece],
        markers: &[Marker],
        rendered: &Rendered,
        candidate: &Row,
        work: &mut usize,
    ) -> Result<Vec<GuardedWord>, EditorError> {
        if self.owners.is_empty() {
            return Ok(Vec::new());
        }
        // Consecutive same-owner body pieces form one indexed membership run.
        // A format marker can inherit only an entirely covered inner run.
        let mut run_end = vec![0; pieces.len()];
        *work += 1 + pieces.len();
        for i in (0..pieces.len()).rev() {
            *work += 2;
            run_end[i] = i + 1;
            if i + 1 < pieces.len()
                && pieces[i].guard.is_some_and(|a| {
                    *work += 2;
                    a.role == GuardRole::Inner
                        && pieces[i + 1]
                            .guard
                            .is_some_and(|b| a.id == b.id && b.role == GuardRole::Inner)
                })
            {
                run_end[i] = run_end[i + 1];
            }
        }
        let mut intervals = Vec::with_capacity(pieces.len() + 2 * rendered.spans.len());
        *work += 1;
        for (piece, range) in pieces.iter().zip(&rendered.pieces) {
            *work += 1;
            if !range.is_empty() {
                *work += 3;
                intervals.push((range.clone(), piece.guard));
            } else if piece.guard.is_some() {
                // Empty carriers cannot manufacture membership across a hole.
                return Err(EditorError::UnrepresentableFormat);
            }
        }
        for (id, span) in &rendered.spans {
            *work += 1;
            let first = rendered.pieces.partition_point(|range| {
                *work += 1;
                range.end <= span.open.end
            });
            let last = rendered.pieces.partition_point(|range| {
                *work += 1;
                range.start < span.close.start
            });
            let owner = if matches!(markers[*id].kind, SpanKind::Format(_))
                && first < last
                && run_end[first] >= last
            {
                pieces[first]
                    .guard
                    .filter(|part| part.role == GuardRole::Inner)
            } else {
                None
            };
            for range in [&span.open, &span.close] {
                *work += 1;
                if !range.is_empty() {
                    *work += 3;
                    intervals.push((range.clone(), owner));
                }
            }
        }
        intervals.sort_unstable_by(|(a, _), (b, _)| {
            *work += 1;
            (a.start, a.end).cmp(&(b.start, b.end))
        });
        let mut result = Vec::new();
        let mut seen = vec![false; self.owners.len()];
        *work += 1 + seen.len();
        let mut current: Option<(usize, Range<usize>, Range<usize>)> = None;
        let mut retired_range = None;
        for (range, part) in intervals {
            *work += 1;
            let Some(part) = part else {
                if current.is_some() {
                    return Err(EditorError::UnrepresentableFormat);
                }
                continue;
            };
            match (part.role, current.as_mut()) {
                (GuardRole::Open, None) if !seen[part.id] => {
                    *work += 4;
                    current = Some((part.id, range.clone(), range.end..range.end));
                }
                (GuardRole::Inner, Some((id, envelope, inner)))
                    if *id == part.id && envelope.end == range.start =>
                {
                    *work += 3;
                    envelope.end = range.end;
                    inner.end = range.end;
                }
                (GuardRole::Close, Some((id, envelope, inner)))
                    if *id == part.id && envelope.end == range.start =>
                {
                    *work += 7;
                    let identity = self.owners[*id]
                        .as_ref()
                        .ok_or(EditorError::UnrepresentableFormat)?;
                    let retire = matches!(&self.after_deletion,
                        Some(AfterDeletion::RetireLiteral { owner, .. }) if owner == id);
                    if retire {
                        if retired_range.is_some() {
                            return Err(EditorError::UnrepresentableFormat);
                        }
                        retired_range = Some((envelope.start..range.end, inner.clone()));
                    } else {
                        if inner.is_empty() {
                            return Err(EditorError::UnrepresentableFormat);
                        }
                        result.push(GuardedWord {
                            envelope: envelope.start..range.end,
                            inner: inner.clone(),
                            identity: identity.clone(),
                        });
                    }
                    seen[*id] = true;
                    current = None;
                }
                _ => return Err(EditorError::UnrepresentableFormat),
            }
        }
        if current.is_some()
            || seen.iter().zip(&self.owners).any(|(seen, owner)| {
                *work += 1;
                owner.is_some() && !seen
            })
        {
            return Err(EditorError::UnrepresentableFormat);
        }
        if let Some(AfterDeletion::Continue(id)) = &self.after_deletion {
            let identity = self.owners[*id]
                .as_ref()
                .ok_or(EditorError::UnrepresentableFormat)?;
            let word = result
                .iter()
                .find(|word| {
                    *work += 1;
                    std::sync::Arc::ptr_eq(&word.identity, identity)
                })
                .ok_or(EditorError::UnrepresentableFormat)?;
            for span in &candidate.spans {
                *work += 1;
                if span.kind == SpanKind::Format(crate::InlineFormat::Code)
                    && span.open.start < word.envelope.end
                    && word.envelope.start < span.close.end
                {
                    return Err(EditorError::UnrepresentableFormat);
                }
            }
        }
        let retired =
            if let Some(AfterDeletion::RetireLiteral { displayed, .. }) = &self.after_deletion {
                let (envelope, inner) = retired_range.ok_or(EditorError::UnrepresentableFormat)?;
                *work += 3;
                Some(LiteralRetirement {
                    envelope,
                    inner,
                    displayed,
                })
            } else {
                None
            };
        *work += validate_with_retirement(&rendered.text, candidate, &result, retired.as_ref())?;
        Ok(result)
    }
}
