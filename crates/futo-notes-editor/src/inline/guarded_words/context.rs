//! Nonemitting owner table for one actual bounded spelling context.
use super::*;
use crate::inline::spelling::{Piece, PieceOrigin};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(in crate::inline) enum GuardRole {
    Open,
    Inner,
    Close,
}
#[derive(Clone, Copy)]
pub(in crate::inline) struct GuardPart {
    pub id: usize,
    pub role: GuardRole,
}
#[derive(Default)]
pub(in crate::inline) struct GuardState {
    pub owners: Vec<Option<Arc<CodeWordIdentity>>>,
}
impl GuardState {
    pub fn bind(
        words: Vec<GuardedWord>,
        pieces: &mut [Piece],
        work: &mut usize,
    ) -> Result<Self, EditorError> {
        if words.is_empty() {
            return Ok(Self::default());
        }
        let mut result = Self::default();
        for word in &words {
            result.owners.push(Some(word.identity.clone()));
            *work += 1;
        }
        for piece in pieces {
            *work += 1;
            let Some(PieceOrigin::Source(source)) = &piece.origin else {
                continue;
            };
            if source.is_empty() {
                continue;
            }
            let id = words.partition_point(|word| {
                *work += 1;
                word.envelope.end <= source.start
            });
            let Some(word) = words.get(id) else {
                continue;
            };
            *work += 2;
            if word.envelope.end <= source.start || source.end <= word.envelope.start {
                continue;
            }
            if source.start < word.envelope.start || source.end > word.envelope.end {
                return Err(EditorError::UnrepresentableFormat);
            }
            let role = if *source == (word.envelope.start..word.inner.start) {
                GuardRole::Open
            } else if *source == (word.inner.end..word.envelope.end) {
                GuardRole::Close
            } else if word.inner.start <= source.start && source.end <= word.inner.end {
                GuardRole::Inner
            } else {
                return Err(EditorError::UnrepresentableFormat);
            };
            piece.guard = Some(GuardPart { id, role });
            *work += 2;
        }
        Ok(result)
    }
}

impl GuardState {
    /// Project the validated current row's owners into a real selected body.
    /// All original pieces of a field must be kept or all excluded. A partial
    /// envelope remains an error; foreign fields stay with the parent snapshot.
    pub(in crate::inline) fn scope_body(
        &mut self,
        pieces: &[Piece],
        start: usize,
        selected: Range<usize>,
    ) -> Result<usize, EditorError> {
        if self.owners.is_empty() {
            return Ok(0);
        }
        let mut kept = vec![false; self.owners.len()];
        let mut excluded = vec![false; self.owners.len()];
        let mut work = 2 + kept.len() + excluded.len();
        let mut at = start;
        for piece in pieces {
            work += 1;
            let end = at + piece.display.len();
            if let Some(part) = piece.guard {
                work += 2;
                if !piece.display.is_empty() && selected.start <= at && end <= selected.end {
                    kept[part.id] = true;
                } else {
                    excluded[part.id] = true;
                }
            }
            at = end;
        }
        let mut any = false;
        for (id, owner) in self.owners.iter_mut().enumerate() {
            work += 2;
            if kept[id] && excluded[id] || owner.is_some() && !kept[id] && !excluded[id] {
                return Err(EditorError::UnrepresentableFormat);
            }
            if excluded[id] {
                *owner = None;
            }
            any |= owner.is_some();
        }
        if !any {
            self.owners.clear();
        }
        Ok(work)
    }
}
