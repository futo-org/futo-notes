//! Canonical physical prefix boundaries for one bounded source context.
//! This index never grants word ownership or changes source correspondence.
use crate::inline::row::Row;
use std::ops::Range;

#[derive(Default)]
pub(super) struct PhysicalPrefixes {
    ranges: Vec<Range<usize>>,
}
impl PhysicalPrefixes {
    pub fn read(row: &Row, enabled: bool, work: &mut usize) -> Self {
        if !enabled {
            return Self::default();
        }
        let mut ranges: Vec<Range<usize>> = Vec::new();
        for block in &row.blocks {
            *work += 1;
            if block.code {
                continue;
            }
            for body in &block.bodies {
                *work += 1;
                if body.source.start < body.content.start {
                    *work += 2;
                    ranges.push(body.source.start..body.content.start);
                }
            }
        }
        // Nested canonical bodies may repeat or overlap a physical prefix.
        // Normalize those real ranges once, without cloning body metadata.
        ranges.sort_unstable_by(|a, b| {
            *work += 1;
            (a.start, a.end).cmp(&(b.start, b.end))
        });
        let mut count = 0;
        for index in 0..ranges.len() {
            *work += 3;
            let range = ranges[index].clone();
            if count > 0 && range.start <= ranges[count - 1].end {
                *work += 2;
                ranges[count - 1].end = ranges[count - 1].end.max(range.end);
            } else {
                *work += 2;
                ranges[count] = range;
                count += 1;
            }
        }
        ranges.truncate(count);
        Self { ranges }
    }

    pub fn contains(&self, range: &Range<usize>, work: &mut usize) -> bool {
        *work += 1;
        if range.is_empty() || self.ranges.is_empty() {
            return false;
        }
        let index = self.ranges.partition_point(|prefix| {
            *work += 1;
            prefix.end <= range.start
        });
        self.ranges.get(index).is_some_and(|prefix| {
            *work += 2;
            prefix.start <= range.start && range.end <= prefix.end
        })
    }
}
