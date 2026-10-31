//! Command-local source witnesses for a header-only selection preview.
//! A nonidentity atom always retains its complete raw extent; byte lengths
//! alone never establish identity or permit clipping an encoded atom.
use super::*;
use crate::EditorError;
use std::ops::Range;

#[derive(Clone, Copy)]
pub(crate) struct RetainedPoint {
    source: usize,
    atom: Option<(usize, usize)>, // Complete source/display byte lengths.
    within: usize,
}

impl RetainedPoint {
    pub fn extent(self) -> Range<usize> {
        self.source..self.source + self.atom.map_or(0, |atom| atom.0)
    }

    pub fn relative(self, base: usize) -> Result<Self, EditorError> {
        Ok(Self {
            source: self
                .source
                .checked_sub(base)
                .ok_or(EditorError::UnrepresentableFormat)?,
            ..self
        })
    }

    pub fn through_edits(
        self,
        base: usize,
        edits: &[(Range<usize>, String)],
    ) -> Result<Self, EditorError> {
        let mut shift = 0isize;
        for (range, text) in edits {
            visit_container();
            let start = base + range.start;
            let end = base + range.end;
            if end <= self.source {
                shift += text.len() as isize - range.len() as isize;
            } else if let Some((length, _)) = self.atom {
                if start < self.source + length {
                    return Err(EditorError::UnrepresentableFormat);
                }
            } else if start < self.source {
                return Err(EditorError::UnrepresentableFormat);
            }
        }
        Ok(Self {
            source: self
                .source
                .checked_add_signed(shift)
                .ok_or(EditorError::UnrepresentableFormat)?,
            ..self
        })
    }

    pub fn verify_raw(self, before: &Rope, mapped: Self, after: &Rope) -> Result<(), EditorError> {
        let Some((length, _)) = self.atom else {
            return Ok(());
        };
        if self.source + length > before.len_bytes() || mapped.source + length > after.len_bytes() {
            return Err(EditorError::UnrepresentableFormat);
        }
        let same = before
            .byte_slice(self.extent())
            .bytes()
            .zip(after.byte_slice(mapped.extent()).bytes())
            .all(|(a, b)| {
                visit_container();
                a == b
            });
        if same {
            Ok(())
        } else {
            Err(EditorError::UnrepresentableFormat)
        }
    }
}

impl Projection {
    /// Only the actual original rows containing the edit and its endpoint
    /// witnesses enter the preview. No preceding/following foreign row is added.
    pub fn retained_point_window(&self, source: Range<usize>) -> (Range<usize>, usize) {
        let first = self.rows.locate(source.start, false);
        let last = self
            .rows
            .locate(source.end.saturating_sub(1).max(source.start), false);
        let (_, start, display) = self.rows.at(first);
        let (row, end, _) = self.rows.at(last);
        (start..end + row.source_len, display)
    }

    pub fn retained_point(&self, display: usize) -> Result<RetainedPoint, EditorError> {
        let (row, source, base) = self.rows.at(self.rows.locate(display, true));
        let at = display - base;
        if !row.display.is_char_boundary(at) {
            return Err(EditorError::InvalidRange);
        }
        let first = row.segments.partition_point(|segment| {
            visit_correspondence(1);
            segment.display.end < at
        });
        for segment in &row.segments[first..] {
            visit_correspondence(1);
            if segment.display.start > at {
                break;
            }
            // Capture a complete nonidentity atom before any boundary bias.
            if !segment.identity && segment.display.start < at && at < segment.display.end {
                return Ok(RetainedPoint {
                    source: source + segment.source.start,
                    atom: Some((segment.source.len(), segment.display.len())),
                    within: at - segment.display.start,
                });
            }
        }
        Ok(RetainedPoint {
            source: source + row.source_bounds(at).1,
            atom: None,
            within: 0,
        })
    }

    pub fn project_retained_point(&self, point: RetainedPoint) -> Result<usize, EditorError> {
        let (row, source, display) = self.rows.at(self.rows.locate(point.source, false));
        let at = point.source - source;
        if at > row.source_len {
            return Err(EditorError::UnrepresentableFormat);
        }
        let first = row.segments.partition_point(|segment| {
            visit_correspondence(1);
            segment.source.end < at
        });
        for segment in &row.segments[first..] {
            visit_correspondence(1);
            if segment.source.start > at {
                break;
            }
            if let Some((source_len, display_len)) = point.atom {
                if !segment.identity
                    && segment.source.start == at
                    && segment.source.len() == source_len
                    && segment.display.len() == display_len
                    && point.within <= display_len
                    && row
                        .display
                        .is_char_boundary(segment.display.start + point.within)
                {
                    return Ok(display + segment.display.start + point.within);
                }
            } else if segment.source.start < at && at < segment.source.end {
                // Identity segments are scalar runs; no foreign raw interior
                // or newly encoded atom can stand for an ordinary boundary.
                return Err(EditorError::UnrepresentableFormat);
            }
        }
        if point.atom.is_some() {
            return Err(EditorError::UnrepresentableFormat);
        }
        Ok(display + row.display_at(at))
    }
}
