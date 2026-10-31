//! One temporary spelling plan, borrowing no source beyond its caller.
use super::*;
use crate::inline::{edit::EditIntent, Projection};
use crate::DisplayRange;

pub(in crate::inline) struct EmittedOrigin {
    pub opener: usize,
    pub body: Range<usize>,
    pub uri: Option<Arc<CodeWordIdentity>>,
}

pub(in crate::inline) struct TypedState {
    // None records an explicitly retired local owner for Some(empty) output.
    pub retained: Option<Vec<TypedAngleOrigin>>,
    pub emitted: Vec<EmittedOrigin>,
}
impl TypedState {
    pub fn current(origins: Vec<TypedAngleOrigin>) -> Self {
        Self {
            retained: (!origins.is_empty()).then_some(origins),
            emitted: Vec::new(),
        }
    }
    pub fn has_update(&self) -> bool {
        self.retained.is_some() || !self.emitted.is_empty()
    }
    /// A selected isolated correction retires its supplied owner. Other touched
    /// input paths still require their own continuation or retirement proof.
    pub fn prepare_other_input(
        &mut self,
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
        let mut unsupported = false;
        let mut compacting = false;
        if let Some(origins) = &mut self.retained {
            origins.retain(|origin| {
                let (a, x) = projection.display_at_with_work(source_start + origin.opener.start);
                let (z, y) = projection.display_at_with_work(source_start + origin.word.end);
                work += x + y + 4;
                let touched = range.start.0 < z && a < range.end.0
                    || range.start == range.end && a < range.start.0 && range.start.0 <= z;
                if touched {
                    if matches!(intent, EditIntent::Input(crate::InputAction::Isolated))
                        && range.start != range.end
                        && !inserted.is_empty()
                    {
                        let (start, visits) =
                            projection.display_at_with_work(source_start + origin.word.start);
                        work += visits + 2;
                        if start <= range.start.0 && range.end.0 <= z {
                            let old = projection.display.byte_slice(range.start.0..range.end.0);
                            work += 1;
                            let same = old.len_bytes() == inserted.len()
                                && old.bytes().zip(inserted.bytes()).all(|(a, b)| {
                                    work += 1;
                                    a == b
                                });
                            if !same {
                                compacting = true;
                                return false;
                            }
                        }
                    }
                    unsupported = true;
                }
                // retain moves each surviving fixed field after a removed one.
                work += 5 * usize::from(compacting);
                true
            });
        }
        if unsupported {
            return Err(EditorError::UnrepresentableFormat);
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
