//! One-pass span lookups over a row's segments, which arrive in source order.
use crate::inline::row::{Row, Span};
use std::ops::Range;

/// The spans enclosing each of a row's segments (opener ended at or before the
/// segment start, closer starting at or after its end), in span order. Segments
/// arrive in source order, so one sweep serves them all; an out-of-order query
/// falls back to a scan. `work` counts each span entered and each open span
/// checked (a scan counts every span).
pub(super) struct Enclosing<'a> {
    row: &'a Row,
    eligible: Vec<bool>,
    order: Vec<usize>,
    next: usize,
    open: Vec<usize>,
    last: usize,
}

impl<'a> Enclosing<'a> {
    pub(super) fn new(row: &'a Row, eligible: impl Fn(usize) -> bool) -> Self {
        let eligible: Vec<bool> = (0..row.spans.len()).map(eligible).collect();
        let mut order: Vec<usize> = (0..row.spans.len()).filter(|&i| eligible[i]).collect();
        order.sort_by_key(|&i| row.spans[i].open.end);
        Self {
            row,
            eligible,
            order,
            next: 0,
            open: Vec::new(),
            last: 0,
        }
    }

    pub(super) fn at(&mut self, segment: &Range<usize>, work: &mut usize) -> Vec<usize> {
        let spans = &self.row.spans;
        let encloses =
            |span: &Span| span.open.end <= segment.start && segment.end <= span.close.start;
        if segment.start < self.last {
            *work += spans.len();
            return (0..spans.len())
                .filter(|&i| self.eligible[i] && encloses(&spans[i]))
                .collect();
        }
        self.last = segment.start;
        while let Some(&index) = self.order.get(self.next) {
            if spans[index].open.end > segment.start {
                break;
            }
            self.open.push(index);
            self.next += 1;
            *work += 1;
        }
        *work += self.open.len();
        // A closer starting before this segment starts encloses no later one.
        self.open
            .retain(|&index| segment.start <= spans[index].close.start);
        let mut found: Vec<usize> = self
            .open
            .iter()
            .copied()
            .filter(|&index| encloses(&spans[index]))
            .collect();
        found.sort_unstable();
        found
    }
}

/// Whether a source range lies inside one span's opener or closer.
pub(super) struct MarkerRanges {
    /// Marker ranges by start, with the running maximum end.
    starts: Vec<usize>,
    reach: Vec<usize>,
}

impl MarkerRanges {
    pub(super) fn new(row: &Row) -> Self {
        let mut ranges: Vec<(usize, usize)> = row
            .spans
            .iter()
            .flat_map(|span| [&span.open, &span.close])
            .map(|range| (range.start, range.end))
            .collect();
        ranges.sort_unstable();
        let mut reach = Vec::with_capacity(ranges.len());
        let mut furthest = 0;
        for &(_, end) in &ranges {
            furthest = furthest.max(end);
            reach.push(furthest);
        }
        Self {
            starts: ranges.into_iter().map(|(start, _)| start).collect(),
            reach,
        }
    }

    /// `work`: one visit per lookup.
    pub(super) fn covers(&self, segment: &Range<usize>, work: &mut usize) -> bool {
        *work += 1;
        let count = self.starts.partition_point(|&start| start <= segment.start);
        count > 0 && segment.end <= self.reach[count - 1]
    }
}
