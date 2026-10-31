//! Validate prepared transient fields against the exact bounded source edit.
use super::*;
use crate::inline::PendingLinks;
use std::ops::Range;

pub(super) struct PendingPreview {
    pub supported: Option<PendingLinks>,
    pub work: EditWork,
}

impl EditorSession {
    pub(super) fn preview_pending_edit(
        &self,
        edit: &SourceEdit,
        window: Range<usize>,
        pending: &PendingLinks,
        require_all: bool,
    ) -> Result<PendingPreview, EditorError> {
        if edit.range.start.0 < window.start || edit.range.end.0 > window.end {
            return Err(EditorError::UnrepresentableFormat);
        }
        let raw = self.source.byte_slice(window.clone()).to_string();
        let mut staged = self.stage_source(&raw, window.clone());
        let local_edit = staged.prepare_source(
            staged.revision(),
            SourceRange {
                start: SourceOffset(edit.range.start.0 - window.start),
                end: SourceOffset(edit.range.end.0 - window.start),
            },
            &edit.inserted,
        )?;
        // Apply the already prepared record, never a command, callback, clock
        // or history action. The canonical exact origin sees this same edit.
        let mut work = staged.apply(&local_edit).work;
        work.inserted_bytes = 0; // Planning is not another accepted insertion.
        work.materialized_source_bytes += raw.len() + edit.inserted.len();
        work.parsed_source_bytes += staged.projection.initial_parse_work;
        work.link_metadata_items += staged.projection.initial_link_metadata_items;
        work.link_copied_bytes += staged.projection.initial_link_copied_bytes;
        let start = pending
            .window
            .start
            .checked_sub(window.start)
            .ok_or(EditorError::UnrepresentableFormat)?;
        let end = pending
            .window
            .end
            .checked_sub(window.start)
            .ok_or(EditorError::UnrepresentableFormat)?;
        if end > staged.source.len_bytes() {
            return Err(EditorError::UnrepresentableFormat);
        }
        let mut local = pending.map_copied(start..end, |range| {
            (
                range
                    .start
                    .checked_sub(window.start)
                    .zip(range.end.checked_sub(window.start))
                    .map(|(a, z)| a..z),
                2,
            )
        })?;
        local.work -= pending.work;
        work.link_metadata_items += local.work + staged.projection.restore_pending(&local);
        let mut actual = staged.projection.pending_body(local.window.clone())?;
        work.link_metadata_items += actual.work;
        if require_all {
            for (wanted, found) in [
                (&mut local.ranges, &mut actual.ranges),
                (&mut local.delimiters, &mut actual.delimiters),
            ] {
                wanted.sort_unstable_by(|a, b| {
                    work.link_metadata_items += 1;
                    (a.start, a.end).cmp(&(b.start, b.end))
                });
                found.sort_unstable_by(|a, b| {
                    work.link_metadata_items += 1;
                    (a.start, a.end).cmp(&(b.start, b.end))
                });
                if wanted.len() != found.len()
                    || !wanted.iter().zip(found.iter()).all(|(a, b)| {
                        work.link_metadata_items += 1;
                        a == b
                    })
                {
                    return Err(EditorError::UnrepresentableFormat);
                }
            }
            Ok(PendingPreview {
                supported: None,
                work,
            })
        } else {
            // Only canonical whole bare spans supported by the actual candidate
            // survive. Changed URL extents are new fields, not old identities.
            actual.work = 0;
            work.link_metadata_items += actual.relocate_source(window.start);
            Ok(PendingPreview {
                supported: Some(actual),
                work,
            })
        }
    }
}
