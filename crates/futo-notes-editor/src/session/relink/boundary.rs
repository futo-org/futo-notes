//! All targets at one actual history boundary share one canonical candidate.
use super::*;
use crate::history::SourceSelection;
use crate::inline::PendingLinks;

pub(super) struct Side<'a> {
    pub source: SourceSelection,
    pub selection: DisplayRange,
    pub affinity: Affinity,
    pub pending: &'a PendingLinks,
}
impl<'a> Side<'a> {
    pub fn before(entry: &'a HistoryEntry) -> Self {
        Self {
            source: entry.before_source,
            selection: entry.before_selection,
            affinity: entry.before_affinity,
            pending: &entry.before_links,
        }
    }
    pub fn after(entry: &'a HistoryEntry) -> Self {
        Self {
            source: entry.after_source,
            selection: entry.after_selection,
            affinity: entry.after_affinity,
            pending: &entry.after_links,
        }
    }
}
pub(super) struct MappedSide {
    pub source: SourceSelection,
    pub selection: DisplayRange,
    pub pending: PendingLinks,
}
pub(super) struct Boundary {
    pub source: String,
    pub sides: Vec<MappedSide>,
    pub pending: PendingLinks,
    pub edit: SourceEdit,
    pub work: EditWork,
}
impl Boundary {
    pub fn prepare(
        replay: &mut replay::Replay,
        original: &str,
        rewrite: rewrite::Rewrite,
        sides: &[Side<'_>],
    ) -> Result<Self, EditorError> {
        let mut work = rewrite.work;
        let (range, inserted) = difference(original, &rewrite.source, &mut work);
        work.materialized_source_bytes += inserted.len();
        let edit = replay
            .session
            .prepare_source(replay.session.revision(), range, &inserted)?;
        work.materialized_source_bytes += edit.removed.len() + edit.inserted.len();
        let (mut start, mut end) = (range.start.0, range.end.0);
        let mut exact = Vec::with_capacity(sides.len());
        let mut mapped = Vec::with_capacity(sides.len());
        work.link_metadata_items += 2 * usize::from(!sides.is_empty());
        for side in sides {
            replay.restore(side.pending)?;
            start = start.min(side.pending.window.start);
            end = end.max(side.pending.window.end);
            let captured = match side.source {
                SourceSelection::Exact(captured) => captured,
                SourceSelection::Derived => {
                    // This only transports the existing display fallback. The
                    // recorded provenance remains Derived after projection.
                    replay.session.validate_range(side.selection)?;
                    let (capture, visits) = replay
                        .session
                        .projection
                        .source_selection(side.selection, side.affinity);
                    work.link_metadata_items += visits;
                    capture
                }
            };
            for point in [captured.start, captured.end] {
                let (display, visits) = replay.session.projection.try_project_source_point(point);
                work.link_metadata_items += visits + 2;
                if display.is_none() {
                    return Err(EditorError::UnrepresentableFormat);
                }
                start = start.min(point.source.0);
                end = end.max(point.source.0 + point.atom.map_or(0, |atom| atom.source_len));
            }
            let (transported, visits) =
                rewrite.selection(SourceSelection::Exact(captured), side.affinity)?;
            work.link_metadata_items += visits;
            let SourceSelection::Exact(target) = transported else {
                return Err(EditorError::UnrepresentableFormat);
            };
            exact.push(target);
            let mut pending = rewrite.pending(side.pending)?;
            work.link_metadata_items += pending.work;
            pending.work = 0;
            mapped.push(MappedSide {
                source: match side.source {
                    SourceSelection::Exact(_) => transported,
                    SourceSelection::Derived => SourceSelection::Derived,
                },
                selection: DisplayRange::default(),
                pending,
            });
        }
        let before = replay
            .session
            .projection
            .pending_for_source_edit(SourceRange {
                start: SourceOffset(start),
                end: SourceOffset(end),
            });
        work.link_metadata_items += before.work;
        let (mut witnesses, visits) = replay
            .session
            .projection
            .pending_link_witnesses(&before.ranges)?;
        work.link_metadata_items += visits + rewrite.witnesses(&mut witnesses)?;
        let mut pending = rewrite.pending(&before)?;
        work.link_metadata_items += pending.work;
        pending.work = 0;
        let mut projected = Vec::with_capacity(exact.len());
        work.link_metadata_items += usize::from(!exact.is_empty());
        let prepared = replay.session.preview_exact_targets(
            &edit,
            before.window,
            Some(&pending),
            true,
            &[],
            super::super::pending::SelectionTargets {
                selections: &exact,
                links: &witnesses,
                emit: &mut |range| projected.push(range),
            },
        )?;
        charge(&mut work, prepared.work);
        if projected.len() != mapped.len() {
            return Err(EditorError::UnrepresentableFormat);
        }
        for (side, selection) in mapped.iter_mut().zip(projected) {
            work.link_metadata_items += 2;
            side.selection = selection;
        }
        Ok(Self {
            source: rewrite.source,
            sides: mapped,
            pending,
            edit,
            work,
        })
    }

    pub fn side(&self, index: usize, work: &mut EditWork) -> Result<MappedSide, EditorError> {
        let side = self.sides.get(index).ok_or(EditorError::RecoveryMismatch)?;
        work.link_metadata_items += 3
            + 2 * (side.pending.ranges.len() + side.pending.delimiters.len())
            + 5 * (side.pending.guarded_words.len() + side.pending.typed_inputs.len());
        Ok(MappedSide {
            source: side.source,
            selection: side.selection,
            pending: side.pending.clone(),
        })
    }
}

pub(super) fn entry(
    before: &Boundary,
    before_side: usize,
    after: &Boundary,
    after_side: usize,
    first: &HistoryEntry,
    last: &HistoryEntry,
    work: &mut EditWork,
) -> Result<HistoryGroup, EditorError> {
    let a = before.side(before_side, work)?;
    let z = after.side(after_side, work)?;
    let (range, inserted) = difference(&before.source, &after.source, work);
    let removed = before.source[range.start.0..range.end.0].to_owned();
    work.materialized_source_bytes += inserted.len() + removed.len();
    work.link_metadata_items += 1
        + first.before_formats.as_ref().map_or(0, Vec::len)
        + last.after_formats.as_ref().map_or(0, Vec::len);
    Ok(HistoryGroup {
        entries: vec![HistoryEntry {
            before_source: a.source,
            after_source: z.source,
            before_selection: a.selection,
            before_affinity: first.before_affinity,
            before_formats: first.before_formats.clone(),
            before_links: a.pending,
            after_selection: z.selection,
            after_affinity: last.after_affinity,
            after_formats: last.after_formats.clone(),
            after_links: z.pending,
            range,
            removed,
            inserted,
        }],
    })
}
