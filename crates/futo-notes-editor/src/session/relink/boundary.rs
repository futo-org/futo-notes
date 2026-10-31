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
        mut rewrite: rewrite::Rewrite,
        sides: &[Side<'_>],
        identities: &mut transformed::Identities,
    ) -> Result<Self, EditorError> {
        let mut work = rewrite.work;
        let (range, inserted) = difference(original, &rewrite.source, &mut work);
        work.materialized_source_bytes += inserted.len();
        let (mut start, mut end) = (range.start.0, range.end.0);
        let mut exact = Vec::with_capacity(sides.len());
        let mut mapped_sources = Vec::with_capacity(sides.len());
        let mut fields = Vec::with_capacity(sides.len() + 1);
        work.link_metadata_items += 2 * usize::from(!sides.is_empty()) + 1;
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
            let (witnesses, visits) = replay
                .session
                .projection
                .pending_link_witnesses(&side.pending.ranges)?;
            work.link_metadata_items += visits;
            let mut prepared = rewrite.fields(side.pending, witnesses)?;
            charge(
                &mut work,
                prepared.validate_original(&replay.session, side.pending)?,
            );
            work.link_metadata_items += rewrite.code_witnesses(&mut prepared.codes)?;
            work.link_metadata_items += prepared.pending.work;
            prepared.pending.work = 0;
            fields.push(prepared);
            mapped_sources.push(match side.source {
                SourceSelection::Exact(_) => transported,
                SourceSelection::Derived => SourceSelection::Derived,
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
        let (witnesses, visits) = replay
            .session
            .projection
            .pending_link_witnesses(&before.ranges)?;
        work.link_metadata_items += visits;
        let mut aggregate = rewrite.fields(&before, witnesses)?;
        charge(
            &mut work,
            aggregate.validate_original(&replay.session, &before)?,
        );
        work.link_metadata_items += rewrite.code_witnesses(&mut aggregate.codes)?;
        work.link_metadata_items += aggregate.pending.work;
        aggregate.pending.work = 0;
        fields.push(aggregate);
        let points: Vec<_> = exact
            .iter()
            .flat_map(|selection| [selection.start, selection.end])
            .collect();
        charge(
            &mut work,
            rewrite.spell_pending_literals(&replay.session, &mut fields, &points)?,
        );
        for (index, selected) in exact.iter_mut().enumerate() {
            let (start, a) = rewrite.spelling_point(selected.start)?;
            let (end, z) = rewrite.spelling_point(selected.end)?;
            selected.start = start;
            selected.end = end;
            work.link_metadata_items += a + z;
            if matches!(mapped_sources[index], SourceSelection::Exact(_)) {
                mapped_sources[index] = SourceSelection::Exact(*selected);
            }
        }
        let (range, inserted) = if rewrite.has_spelling() {
            let pair = difference(original, &rewrite.source, &mut work);
            work.materialized_source_bytes += pair.1.len();
            pair
        } else {
            (range, inserted)
        };
        let edit = replay
            .session
            .prepare_source(replay.session.revision(), range, &inserted)?;
        work.materialized_source_bytes += edit.removed.len() + edit.inserted.len();
        let mut projected = Vec::with_capacity(exact.len());
        work.link_metadata_items += usize::from(!exact.is_empty());
        let (_, initial) =
            replay
                .session
                .with_exact_candidate(&edit, before.window.clone(), |staged| {
                    // Resolve EVERY payload against this candidate before restoring any
                    // transient suppression. The canonical spans/Code coverage own proof.
                    work.link_metadata_items +=
                        rewrite.validate_spelling(staged, before.window.start)?;
                    for prepared in &mut fields {
                        charge(
                            &mut work,
                            prepared.prepare_candidate(
                                staged,
                                before.window.start,
                                identities,
                                &rewrite.source,
                            )?,
                        );
                    }
                    for (index, prepared) in fields.iter().enumerate() {
                        let targets = if index < exact.len() {
                            &exact[index..index + 1]
                        } else {
                            &[]
                        };
                        let checked = replay.session.validate_exact_candidate(
                            staged,
                            before.window.clone(),
                            Some(&prepared.pending),
                            true,
                            &[],
                            super::super::pending::SelectionTargets {
                                selections: targets,
                                links: &prepared.witnesses,
                                emit: &mut |range| projected.push(range),
                            },
                        )?;
                        charge(&mut work, checked.work);
                    }
                    Ok(())
                })?;
        charge(&mut work, initial);
        if projected.len() != mapped_sources.len() {
            return Err(EditorError::UnrepresentableFormat);
        }
        let pending = fields
            .pop()
            .ok_or(EditorError::UnrepresentableFormat)?
            .pending;
        let mut mapped = Vec::with_capacity(fields.len());
        work.link_metadata_items += usize::from(!fields.is_empty());
        for ((source, selection), prepared) in mapped_sources.into_iter().zip(projected).zip(fields)
        {
            work.link_metadata_items += 3;
            mapped.push(MappedSide {
                source,
                selection,
                pending: prepared.pending,
            });
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
