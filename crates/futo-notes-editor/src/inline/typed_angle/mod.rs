//! Actual ordered input lineage before a WWW word has canonical link syntax.
use crate::inline::guarded_words::CodeWordIdentity;
use crate::{EditorError, SourceEdit};
use std::{ops::Range, sync::Arc};
mod input;
mod snapshots;
pub(in crate::inline) use input::Input;
mod state;
pub(in crate::inline) use state::TypedState;
mod validate;
pub(in crate::inline) use validate::validate_row;

#[derive(Clone)]
pub(crate) struct TypedAngleOrigin {
    pub opener: Range<usize>,
    pub word: Range<usize>,
    /// None is a witnessed incomplete/candidate word, never guessed URI meaning.
    pub uri: Option<Arc<CodeWordIdentity>>,
}
impl TypedAngleOrigin {
    pub(crate) fn envelope(&self) -> Range<usize> {
        self.opener.start..self.word.end
    }
    pub(crate) fn relocate(&mut self, origin: usize) -> usize {
        self.opener.start += origin;
        self.opener.end += origin;
        self.word.start += origin;
        self.word.end += origin;
        4
    }
    pub(crate) fn map(
        &self,
        window: &Range<usize>,
        map: &mut impl FnMut(Range<usize>) -> (Option<Range<usize>>, usize),
    ) -> Result<(Self, usize), EditorError> {
        let (opener, a) = map(self.opener.clone());
        let (word, z) = map(self.word.clone());
        let (Some(opener), Some(word)) = (opener, word) else {
            return Err(EditorError::UnrepresentableFormat);
        };
        if opener.is_empty()
            || word.is_empty()
            || opener.end != word.start
            || opener.start < window.start
            || word.end > window.end
        {
            return Err(EditorError::UnrepresentableFormat);
        }
        Ok((
            Self {
                opener,
                word,
                uri: self.uri.clone(),
            },
            a + z + 9,
        ))
    }
    pub(crate) fn raw_edit(&self, edit: &SourceEdit) -> (Option<Self>, usize) {
        let range = edit.range.start.0..edit.range.end.0;
        if range.is_empty() && edit.inserted.is_empty() {
            return (Some(self.clone()), 5);
        }
        // End insertion is a typing transition only through the actual input
        // owner. Raw source append cannot silently extend this pending word.
        if self.word.end < range.start || self.word.end == range.start && !range.is_empty() {
            return (Some(self.clone()), 7);
        }
        if range.end <= self.opener.start {
            let shift = |at| at - range.len() + edit.inserted.len();
            return (
                Some(Self {
                    opener: shift(self.opener.start)..shift(self.opener.end),
                    word: shift(self.word.start)..shift(self.word.end),
                    uri: self.uri.clone(),
                }),
                9,
            );
        }
        (None, 2)
    }
    pub(crate) fn same(&self, other: &Self) -> (bool, usize) {
        (
            self.opener == other.opener
                && self.word == other.word
                && match (&self.uri, &other.uri) {
                    (Some(a), Some(b)) => Arc::ptr_eq(a, b),
                    (None, None) => true,
                    _ => false,
                },
            3,
        )
    }
}

/// A committed single separator has the same proved word-ending intent; it
/// never supplies a new Typing seed.
pub(super) fn single_separator(text: &str, work: &mut usize) -> bool {
    let mut chars = text.chars();
    *work += 2;
    chars.next().is_some_and(char::is_whitespace) && chars.next().is_none()
}
