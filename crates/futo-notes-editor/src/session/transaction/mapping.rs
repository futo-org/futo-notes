//! Per-input display/source correspondence with exact step generation.
use crate::{DisplayRange, EditorError, Revision, SourceEdit, SourceRange};

/// Sequential display replacements produced by one input. A structural boundary
/// is staged before the ordinary input; retain both locations instead of
/// reconstructing their identities from the combined source/display envelope.
pub(in crate::session) struct InputMapping {
    input: (DisplayRange, usize),
    boundary: Option<(DisplayRange, usize)>,
    source: Option<InputSource>,
    pub(super) requires_source_identity: bool,
    inserted_display: Option<DisplayRange>,
}
struct InputSource {
    revision: Revision,
    range: SourceRange,
    inserted: usize,
    retained: crate::inline::SourceCorrespondence,
}

impl InputMapping {
    pub fn new(range: DisplayRange, inserted: usize) -> Self {
        Self {
            input: (range, inserted),
            boundary: None,
            source: None,
            requires_source_identity: false,
            inserted_display: None,
        }
    }

    pub fn from_source(
        range: DisplayRange,
        inserted: usize,
        edit: &SourceEdit,
        retained: crate::inline::SourceCorrespondence,
        requires_source_identity: bool,
        inserted_display: DisplayRange,
    ) -> Self {
        Self {
            input: (range, inserted),
            boundary: None,
            source: Some(InputSource {
                revision: edit.previous_revision,
                range: edit.range,
                inserted: edit.inserted.len(),
                retained,
            }),
            requires_source_identity,
            inserted_display: Some(inserted_display),
        }
    }

    pub(super) fn retained_source(
        &self,
        revision: Revision,
        range: SourceRange,
        inserted: usize,
        point: crate::history::SourcePoint,
    ) -> (Option<crate::history::SourcePoint>, usize) {
        if let Some(source) = self.source.as_ref().filter(|source| {
            source.revision == revision && source.range == range && source.inserted == inserted
        }) {
            source.retained.map(point)
        } else {
            (None, 1)
        }
    }

    pub(super) fn inserted_target(&self, within: usize, end: usize) -> Result<usize, EditorError> {
        if let Some(display) = self.inserted_display {
            if display.end.0 - display.start.0 == self.input.1 {
                return Ok(display.start.0 + within);
            }
            if within == 0 {
                return Ok(display.start.0);
            }
            if within == self.input.1 {
                return Ok(display.end.0);
            }
            return Err(EditorError::UnrepresentableFormat);
        }
        end.checked_sub(self.input.1)
            .map(|start| start + within)
            .ok_or(EditorError::UnrepresentableFormat)
    }

    pub fn with_boundary(mut self, change: &ViewChange, origin: usize) -> Self {
        // Display origin alone cannot translate a source table through an
        // earlier structural source generation. Preserve explicit rejection
        // for a rewritten identity until that step supplies correspondence.
        self.source = None;
        self.inserted_display = None;
        self.boundary = Some((change.range, change.inserted.len()));
        for (range, _) in self
            .boundary
            .iter_mut()
            .chain(std::iter::once(&mut self.input))
        {
            range.start.0 += origin;
            range.end.0 += origin;
        }
        self
    }

    pub fn map(&self, mut offset: usize, origin: usize) -> Result<usize, EditorError> {
        for (range, inserted) in self.boundary.iter().chain(std::iter::once(&self.input)) {
            if offset >= origin + range.end.0 {
                offset = offset - (range.end.0 - range.start.0) + inserted;
            } else if offset > origin + range.start.0 {
                return Err(EditorError::UnrepresentableFormat);
            }
        }
        Ok(offset)
    }
}

