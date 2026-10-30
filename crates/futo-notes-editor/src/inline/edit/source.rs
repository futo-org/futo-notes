//! Verify already-owned source pieces against their rendered physical ranges.
//! Equality validates lineage; it never searches for or discovers identities.
use crate::history::SourcePoint;
use std::ops::Range;

#[derive(Default)]
pub(crate) struct SourceCorrespondence {
    retained: Vec<(Range<usize>, Range<usize>)>,
}
impl SourceCorrespondence {
    pub(super) fn verify(
        raw: &str,
        output: &str,
        origins: Vec<(Range<usize>, Range<usize>)>,
        base: usize,
    ) -> (Self, usize) {
        let mut retained: Vec<(Range<usize>, Range<usize>)> = Vec::new();
        let mut work = 0;
        for (old, new) in origins {
            work += 1;
            let (Some(before), Some(after)) = (raw.get(old.clone()), output.get(new.clone()))
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
            work += 4;
            let old = base + old.start..base + old.end;
            let new = base + new.start..base + new.end;
            work += 1;
            if let Some((last_old, last_new)) = retained.last_mut() {
                if last_old.end == old.start && last_new.end == new.start {
                    last_old.end = old.end;
                    last_new.end = new.end;
                    continue;
                }
            }
            retained.push((old, new));
        }
        (Self { retained }, work)
    }

    pub(crate) fn map(&self, mut point: SourcePoint) -> (Option<SourcePoint>, usize) {
        let mut work = 0;
        let first = self.retained.partition_point(|(old, _)| {
            work += 1;
            old.end < point.source.0
        });
        for (old, new) in &self.retained[first..] {
            work += 1;
            if old.start > point.source.0 {
                break;
            }
            let end = point.source.0 + point.atom.map_or(0, |atom| atom.source_len);
            if point.source.0 <= old.end && end <= old.end {
                point.source.0 = new.start + point.source.0 - old.start;
                return (Some(point), work);
            }
        }
        (None, work)
    }
}
