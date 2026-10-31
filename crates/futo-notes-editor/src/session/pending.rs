//! Validate prepared transient fields against the exact bounded source edit.
use super::*;
use crate::inline::PendingLinks;
use std::ops::Range;

pub(super) struct PendingPreview {
    pub supported: Option<PendingLinks>,
    pub work: EditWork,
}

impl EditorSession {
    /// Every spelling-plan consumer prepares flagged output fields through the
    /// same canonical bounded preview. Input additionally transports surviving
    /// old fields through its exact source correspondence and retirement intent.
    pub(super) fn prepare_plan_pending(
        &self,
        edit: &SourceEdit,
        plan: &crate::inline::Plan,
        before: &PendingLinks,
        input: Option<DisplayRange>,
    ) -> Result<PendingPreview, EditorError> {
        let empty = || PendingPreview {
            supported: None,
            work: EditWork::default(),
        };
        if plan.pending_links.is_empty() && (input.is_none() || before.ranges.is_empty()) {
            return Ok(empty());
        }
        let mut retained = if let Some(input) = input {
            self.projection
                .retained_input_pending(before, edit, &plan.retained, input)?
        } else {
            PendingLinks {
                window: before.after_window(edit),
                ranges: Vec::new(),
                delimiters: Vec::new(),
                work: 0,
            }
        };
        retained.work += 2 * plan.pending_links.len();
        retained.ranges.extend(plan.pending_links.iter().cloned());
        let mut prepared = if retained.has_fields() {
            self.preview_pending_edit(
                edit,
                before.window.clone(),
                &retained,
                false,
                &plan.pending_links,
            )?
        } else {
            empty()
        };
        prepared.work.link_metadata_items += retained.work;
        Ok(prepared)
    }

    /// Install only prevalidated fields before any owning after-history/query.
    /// All consumers share the same infallible metadata and work accounting.
    pub(super) fn install_plan_pending(
        &mut self,
        plan: &mut crate::inline::Plan,
        prepared: PendingPreview,
        change: &mut ViewChange,
        refresh_query: bool,
    ) {
        let EditWork {
            materialized_source_bytes,
            inserted_bytes: _,
            parsed_source_bytes,
            link_metadata_items,
            link_copied_bytes,
        } = prepared.work;
        change.work.materialized_source_bytes += materialized_source_bytes;
        change.work.parsed_source_bytes += parsed_source_bytes;
        change.work.link_metadata_items += link_metadata_items;
        change.work.link_copied_bytes += link_copied_bytes;
        change.work.link_metadata_items += self
            .projection
            .install_delimiters(std::mem::take(&mut plan.delimiters));
        if let Some(fields) = prepared
            .supported
            .as_ref()
            .filter(|fields| fields.has_fields())
        {
            change.work.link_metadata_items += self.projection.merge_input_pending(fields);
            if refresh_query {
                let (projection, work) = self
                    .projection
                    .query_with_work(self.revision, change.projection.range);
                change.projection = projection;
                change.work.link_metadata_items += work.items;
                change.work.link_copied_bytes += work.copied;
            }
        }
    }

    pub(super) fn preview_pending_edit(
        &self,
        edit: &SourceEdit,
        window: Range<usize>,
        pending: &PendingLinks,
        require_all: bool,
        required: &[Range<usize>],
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
        if !required.is_empty() {
            actual.ranges.sort_unstable_by(|a, b| {
                work.link_metadata_items += 1;
                (a.start, a.end).cmp(&(b.start, b.end))
            });
            for range in required {
                work.link_metadata_items += 2;
                let a = range
                    .start
                    .checked_sub(window.start)
                    .ok_or(EditorError::UnrepresentableFormat)?;
                let z = range
                    .end
                    .checked_sub(window.start)
                    .ok_or(EditorError::UnrepresentableFormat)?;
                if actual
                    .ranges
                    .binary_search_by(|found| {
                        work.link_metadata_items += 1;
                        (found.start, found.end).cmp(&(a, z))
                    })
                    .is_err()
                {
                    return Err(EditorError::UnrepresentableFormat);
                }
            }
        }
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
