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
        let mut output = Vec::new();
        if self
            .retained
            .as_ref()
            .is_some_and(|origins| !origins.is_empty())
        {
            let origins = super::url_timing::collect_origins(pieces, rendered, work);
            let (index, visits) = SourceCorrespondence::verify(raw, "", &rendered.text, origins, 0);
            *work += visits;
            for origin in self.retained.iter().flatten() {
                let (origin, visits) = origin.map(&(0..rendered.text.len()), &mut |range| {
                    index.retained_range(range)
                })?;
                *work += visits;
                output.push(origin);
            }
        }
        for origin in &self.emitted {
            *work += 3;
            let opener = rendered
                .pieces
                .get(origin.opener)
                .ok_or(EditorError::UnrepresentableFormat)?;
            if origin.body.is_empty() || origin.opener + 1 != origin.body.start || opener.is_empty()
            {
                return Err(EditorError::UnrepresentableFormat);
            }
            let mut at = opener.end;
            for index in origin.body.clone() {
                *work += 3;
                let part = rendered
                    .pieces
                    .get(index)
                    .ok_or(EditorError::UnrepresentableFormat)?;
                if part.is_empty() || part.start != at {
                    // Unproven format/prefix/inserted syntax is a hole, not
                    // permission to extend an old source word by min/max.
                    return Err(EditorError::UnrepresentableFormat);
                }
                at = part.end;
            }
            *work += 5;
            output.push(TypedAngleOrigin {
                opener: opener.clone(),
                word: opener.end..at,
                uri: origin.uri.clone(),
            });
        }
        output.sort_unstable_by(|a, b| {
            *work += 1;
            (a.opener.start, a.word.end).cmp(&(b.opener.start, b.word.end))
        });
        Ok(Some(output))
    }
}
