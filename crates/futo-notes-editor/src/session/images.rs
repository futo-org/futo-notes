//! Image insertion. The shell saves the asset through existing infrastructure
//! and hands back only the stored reference; this module owns the source
//! spelling, the claim check and the single history action. Nothing here reads,
//! writes or decodes image files, and a platform asset URL is never source.
use super::*;
use crate::ImageClaim;
use std::sync::atomic::{AtomicU64, Ordering};

pub(super) fn next_incarnation() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

/// `![alt](reference)` whose parse reads back exactly one image with exactly
/// that destination, or `None`. A reference with spaces or parentheses is
/// written in angle brackets; one that cannot be written safely is refused.
fn image_source(reference: &str, alt: &str) -> Option<String> {
    use pulldown_cmark::{Event, Parser, Tag};
    if !futo_notes_image::is_vault_image_reference(reference)
        || reference.contains(['\n', '\r', '\0', '<', '>', '\\'])
        || alt.contains(['[', ']', '\\', '`', '\n', '\r', '\0'])
    {
        return None;
    }
    let destination = if reference.contains([' ', '\t', '(', ')']) {
        format!("<{reference}>")
    } else {
        reference.to_owned()
    };
    let text = format!("![{alt}]({destination})");
    let mut images = Parser::new(&text).filter_map(|event| match event {
        Event::Start(Tag::Image { dest_url, .. }) => Some(dest_url.into_string()),
        _ => None,
    });
    (images.next().as_deref() == Some(reference) && images.next().is_none()).then_some(text)
}

impl EditorSession {
    /// Begin an asynchronous insertion. Present the claim to `insert_image`;
    /// it stays valid across ordinary edits and expires with this session.
    pub fn image_claim(&self) -> ImageClaim {
        ImageClaim(self.incarnation)
    }

    /// Insert the stored vault image `reference` at the current caret (replacing
    /// a selection) as one isolated accepted edit, leaving the caret after the
    /// image. A claim issued for another session (another note, or this note
    /// reopened) is `StaleClaim`; an unwritable reference or alt is
    /// `InvalidText`. Inside code nothing is inserted (`None`).
    pub fn insert_image(
        &mut self,
        expected: Revision,
        claim: ImageClaim,
        reference: &str,
        alt: &str,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.check_revision(expected)?;
        if claim != self.image_claim() {
            return Err(EditorError::StaleClaim);
        }
        on_next!(self, accept, |e, accept| e
            .insert_image(expected, reference, alt, accept));
        if self.composition().is_some() {
            return Err(EditorError::CompositionActive);
        }
        let text = image_source(reference, alt).ok_or(EditorError::InvalidText)?;
        let selection = self.selection;
        let (start, end) = if selection.start == selection.end {
            let (low, high) = self.projection.source_bounds(selection.start.0);
            let at = if self.affinity == Affinity::Forward {
                high
            } else {
                low
            };
            (at, at)
        } else {
            let start = self.projection.source_bounds(selection.start.0).1;
            (
                start,
                self.projection.source_bounds(selection.end.0).0.max(start),
            )
        };
        if self
            .projection
            .block_lines(selection)
            .iter()
            .any(|line| line.code)
            || self
                .projection
                .formats_at(start)
                .contains(&InlineFormat::Code)
        {
            return Ok(None);
        }
        // Exact source, not typed text: markup in the alt or destination must
        // not be literalized. One accepted record, one history action.
        let edit = self.prepare_source(
            expected,
            SourceRange {
                start: SourceOffset(start),
                end: SourceOffset(end),
            },
            &text,
        )?;
        accept(&edit).map_err(EditorError::Persistence)?;
        let before_selection = self.selection;
        let (before_source, before_source_work) = self.capture_history_selection();
        let before_affinity = self.affinity;
        let before_formats = self.pending_formats.clone();
        let before_links = self.projection.pending_for_source_edit(edit.range);
        let mut change = self.apply(&edit);
        let (at, caret_work) = self.projection.display_at_with_work(start + text.len());
        self.selection = DisplayRange {
            start: DisplayOffset(at),
            end: DisplayOffset(at),
        };
        self.pending_formats = None;
        change.selection = self.selection;
        change.affinity = self.affinity;
        change.work.materialized_source_bytes += edit.inserted.len();
        let (after_source, after_source_work) = self.capture_history_selection();
        let after_links = self
            .projection
            .pending_links(before_links.after_window(&edit));
        change.work.link_metadata_items += before_source_work
            + after_source_work
            + caret_work
            + before_links.work
            + after_links.work;
        self.record_input_history(
            HistoryEntry {
                before_source,
                after_source,
                before_selection,
                before_affinity,
                before_formats,
                before_links,
                after_selection: self.selection,
                after_affinity: self.affinity,
                after_formats: None,
                after_links,
                range: edit.range,
                removed: edit.removed,
                inserted: edit.inserted,
            },
            None,
        );
        self.typing = None;
        Ok(Some(change))
    }
}
