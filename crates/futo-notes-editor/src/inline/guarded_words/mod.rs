//! Transient ownership of a typed URI whose automatic link was retired by Code.
//! Standard Markdown owns saved meaning; these fields never survive recovery.
mod context;
mod deletion;
mod producer;
mod snapshots;
pub(in crate::inline) use context::{GuardPart, GuardRole, GuardState};
mod validate;
use super::row::LinkMeaning;
use crate::EditorError;
use std::{ops::Range, sync::Arc};
pub(crate) use validate::validate_row;

pub(crate) struct CodeWordIdentity {
    pub meaning: Arc<LinkMeaning>,
    pub displayed: Arc<str>,
}

#[derive(Clone)]
pub(crate) struct GuardedWord {
    pub envelope: Range<usize>,
    pub inner: Range<usize>,
    pub identity: Arc<CodeWordIdentity>,
}

impl GuardedWord {
    pub(crate) fn map(
        &self,
        window: &Range<usize>,
        map: &mut impl FnMut(Range<usize>) -> (Option<Range<usize>>, usize),
    ) -> Result<(Self, usize), EditorError> {
        let (envelope, a) = map(self.envelope.clone());
        let (inner, z) = map(self.inner.clone());
        let (Some(envelope), Some(inner)) = (envelope, inner) else {
            return Err(EditorError::UnrepresentableFormat);
        };
        if envelope.is_empty()
            || inner.is_empty()
            || envelope.start < window.start
            || window.end < envelope.end
            || inner.start < envelope.start
            || envelope.end < inner.end
        {
            return Err(EditorError::UnrepresentableFormat);
        }
        Ok((
            Self {
                envelope,
                inner,
                identity: self.identity.clone(),
            },
            a + z + 9,
        ))
    }

    pub(crate) fn relocate(&mut self, origin: usize) -> usize {
        self.envelope.start += origin;
        self.envelope.end += origin;
        self.inner.start += origin;
        self.inner.end += origin;
        4
    }

    pub(crate) fn same(&self, other: &Self) -> (bool, usize) {
        (
            self.envelope == other.envelope
                && self.inner == other.inner
                && Arc::ptr_eq(&self.identity, &other.identity),
            3,
        )
    }

    /// An actual external source edit retires any interior/overwritten owner.
    /// A boundary insertion moves starts Right and leaves ends Left.
    pub(crate) fn raw_edit(&self, edit: &crate::SourceEdit) -> (Option<Self>, usize) {
        let range = edit.range.start.0..edit.range.end.0;
        if self.envelope.end <= range.start {
            return (Some(self.clone()), 2);
        }
        if range.end <= self.envelope.start {
            let shift = |at| at - range.len() + edit.inserted.len();
            return (
                Some(Self {
                    envelope: shift(self.envelope.start)..shift(self.envelope.end),
                    inner: shift(self.inner.start)..shift(self.inner.end),
                    identity: self.identity.clone(),
                }),
                7,
            );
        }
        (None, 2)
    }
}

/// Explicit replacement scope from one actual final emitter. Empty words retire
/// the opening scope; None at a consumer means no ownership update.
pub(crate) struct GuardUpdate {
    pub before: Range<usize>,
    pub after: Range<usize>,
    pub words: Vec<GuardedWord>,
    pub typed_inputs: Vec<crate::inline::typed_angle::TypedAngleOrigin>,
}
impl crate::inline::spelling::Spelling {
    pub(in crate::inline) fn take_guards(
        &mut self,
        start: usize,
        end: usize,
    ) -> Option<GuardUpdate> {
        if self.guarded_words.is_none() && self.typed_inputs.is_none() {
            return None;
        }
        Some(GuardUpdate {
            before: start..end,
            after: start..start + self.text.len(),
            words: self.guarded_words.take().unwrap_or_default(),
            typed_inputs: self.typed_inputs.take().unwrap_or_default(),
        })
    }
}
