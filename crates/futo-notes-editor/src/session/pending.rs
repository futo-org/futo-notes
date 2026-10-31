//! Validate prepared transient fields against the exact bounded source edit.
use super::*;
use crate::inline::PendingLinks;
use std::ops::Range;

pub(super) struct PendingPreview {
    pub supported: Option<PendingLinks>,
    pub retired: Vec<Range<usize>>,
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
            retired: Vec::new(),
            work: EditWork::default(),
        };
        let activate = !before.ranges.is_empty() && !plan.activated_links.is_empty();
        let guards = plan.guarded_words.is_some() || !before.guarded_words.is_empty();
        if plan.pending_links.is_empty()
            && !activate
            && !guards
            && (input.is_none() || before.ranges.is_empty())
        {
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
                guarded_words: Vec::new(),
                work: 0,
            }
        };
        retained.prepare_guards(before, edit, plan.guarded_words.as_ref())?;
        retained.work += 2 * plan.pending_links.len();
        retained.ranges.extend(plan.pending_links.iter().cloned());
        let mut required = plan.pending_links.clone();
        retained.work += 2 * required.len();
        if activate {
            retained.work += 4 * plan.activated_links.len();
            required.extend(plan.activated_links.iter().cloned());
            retained.ranges.extend(plan.activated_links.iter().cloned());
        }
        let mut prepared = if retained.has_fields() || guards {
            self.preview_pending_edit(edit, before.window.clone(), &retained, false, &required)?
        } else {
            empty()
        };
        prepared.work.link_metadata_items += retained.work;
        if activate {
            prepared.work.link_metadata_items += 2 * plan.activated_links.len();
            prepared.retired = plan.activated_links.clone();
            prepared.retired.sort_unstable_by(|a, b| {
                prepared.work.link_metadata_items += 1;
                (a.start, a.end).cmp(&(b.start, b.end))
            });
            if let Some(fields) = &mut prepared.supported {
                fields.ranges.retain(|field| {
                    prepared.work.link_metadata_items += 1;
                    prepared
                        .retired
                        .binary_search_by(|range| {
                            prepared.work.link_metadata_items += 1;
                            (range.start, range.end).cmp(&(field.start, field.end))
                        })
                        .is_err()
                });
            }
        }
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
        let fields = prepared.supported.as_ref();
        if let Some(fields) = fields {
            change.work.link_metadata_items += self.projection.merge_input_pending(fields);
        }
        change.work.link_metadata_items += self.projection.retire_pending_links(&prepared.retired);
        if refresh_query && (fields.is_some() || !prepared.retired.is_empty()) {
            let (projection, work) = self
                .projection
                .query_with_work(self.revision, change.projection.range);
            change.projection = projection;
            change.work.link_metadata_items += work.items;
            change.work.link_copied_bytes += work.copied;
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
        self.preview_exact_edit(edit, window, Some(pending), require_all, required, None)
            .map(|(preview, _)| preview)
    }

    /// Validate a physical exact output and its transient fields in one bounded
    /// apply. Nothing fallible remains for the real acceptance's installation.
    pub(super) fn preview_exact_edit(
        &self,
        edit: &SourceEdit,
        window: Range<usize>,
        pending: Option<&PendingLinks>,
        require_all: bool,
        required: &[Range<usize>],
        selection: Option<crate::history::ExactSelection>,
    ) -> Result<(PendingPreview, Option<DisplayRange>), EditorError> {
        if edit.range.start.0 < window.start || edit.range.end.0 > window.end {
            return Err(EditorError::UnrepresentableFormat);
        }
        let raw = self.source.byte_slice(window.clone()).to_string();
        let mut staged = self.stage_source(&raw, window.clone())?;
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
        let selected =
            self.preview_exact_selection(&staged, window.clone(), selection, &mut work)?;
        let Some(pending) = pending else {
            return Ok((
                PendingPreview {
                    supported: None,
                    retired: Vec::new(),
                    work,
                },
                selected,
            ));
        };
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
        let guard_work = staged
            .projection
            .validate_guard_words(&staged.source, &local)?;
        work.materialized_source_bytes += guard_work.materialized_source_bytes;
        work.link_metadata_items += guard_work.link_metadata_items;
        work.link_metadata_items += local.work + staged.projection.restore_pending(&local);
        let mut actual = staged.projection.pending_body(local.window.clone())?;
        work.link_metadata_items += actual.work;
        if !local.guarded_words.is_empty() || !actual.guarded_words.is_empty() {
            let (same_guards, guard_visits) = local.same_guards(&actual);
            work.link_metadata_items += guard_visits;
            if !same_guards {
                return Err(EditorError::UnrepresentableFormat);
            }
        }
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
            Ok((
                PendingPreview {
                    supported: None,
                    retired: Vec::new(),
                    work,
                },
                selected,
            ))
        } else {
            // Only canonical whole bare spans supported by the actual candidate
            // survive. Changed URL extents are new fields, not old identities.
            actual.work = 0;
            work.link_metadata_items += actual.relocate_source(window.start);
            Ok((
                PendingPreview {
                    supported: Some(actual),
                    retired: Vec::new(),
                    work,
                },
                selected,
            ))
        }
    }

    fn preview_exact_selection(
        &self,
        staged: &Self,
        window: Range<usize>,
        selection: Option<crate::history::ExactSelection>,
        work: &mut EditWork,
    ) -> Result<Option<DisplayRange>, EditorError> {
        let Some(selection) = selection else {
            return Ok(None);
        };
        work.link_metadata_items += 1;
        if staged.projection.needs_global_references {
            return Err(EditorError::UnrepresentableFormat);
        }
        // This flag is produced only by reference_meaning_changed followed by
        // rebuild_references. Shared resolver allocation is not an eligibility
        // signal. A genuine mutation can change display before the window.
        let canonical = if staged.projection.has_rebuilt_references && window.start != 0 {
            let origin = staged
                .context
                .origin
                .as_ref()
                .ok_or(EditorError::UnrepresentableFormat)?;
            let raw = origin.source.to_string();
            let projection = crate::inline::Projection::new(&raw);
            work.materialized_source_bytes += raw.len();
            work.parsed_source_bytes += projection.initial_parse_work;
            work.link_metadata_items += projection.initial_link_metadata_items;
            work.link_copied_bytes += projection.initial_link_copied_bytes;
            Some((
                projection,
                origin
                    .start
                    .checked_sub(window.start)
                    .ok_or(EditorError::UnrepresentableFormat)?,
            ))
        } else {
            None
        };
        let (prefix, visits) = if let Some((projection, parent_start)) = &canonical {
            projection.display_at_with_work(*parent_start)
        } else {
            self.projection.display_at_with_work(window.start)
        };
        work.link_metadata_items += visits;
        let project = |mut point: crate::history::SourcePoint,
                       work: &mut EditWork|
         -> Result<usize, EditorError> {
            let (offset, visits) = if let Some((projection, parent_start)) = &canonical {
                point.source.0 += parent_start;
                let (offset, visits) = projection.try_project_source_point(point);
                (
                    offset.and_then(|offset| offset.checked_sub(prefix)),
                    visits + 1,
                )
            } else {
                point.source.0 = point
                    .source
                    .0
                    .checked_sub(window.start)
                    .ok_or(EditorError::UnrepresentableFormat)?;
                if point.source.0 > staged.source.len_bytes() {
                    return Err(EditorError::UnrepresentableFormat);
                }
                let (offset, visits) = staged.projection.try_project_source_point(point);
                (offset.map(|offset| prefix + offset), visits + 2)
            };
            work.link_metadata_items += visits;
            offset.ok_or(EditorError::UnrepresentableFormat)
        };
        let start = project(selection.start, work)?;
        let end = project(selection.end, work)?;
        if start > end {
            return Err(EditorError::UnrepresentableFormat);
        }
        Ok(Some(DisplayRange {
            start: DisplayOffset(start),
            end: DisplayOffset(end),
        }))
    }
}
