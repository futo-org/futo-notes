//! One temporary spelling plan, borrowing no source beyond its caller.
use super::*;
use crate::inline::{edit::EditIntent, Projection};
use crate::DisplayRange;

pub(in crate::inline) struct TypedState {
    // None records an explicitly retired local owner for Some(empty) output.
    pub retained: Option<Vec<TypedAngleOrigin>>,
}
impl TypedState {
    pub fn current(origins: Vec<TypedAngleOrigin>) -> Self {
        Self {
            retained: (!origins.is_empty()).then_some(origins),
        }
    }
    pub fn has_update(&self) -> bool {
        self.retained.is_some()
    }
    /// Until the input producer supplies a real continuation/handoff, a touched
    /// supplied origin must fail before acceptance rather than survive stale.
    pub fn require_unchanged_input(
        &self,
        projection: &Projection,
        source_start: usize,
        range: DisplayRange,
        inserted: &str,
        intent: EditIntent,
    ) -> Result<usize, EditorError> {
        if !matches!(intent, EditIntent::Input(_))
            || range.start == range.end && inserted.is_empty()
        {
            return Ok(0);
        }
        let mut work = 0;
        for origin in self.retained.iter().flatten() {
            let (a, x) = projection.display_at_with_work(source_start + origin.opener.start);
            let (z, y) = projection.display_at_with_work(source_start + origin.word.end);
            work += x + y + 4;
            if range.start.0 < z && a < range.end.0
                || range.start == range.end && a < range.start.0 && range.start.0 <= z
            {
                return Err(EditorError::UnrepresentableFormat);
            }
        }
        Ok(work)
    }
}
impl Projection {
    pub(in crate::inline) fn scope_typed_origins(
        &self,
        origins: Vec<TypedAngleOrigin>,
        source_start: usize,
        selected: DisplayRange,
    ) -> Result<(Vec<TypedAngleOrigin>, usize), EditorError> {
        let mut result = Vec::new();
        let mut work = 0;
        for origin in origins {
            let (a, x) = self.display_at_with_work(source_start + origin.opener.start);
            let (z, y) = self.display_at_with_work(source_start + origin.word.end);
            work += x + y + 4;
            if selected.start.0 <= a && z <= selected.end.0 {
                result.push(origin);
            } else if a < selected.end.0 && selected.start.0 < z {
                return Err(EditorError::UnrepresentableFormat);
            }
        }
        Ok((result, work))
    }
}
