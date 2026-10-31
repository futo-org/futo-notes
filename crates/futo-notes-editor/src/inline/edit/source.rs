//! Verify already-owned source/input pieces against rendered physical ranges.
//! Equality validates lineage; it never searches for or discovers identities.
use super::super::spelling::PieceOrigin;
use crate::history::SourcePoint;
use std::ops::Range;

type Ranges = Vec<(Range<usize>, Range<usize>)>;
#[derive(Default)]
pub(crate) struct SourceCorrespondence {
    retained: Ranges,
    inserted: Ranges,
    retired_word: Option<Range<usize>>,
}
fn append(ranges: &mut Ranges, old: Range<usize>, new: Range<usize>, work: &mut usize) {
    *work += 1;
    if let Some((last_old, last_new)) = ranges.last_mut() {
        if last_old.end == old.start && last_new.end == new.start {
            last_old.end = old.end;
            last_new.end = new.end;
            return;
        }
    }
    ranges.push((old, new));
}
impl SourceCorrespondence {
    pub(super) fn verify(
        raw: &str,
        inserted: &str,
        output: &str,
        origins: Vec<(PieceOrigin, Range<usize>)>,
        base: usize,
    ) -> (Self, usize) {
        let mut result = Self::default();
        let mut work = 0;
        for (origin, new) in origins {
            work += 1;
            let (old, original, source) = match origin {
                PieceOrigin::Source(range) => (range, raw, true),
                PieceOrigin::Inserted(range) => (range, inserted, false),
            };
            let (Some(before), Some(after)) = (original.get(old.clone()), output.get(new.clone()))
            else {
                continue;
            };
            if before.len() != after.len() {
                continue;
            }
            if !before.bytes().zip(after.bytes()).all(|(a, b)| {
                work += 1;
                a == b
            }) {
                continue;
            }
            work += 2;
            let new = base + new.start..base + new.end;
            if source {
                work += 2;
                append(
                    &mut result.retained,
                    base + old.start..base + old.end,
                    new,
                    &mut work,
                );
            } else {
                append(&mut result.inserted, old, new, &mut work);
            }
        }
        (result, work)
    }

    pub(crate) fn retire_word(&mut self, range: Range<usize>) -> usize {
        self.retired_word = Some(range);
        3
    }
    pub(crate) fn word_was_retired(&self, range: &Range<usize>) -> (bool, usize) {
        (
            self.retired_word
                .as_ref()
                .is_some_and(|word| word.start <= range.start && range.end <= word.end),
            1,
        )
    }

    pub(crate) fn map(&self, mut point: SourcePoint) -> (Option<SourcePoint>, usize) {
        let (mapped, work) = map(
            &self.retained,
            point.source.0,
            point.atom.map_or(0, |atom| atom.source_len),
        );
        if let Some(source) = mapped {
            point.source.0 = source;
            (Some(point), work)
        } else {
            (None, work)
        }
    }
    pub(crate) fn from_bodies(
        bodies: &[crate::inline::references::RetainedBody],
    ) -> Result<(Self, usize), crate::EditorError> {
        let (ordered, mut work) = crate::inline::references::RetainedBody::ordered(bodies);
        if !ordered {
            return Err(crate::EditorError::UnrepresentableFormat);
        }
        let mut result = Self::default();
        for body in bodies {
            work += 5;
            append(
                &mut result.retained,
                body.before.clone(),
                body.after.clone(),
                &mut work,
            );
        }
        Ok((result, work))
    }

    pub(crate) fn retained_range(&self, range: Range<usize>) -> (Option<Range<usize>>, usize) {
        let (start, work) = map(&self.retained, range.start, range.len());
        (start.map(|start| start..start + range.len()), work)
    }
    pub(crate) fn map_inserted(&self, offset: usize) -> (Option<usize>, usize) {
        map(&self.inserted, offset, 0)
    }
}
fn map(ranges: &Ranges, offset: usize, extent: usize) -> (Option<usize>, usize) {
    let mut work = 0;
    let first = ranges.partition_point(|(old, _)| {
        work += 1;
        old.end < offset
    });
    for (old, new) in &ranges[first..] {
        work += 1;
        if old.start > offset {
            break;
        }
        if offset <= old.end && offset + extent <= old.end {
            return (Some(new.start + offset - old.start), work);
        }
    }
    (None, work)
}
