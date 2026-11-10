//! A staged window is parsed alone; its reference origin keeps link
//! definitions resolving against the real note.
use super::*;
use std::ops::Range;
mod construction;

#[derive(Default)]
pub(super) struct StageContext {
    pub origin: Option<crate::inline::references::SourceOrigin>,
    /// A window of the note, not the note: its inputs are steps of one
    /// outside it (`checked_input`).
    pub staged: bool,
}

impl StageContext {
    pub(super) fn complete_source() -> Self {
        Self::default()
    }
}

pub(super) struct BodyStage {
    pub session: EditorSession,
    pub had_pending: bool,
}

impl EditorSession {
    /// Only an unchanged exact source output may use this physical relocation.
    /// A derived renderer must supply its own correspondence instead.
    pub(super) fn prepare_pending_for_parent(
        &self,
        source_start: usize,
    ) -> crate::inline::PendingLinks {
        let mut pending = self.projection.pending_links(0..self.source.len_bytes());
        pending.work += pending.relocate_source(source_start);
        pending
    }

    pub(super) fn validate_stage_guards(
        &self,
        edit: &SourceEdit,
        window: Range<usize>,
        pending: &crate::inline::PendingLinks,
    ) -> Result<EditWork, EditorError> {
        if !pending.has_words() {
            return Ok(EditWork::default());
        }
        Ok(self
            .preview_pending_edit(edit, window, pending, true, &[])?
            .work)
    }

    pub(super) fn adopt_stage_pending(
        &mut self,
        pending: &crate::inline::PendingLinks,
        change: &mut ViewChange,
    ) {
        change.work.link_metadata_items += pending.work + self.projection.restore_pending(pending);
        let (projection, work) = self
            .projection
            .query_with_work(self.revision, change.projection.range);
        change.projection = projection;
        change.work.link_metadata_items += work.items;
        change.work.link_copied_bytes += work.copied;
    }

    /// `raw` is the exact opening source window, never display coordinates.
    /// Its two outside contexts remain valid as local source changes: every
    /// new read searches the current local rows before consulting either edge.
    /// Nested windows capture through the same interface, so an absent local
    /// witness reaches the true document edge rather than inventing an EOF.
    pub(super) fn stage_source(
        &self,
        raw: &str,
        window: Range<usize>,
    ) -> Result<Self, EditorError> {
        debug_assert_eq!(raw.len(), window.len());
        self.stage_with_context(raw, window, true)
    }

    /// Inline spelling may transform a body before its isolated split. Only
    /// the outside semantic context uses these original source edges. Interior
    /// source/display anchors must use the inline owner's body correspondence;
    /// they must never be copied by an arithmetic window offset.
    pub(super) fn stage_body_source(
        &self,
        body: &crate::inline::BodySource,
        window: Range<usize>,
    ) -> Result<BodyStage, EditorError> {
        if body.revision != self.revision
            || window.start < body.window.start
            || window.end > body.window.end
        {
            return Err(EditorError::UnrepresentableFormat);
        }
        let mut original = self.projection.pending_body(window.clone())?;
        let had_pending = original.has_fields();
        let mut staged = self.stage_with_context(&body.text, window, false)?;
        staged.projection.initial_link_metadata_items += original.work;
        if had_pending {
            if body.guarded_words.is_some() {
                original.guarded_words.clear();
            }
            if body.typed_inputs.is_some() {
                original.typed_inputs.clear();
            }
            let (index, work) = crate::inline::SourceCorrespondence::from_bodies(&body.retained)?;
            let mut pending =
                original.map_copied(0..body.text.len(), |range| index.retained_range(range))?;
            // The original collection has already been charged above.
            pending.work -= original.work;
            if let Some(words) = &body.guarded_words {
                pending.work += 5 * words.len();
                pending.guarded_words = words.clone();
            }
            if let Some(origins) = &body.typed_inputs {
                pending.work += 5 * origins.len();
                pending.typed_inputs = origins.clone();
            }
            let guard_work = staged
                .projection
                .validate_word_origins(&staged.source, &pending)?;
            staged.projection.initial_link_metadata_items += guard_work.link_metadata_items;
            staged.projection.initial_link_copied_bytes += guard_work.materialized_source_bytes;
            staged.projection.initial_link_metadata_items +=
                work + pending.work + staged.projection.restore_pending(&pending);
        }
        Ok(BodyStage {
            session: staged,
            had_pending,
        })
    }
}
