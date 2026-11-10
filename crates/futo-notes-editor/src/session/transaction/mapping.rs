//! Per-input display/source correspondence with exact step generation.
mod protected;
use crate::session::EditorSession;
use crate::{
    DisplayRange, EditorError, Revision, SourceEdit, SourceOffset, SourceRange, ViewChange,
};
use protected::Protected;
pub(in crate::session) use protected::SourceStep;

/// Sequential display replacements produced by one input. A structural boundary
/// is staged before the ordinary input; retain both locations instead of
/// reconstructing their identities from the combined source/display envelope.
pub(in crate::session) struct InputMapping {
    input: (DisplayRange, usize),
    boundary: Option<(DisplayRange, usize)>,
    source: Option<InputSource>,
    protected: Option<Protected>,
    pub(super) requires_source_identity: bool,
    inserted_display: Option<DisplayRange>,
    retired_guard: Option<std::sync::Arc<crate::inline::guarded_words::CodeWordIdentity>>,
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
            protected: None,
            source: None,
            requires_source_identity: false,
            inserted_display: None,
            retired_guard: None,
        }
    }

    pub fn from_source(
        range: DisplayRange,
        inserted: usize,
        edit: &SourceEdit,
        retained: crate::inline::SourceCorrespondence,
        requires_source_identity: bool,
        inserted_display: DisplayRange,
        retired_guard: Option<std::sync::Arc<crate::inline::guarded_words::CodeWordIdentity>>,
    ) -> Self {
        Self {
            input: (range, inserted),
            boundary: None,
            protected: None,
            source: Some(InputSource {
                revision: edit.previous_revision,
                range: edit.range,
                inserted: edit.inserted.len(),
                retained,
            }),
            requires_source_identity,
            inserted_display: Some(inserted_display),
            retired_guard,
        }
    }

    pub(in crate::session) fn transfer_guard_retirement(
        &self,
        revision: Revision,
        range: SourceRange,
        inserted: usize,
        inventories: Vec<crate::inline::guarded_words::SplitInventory>,
    ) -> Result<(Vec<crate::inline::guarded_words::ValidationAtom>, usize), EditorError> {
        let Some(identity) = &self.retired_guard else {
            return Ok((Vec::new(), 0));
        };
        let source = self
            .source_at(revision, range, inserted)
            .ok_or(EditorError::UnrepresentableFormat)?;
        if self.protected.is_some() {
            return Err(EditorError::UnrepresentableFormat);
        }
        let mut work = 0;
        let mut found = None;
        for inventory in inventories {
            work += 1;
            if std::sync::Arc::ptr_eq(identity, &inventory.identity) {
                if found.is_some() {
                    return Err(EditorError::UnrepresentableFormat);
                }
                found = Some(inventory.atoms);
            }
        }
        let mut atoms = found.ok_or(EditorError::UnrepresentableFormat)?;
        for atom in &mut atoms {
            let (after, visits) = source.retained.retained_range(atom.source.clone());
            work += visits + 2;
            atom.source = after.ok_or(EditorError::UnrepresentableFormat)?;
        }
        Ok((atoms, work))
    }

    pub(super) fn retained_source(
        &self,
        revision: Revision,
        range: SourceRange,
        inserted: usize,
        point: crate::history::SourcePoint,
    ) -> (Option<crate::history::SourcePoint>, usize) {
        if let Some(path) = &self.protected {
            return path.retained(
                self.source.as_ref().unwrap(),
                revision,
                range,
                inserted,
                point,
            );
        }
        if let Some(source) = self.source_at(revision, range, inserted) {
            source.retained.map(point)
        } else {
            (None, 1)
        }
    }

    pub(in crate::session) fn inserted_source_range(
        &self,
        revision: Revision,
        range: SourceRange,
        inserted: usize,
        input: std::ops::Range<usize>,
    ) -> Result<(std::ops::Range<usize>, usize), EditorError> {
        if input.start > input.end || input.end > self.input.1 {
            return Err(EditorError::UnrepresentableFormat);
        }
        let source = self
            .source_at(revision, range, inserted)
            .ok_or(EditorError::UnrepresentableFormat)?;
        let (mapped, work) = source.retained.inserted_range(input);
        let mut mapped = mapped.ok_or(EditorError::UnrepresentableFormat)?;
        let relocation = self.protected.as_ref().map_or(0, |path| path.window.start);
        mapped.start += relocation;
        mapped.end += relocation;
        Ok((mapped, work + 3))
    }

    pub(in crate::session) fn transfer_body(
        &self,
        revision: Revision,
        range: SourceRange,
        inserted: usize,
        bodies: Vec<crate::inline::references::RetainedBody>,
    ) -> Result<(Vec<crate::inline::references::RetainedBody>, usize), EditorError> {
        let source = self
            .source_at(revision, range, inserted)
            .ok_or(EditorError::UnrepresentableFormat)?;
        let mut result = Vec::new();
        let mut work = 1;
        for body in bodies {
            work += 1;
            let (after, visits) = if let Some(path) = &self.protected {
                path.retained_range(source, body.after)
            } else {
                source.retained.retained_range(body.after)
            };
            work += visits;
            if let Some(after) = after {
                // The whole parser-owned atom survived this exact source step.
                result.push(crate::inline::references::RetainedBody {
                    before: body.before,
                    after,
                });
            }
        }
        let (ordered, visits) = crate::inline::references::RetainedBody::ordered(&result);
        work += visits;
        if !ordered {
            return Err(EditorError::UnrepresentableFormat);
        }
        Ok((result, work))
    }

    pub(super) fn inserted_target(
        &self,
        within: usize,
        typed: &str,
        staged: &EditorSession,
    ) -> Result<(usize, usize), EditorError> {
        // A structural boundary (typing after a thematic break opens a new line)
        // prefixes the change, so `within` counts from the typed text, which ends
        // the change.
        let lead = self.input.1.checked_sub(typed.len());
        if let Some(source) = self.source.as_ref().filter(|source| {
            self.protected.as_ref().map_or(
                source.revision.0.checked_add(1) == Some(staged.revision().0),
                |path| path.outer.revision.0.checked_add(1) == Some(staged.revision().0),
            )
        }) {
            let (mapped, mut work) = source.retained.map_inserted(within);
            if let Some(offset) = mapped {
                let point = crate::history::SourcePoint {
                    source: SourceOffset(
                        offset + self.protected.as_ref().map_or(0, |path| path.window.start),
                    ),
                    within: 0,
                    atom: None,
                };
                let (display, visits) = staged.projection.try_project_source_point(point);
                work += visits;
                if let Some(display) = display {
                    return Ok((display, work));
                }
                if self.requires_source_identity || self.protected.is_some() {
                    return Err(EditorError::UnrepresentableFormat);
                }
            }
            if self.requires_source_identity || self.protected.is_some() {
                return Err(EditorError::UnrepresentableFormat);
            }
            if let Some(display) = self.inserted_display.filter(|_| self.protected.is_none()) {
                // Literal spelling already verified the exact inserted glyphs.
                if display.end.0 - display.start.0 == self.input.1 {
                    let at =
                        display.start.0 + lead.ok_or(EditorError::UnrepresentableFormat)? + within;
                    return Ok((at, work));
                }
            }
            return Err(EditorError::UnrepresentableFormat);
        }
        if self.requires_source_identity || self.protected.is_some() {
            return Err(EditorError::UnrepresentableFormat);
        }
        let start = staged
            .selection
            .end
            .0
            .checked_sub(self.input.1)
            .ok_or(EditorError::UnrepresentableFormat)?;
        let lead = lead.ok_or(EditorError::UnrepresentableFormat)?;
        let at = start + lead + within;
        // The typed text must be what sits there, and the target a character edge:
        // otherwise the source cannot be located, so the input is refused.
        let shown = &staged.projection.display;
        if lead != 0
            && (!typed.is_char_boundary(within)
                || shown
                    .get_byte_slice(start + lead..start + self.input.1)
                    .is_none_or(|run| run != typed))
        {
            return Err(EditorError::UnrepresentableFormat);
        }
        Ok((at, 1))
    }

    fn source_at(
        &self,
        revision: Revision,
        range: SourceRange,
        inserted: usize,
    ) -> Option<&InputSource> {
        self.source.as_ref().filter(|source| {
            self.protected.as_ref().map_or(
                source.revision == revision && source.range == range && source.inserted == inserted,
                |path| path.outer.matches(revision, range, inserted),
            )
        })
    }

    pub(in crate::session) fn protect(
        mut self,
        outer: &SourceEdit,
        steps: [Option<SourceStep>; 2],
        count: usize,
        window: std::ops::Range<usize>,
        display_window: std::ops::Range<usize>,
    ) -> Result<Self, EditorError> {
        if let Some(source) = &self.source {
            if count != 2 {
                return Err(EditorError::UnrepresentableFormat);
            }
            let boundary = steps[0].ok_or(EditorError::UnrepresentableFormat)?;
            let input = steps[1].ok_or(EditorError::UnrepresentableFormat)?;
            if boundary.revision != Revision(0)
                || boundary.range.start != boundary.range.end
                || boundary.revision.0 + 1 != input.revision.0
                || !input.matches(source.revision, source.range, source.inserted)
            {
                return Err(EditorError::UnrepresentableFormat);
            }
            self.protected = Some(Protected {
                outer: SourceStep::read(outer),
                boundary,
                window,
                display_window,
            });
        }
        Ok(self)
    }

    pub(super) fn requires_source_at_display(
        &self,
        display: usize,
        origin: usize,
    ) -> (bool, usize) {
        let mut work = 1;
        if self.requires_source_identity {
            return (true, work);
        }
        work += 1;
        let Some(path) = &self.protected else {
            return (false, work);
        };
        work += 1;
        let Some(display) = display.checked_sub(origin) else {
            return (false, work);
        };
        work += 1;
        if display < path.display_window.start {
            return (false, work);
        }
        (display <= path.display_window.end, work + 1)
    }

    pub(in crate::session) fn with_source_boundary(mut self, change: &ViewChange) -> Self {
        self.boundary = Some((change.range, change.inserted.len()));
        self
    }

    pub(in crate::session) fn relocate_display(&mut self, origin: usize) {
        for (range, _) in self
            .boundary
            .iter_mut()
            .chain(std::iter::once(&mut self.input))
        {
            range.start.0 += origin;
            range.end.0 += origin;
        }
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
