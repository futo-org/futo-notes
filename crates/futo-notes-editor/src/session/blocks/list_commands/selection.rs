//! Validate header-lift endpoints in one actual-row preview before acceptance.
use super::*;
use std::ops::Range;

impl EditorSession {
    pub(super) fn preview_header_selection(
        &self,
        range: DisplayRange,
        footprint: Range<usize>,
        edits: &[(Range<usize>, String)],
        output: &str,
    ) -> Result<(DisplayRange, usize, usize), EditorError> {
        let points = [
            self.projection.retained_point(range.start.0)?,
            self.projection.retained_point(range.end.0)?,
        ];
        let mut bounds = footprint.clone();
        for point in points {
            crate::inline::visit_container();
            let extent = point.extent();
            bounds.start = bounds.start.min(extent.start);
            bounds.end = bounds.end.max(extent.end);
        }
        let (window, display) = self.projection.retained_point_window(bounds);
        let raw = self.source.byte_slice(window.clone()).to_string();
        let mut preview = self.stage_source(&raw, window.clone());
        let edit = preview.prepare_source(
            preview.revision(),
            SourceRange {
                start: SourceOffset(footprint.start - window.start),
                end: SourceOffset(footprint.end - window.start),
            },
            output,
        )?;
        // This private apply calls no host, clock or history operation.
        let work = preview.apply(&edit).work;
        let mut mapped = [0; 2];
        for (index, point) in points.into_iter().enumerate() {
            let shifted = point
                .through_edits(footprint.start, edits)?
                .relative(window.start)?;
            point.verify_raw(&self.source, shifted, &preview.source)?;
            mapped[index] = display + preview.projection.project_retained_point(shifted)?;
        }
        Ok((
            DisplayRange {
                start: DisplayOffset(mapped[0]),
                end: DisplayOffset(mapped[1]),
            },
            2 * raw.len() + work.parsed_source_bytes,
            raw.len() + output.len() + work.materialized_source_bytes,
        ))
    }
}
