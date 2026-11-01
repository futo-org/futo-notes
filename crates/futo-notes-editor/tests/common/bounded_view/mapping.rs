use std::collections::BTreeMap;

use futo_notes_editor::*;

use super::{range, shifted, valid_range, width, BoundedView};

impl BoundedView {
    pub fn source_at(&self, at: DisplayOffset, affinity: Affinity) -> SourceOffset {
        assert!(self.text.is_char_boundary(at.0));
        let points = self
            .boundaries
            .get(&at.0)
            .expect("every display boundary has an explicit witness");
        SourceOffset(match affinity {
            Affinity::Backward => *points.iter().min().unwrap(),
            Affinity::Forward => *points.iter().max().unwrap(),
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn apply_meaning(
        &mut self,
        previous: BoundedCursor,
        cursor: BoundedCursor,
        changed: DisplayRange,
        inserted: &str,
        selection: DisplayRange,
        affinity: Affinity,
        source_change: Option<BoundedSourceChange>,
        footprint: SourceRange,
        meaning: &BoundedMeaning,
        continuation: Option<ProjectionContinuation>,
        physical_bounds: bool,
    ) {
        self.advance(previous, cursor, source_change.is_some(), continuation);
        valid_range(&self.text, changed);
        let delta = inserted.len() as isize - width(changed) as isize;
        let old_meaning = range(meaning.range.start.0, shifted(meaning.range.end.0, -delta));
        valid_range(&self.text, old_meaning);
        assert!(old_meaning.start.0 <= changed.start.0 && changed.end.0 <= old_meaning.end.0);
        if let Some(edit) = source_change {
            assert!(edit.range.start.0 <= edit.range.end.0 && edit.range.end.0 <= self.source_len);
            self.source_len = shifted(self.source_len, source_delta(edit));
            self.expected_fence_owner = SourceOffset(
                rebase_source(self.expected_fence_owner.0, edit)
                    .expect("the fixture's retained fence opener cannot be deleted"),
            );
            for block in &mut self.blocks {
                block.source_owner = block.source_owner.map(|owner| {
                    SourceOffset(rebase_source(owner.0, edit).expect(
                        "a retained block owner cannot be deleted outside replacement meaning",
                    ))
                });
            }
        }
        assert!(footprint.start.0 <= footprint.end.0 && footprint.end.0 <= self.source_len);
        let mut retained: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
        for (display, points) in std::mem::take(&mut self.boundaries) {
            for point in points {
                let Some(source) =
                    source_change.map_or(Some(point), |edit| rebase_source(point, edit))
                else {
                    continue;
                };
                if footprint.start.0 <= source
                    && source <= footprint.end.0
                    && old_meaning.start.0 <= display
                    && display <= old_meaning.end.0
                {
                    continue;
                }
                let at = if display < old_meaning.start.0 {
                    display
                } else if display > old_meaning.end.0 {
                    shifted(display, delta)
                } else if source < footprint.start.0 {
                    assert_eq!(
                        display, old_meaning.start.0,
                        "replacement would split retained provenance"
                    );
                    meaning.range.start.0
                } else if source > footprint.end.0 {
                    assert_eq!(
                        display, old_meaning.end.0,
                        "replacement would split retained provenance"
                    );
                    meaning.range.end.0
                } else {
                    unreachable!()
                };
                retained.entry(at).or_default().push(source);
            }
        }
        self.boundaries = retained;
        self.text
            .replace_range(changed.start.0..changed.end.0, inserted);
        valid_range(&self.text, meaning.range);
        assert_eq!(
            &self.text[meaning.range.start.0..meaning.range.end.0],
            meaning.text
        );
        self.replace_records(old_meaning, meaning.range, delta, meaning, physical_bounds);
        for mapped in &meaning.mapping {
            valid_range(&self.text, mapped.display);
            assert!(
                meaning.range.start.0 <= mapped.display.start.0
                    && mapped.display.end.0 <= meaning.range.end.0
            );
            assert!(
                footprint.start.0 <= mapped.source.start.0
                    && mapped.source.start.0 <= mapped.source.end.0
                    && mapped.source.end.0 <= footprint.end.0
            );
            match mapped.kind {
                BoundedMapKind::Hidden => {
                    assert_eq!(mapped.display.start, mapped.display.end);
                    self.boundaries
                        .entry(mapped.display.start.0)
                        .or_default()
                        .extend([mapped.source.start.0, mapped.source.end.0]);
                }
                BoundedMapKind::Literal | BoundedMapKind::Atom => {
                    if mapped.kind == BoundedMapKind::Atom {
                        assert!(mapped.display.start.0 < mapped.display.end.0);
                    }
                    if mapped.kind == BoundedMapKind::Literal {
                        assert_eq!(
                            width(mapped.display),
                            mapped.source.end.0 - mapped.source.start.0
                        );
                    }
                    let offsets: Vec<_> = boundary_offsets(&self.text)
                        .filter(|at| mapped.display.start.0 <= *at && *at <= mapped.display.end.0)
                        .collect();
                    for at in offsets {
                        let points = self.boundaries.entry(at).or_default();
                        if at == mapped.display.start.0 {
                            points.push(mapped.source.start.0);
                        } else if at == mapped.display.end.0 {
                            points.push(mapped.source.end.0);
                        } else if mapped.kind == BoundedMapKind::Literal {
                            points.push(mapped.source.start.0 + at - mapped.display.start.0);
                        } else {
                            points.extend([mapped.source.start.0, mapped.source.end.0]);
                        }
                    }
                }
            }
        }
        for at in boundary_offsets(&self.text) {
            let points = self
                .boundaries
                .get(&at)
                .expect("frame omitted a display boundary map");
            assert!(!points.is_empty() && points.iter().all(|point| *point <= self.source_len));
        }
        self.select(selection, affinity);
    }
}

pub(super) fn boundary_offsets(text: &str) -> impl Iterator<Item = usize> + '_ {
    text.char_indices()
        .map(|(at, _)| at)
        .chain(std::iter::once(text.len()))
}
fn source_delta(edit: BoundedSourceChange) -> isize {
    edit.inserted_bytes as isize - (edit.range.end.0 - edit.range.start.0) as isize
}
fn rebase_source(point: usize, edit: BoundedSourceChange) -> Option<usize> {
    if point <= edit.range.start.0 {
        Some(point)
    } else if point >= edit.range.end.0 {
        Some(shifted(point, source_delta(edit)))
    } else {
        None
    } // Deleted provenance has no invented/clamped source answer.
}
