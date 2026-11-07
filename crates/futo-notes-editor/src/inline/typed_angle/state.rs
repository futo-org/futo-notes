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
    // Current operation only: never emitted as a retained input origin.
    pub literal_capsules: Vec<Range<usize>>,
}
impl TypedState {
    pub fn current(origins: Vec<TypedAngleOrigin>) -> Self {
        Self {
            retained: (!origins.is_empty()).then_some(origins),
            emitted: Vec::new(),
            literal_capsules: Vec::new(),
        }
    }
    pub fn has_update(&self) -> bool {
        self.retained.is_some() || !self.emitted.is_empty()
    }
    /// Explicit input mutation retires the supplied identity. Ordered Typing
    /// at word.end instead belongs to the continuation/ending owner.
    pub fn prepare_input_mutations(
        &mut self,
        projection: &Projection,
        source_start: usize,
        range: DisplayRange,
        inserted: &str,
        intent: EditIntent,
    ) -> usize {
        let Some(action) = intent.action() else {
            return 0;
        };
        if range.start == range.end && inserted.is_empty() {
            return 0;
        }
        let mut work = 0;
        let mut compacting = false;
        if let Some(origins) = &mut self.retained {
            origins.retain(|origin| {
                let (a, x) = projection.display_at_with_work(source_start + origin.opener.start);
                let (z, y) = projection.display_at_with_work(source_start + origin.word.end);
                work += x + y + 4;
                let touched = range.start.0 < z && a < range.end.0
                    || range.start == range.end && a < range.start.0 && range.start.0 <= z;
                if touched {
                    let at_end = range.start == range.end && range.start.0 == z;
                    if !(at_end
                        && (action == crate::InputAction::Typing
                            || input::known_word_end(inserted, &mut work)))
                    {
                        compacting = true;
                        return false;
                    }
                }
                // retain moves each surviving fixed field after a removed one.
                work += 5 * usize::from(compacting);
                true
            });
        }
        work
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
