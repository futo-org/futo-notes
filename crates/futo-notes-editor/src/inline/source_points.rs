//! Canonical source-atom capture and exact selection projection.
use super::*;

impl Projection {
    pub(crate) fn source_selection(
        &self,
        range: DisplayRange,
        affinity: crate::Affinity,
    ) -> (crate::history::ExactSelection, usize) {
        let endpoint = |offset: usize| {
            let (row, source, display) = self.rows.at(self.rows.locate(offset, true));
            let (mut point, work) = row.source_point_with_work(offset - display, affinity);
            point.source.0 += source;
            (point, work)
        };
        let (start, a) = endpoint(range.start.0);
        let (end, z) = if range.start == range.end {
            (start, 0)
        } else {
            endpoint(range.end.0)
        };
        (crate::history::ExactSelection { start, end }, a + z)
    }

    pub(crate) fn project_source_point(
        &self,
        mut point: crate::history::SourcePoint,
    ) -> (usize, usize) {
        let (row, source, display) = self.rows.at(self.rows.locate(point.source.0, false));
        point.source.0 -= source;
        let (local, work) = row.project_source_point(point);
        (display + local, work)
    }

    pub(crate) fn try_project_source_point(
        &self,
        mut point: crate::history::SourcePoint,
    ) -> (Option<usize>, usize) {
        let (row, source, display, visits) = self.rows.source_row_with_work(point.source.0);
        point.source.0 -= source;
        let (local, work) = row.try_project_source_point(point);
        (local.map(|local| display + local), work + visits)
    }
}
