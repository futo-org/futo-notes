//! Exact retained input origins use the same proven source correspondence.
use super::{render::Rendered, Piece};
use crate::{
    inline::{
        typed_angle::{TypedAngleOrigin, TypedState},
        SourceCorrespondence,
    },
    EditorError,
};

impl TypedState {
    pub(super) fn emit(
        &self,
        pieces: &[Piece],
        rendered: &Rendered,
        raw: &str,
        work: &mut usize,
    ) -> Result<Option<Vec<TypedAngleOrigin>>, EditorError> {
        if !self.has_update() {
            return Ok(None);
        }
        if self.retained.as_ref().is_some_and(Vec::is_empty) {
            return Ok(Some(Vec::new()));
        }
        let origins = super::url_timing::collect_origins(pieces, rendered, work);
        let (index, visits) = SourceCorrespondence::verify(raw, "", &rendered.text, origins, 0);
        *work += visits;
        let mut output = Vec::new();
        for origin in self.retained.iter().flatten() {
            let (origin, visits) = origin.map(&(0..rendered.text.len()), &mut |range| {
                index.retained_range(range)
            })?;
            *work += visits;
            output.push(origin);
        }
        Ok(Some(output))
    }
}
